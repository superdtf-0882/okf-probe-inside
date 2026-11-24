#!/usr/bin/env node
'use strict';
// run.js -- the automatic rollback's script (OKF-TOGAF#270; plan 1322-CC, rulings 754-DT2 to
// 756-DT2). SOURCE OF RECORD; the probe target carries a copy in rollback/, with the library
// beside it in rollback/lib/.
//
//   node rollback/run.js check      read the public address until the deploy's verdict is settled
//   node rollback/run.js restore    put back the latest deployment that served and hasn't failed
//   node rollback/run.js --self-test
//
// It answers what tools/lib/rollback.js asks: the public page, the provider's record of what is
// serving and of its deployments, and GitHub's list of this workflow's own runs. Its inputs are
// the environment variables named in INPUTS and no other. The key is sent to the provider's API
// and nowhere else, and is never printed.
//
// How it can be crossed (RULE-10): whoever can push to the target's main branch can change this
// script or its workflow, which take effect before the target's deploy gate runs; the key
// reaches the rest of that one project; a run can be deleted, and the mark it kept with it.

const fs = require('fs');
const path = require('path');
const lib = (() => {
  for (const p of ['./lib/rollback.js', '../../lib/rollback.js']) {
    const f = path.join(__dirname, p);
    if (fs.existsSync(f)) return require(f);
  }
  throw new Error('the library is missing');
})();

const SITE = 'https://okf-probe.vercel.app';
const HOST = 'okf-probe.vercel.app';
const PROJECT = 'okf-probe';
const TEAM = 'superdtf-0882s-projects';
const TEXT = 'Throwaway target for the authority probe';
const WORKFLOW = 'auto-rollback.yml';
const BRANCH = 'main';
const OPTS = { workflow: WORKFLOW, branch: BRANCH, tries: 15, after: 6 };
const WAIT_MS = 20000;
const INPUTS = ['GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'ROLLBACK_KEY', 'EVENT_NAME', 'EVENT_SHA', 'EVENT_CONTEXT', 'EVENT_STATE', 'EVENT_CREATOR'];
const SHA = /^[0-9a-f]{40}$/;
const MARK = /^failed-[0-9a-f]{40}$/;

// --- what the answers are read into (pure) ---

// The public page and its health file, read into one reading.
function readingOf(page, health) {
  let h = null;
  try { h = health && health.status === 200 ? JSON.parse(health.body) : null; } catch (e) { h = null; }
  const commit = h && SHA.test(String(h.commit)) ? h.commit : null;
  return { commit, status: page ? page.status : 0, text: !!page && typeof page.body === 'string' && page.body.includes(TEXT), well: !!h && h.well === true };
}

// The provider's deployments, with the one the address serves. A deployment served only where the
// provider's record says so: promoted to production, or one it would roll back to. served is when
// its addresses were assigned; a rollback or promotion to it that succeeded, when it was the
// project's last request, moves it later.
function deploymentsOf(list, servingId, last) {
  if (!list || !Array.isArray(list.deployments) || !servingId) return null;
  return list.deployments.map((d) => {
    const sha = d.meta && d.meta.githubCommitSha;
    let served;
    if (d.readySubstate === 'PROMOTED' || d.isRollbackCandidate === true) served = typeof d.aliasAssigned === 'number' ? d.aliasAssigned : typeof d.created === 'number' ? d.created : undefined;
    if (last && last.jobStatus === 'succeeded' && last.toDeploymentId === d.uid && typeof last.requestedAt === 'number' && (served === undefined || last.requestedAt > served)) served = last.requestedAt;
    return { id: d.uid, commit: SHA.test(String(sha)) ? sha : null, serving: d.uid === servingId, served };
  });
}

// The kept files whose names are marks, each with its own run; null when the list doesn't hold
// them all, or a mark's run wasn't read. runById: a run's id to GitHub's record of it.
const isMark = (a) => a && MARK.test(String(a.name)) && a.expired !== true;
function filesOf(artifacts, runById, repository) {
  if (!artifacts || !Array.isArray(artifacts.artifacts) || artifacts.total_count > artifacts.artifacts.length) return null;
  const out = [];
  for (const a of artifacts.artifacts.filter(isMark)) {
    const r = a.workflow_run && runById.get(a.workflow_run.id);
    if (!r) return null;
    out.push({ name: a.name, expired: false, workflow: path.posix.basename(String(r.path).split('@')[0]), branch: r.head_branch,
      event: r.event, fork: !r.head_repository || r.head_repository.full_name !== repository });
  }
  return out;
}

// --- the network ---

async function get(url, headers, fetchFn) {
  try {
    const r = await fetchFn(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, body: '' }; }
}
async function json(url, headers, fetchFn) {
  const r = await get(url, headers, fetchFn);
  if (r.status !== 200) return null;
  try { return JSON.parse(r.body); } catch (e) { return null; }
}

// Every page of a list, in one; null when a page wasn't read, or there are more than ten.
async function all(getPage, field) {
  const items = [];
  for (let n = 1; n <= 10; n++) {
    const p = await getPage(n);
    if (!p || !Array.isArray(p[field])) return null;
    items.push(...p[field]);
    if (items.length >= p.total_count) return { total_count: p.total_count, [field]: items };
    if (!p[field].length) return null;
  }
  return null;
}

// The provider's code for a refusal, and none of its text: the target's run log is public.
function codeOf(body) {
  try { const c = JSON.parse(body).error.code; return typeof c === 'string' && /^[a-z0-9_-]{1,60}$/i.test(c) ? c : ''; } catch (e) { return ''; }
}

function answerer(env, fetchFn) {
  const key = env.ROLLBACK_KEY;
  const api = (p) => 'https://api.vercel.com' + p + (p.includes('?') ? '&' : '?') + 'slug=' + TEAM;
  const vh = { Authorization: 'Bearer ' + key };
  const vercel = (p) => (key ? json(api(p), vh, fetchFn) : null);
  const gh = (p) => json('https://api.github.com/repos/' + env.GITHUB_REPOSITORY + p, { Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json' }, fetchFn);
  const open = (u) => get(u + '?t=' + Date.now(), { 'Cache-Control': 'no-cache' }, fetchFn);
  const project = () => vercel('/v9/projects/' + PROJECT + '?rollbackInfo=true');
  const servingNow = async () => {
    const a = await vercel('/v4/aliases/' + HOST);
    if (!a || !a.deploymentId) return null;
    const d = await vercel('/v13/deployments/' + a.deploymentId);
    const sha = d && d.meta && d.meta.githubCommitSha;
    return { id: a.deploymentId, commit: SHA.test(String(sha)) ? sha : null };
  };
  return {
    wait: () => new Promise((r) => setTimeout(r, WAIT_MS)),
    page: async () => readingOf(await open(SITE + '/'), await open(SITE + '/health.json')),
    serving: async () => { const s = await servingNow(); return s ? s.commit : null; },
    deployments: async () => {
      const s = await servingNow();
      const p = await project();
      if (!s || !p || !p.id) return null;
      return deploymentsOf(await vercel('/v6/deployments?projectId=' + p.id + '&target=production&state=READY&limit=50'), s.id, p.lastAliasRequest);
    },
    marks: async () => {
      const list = await all((n) => gh('/actions/artifacts?per_page=100&page=' + n), 'artifacts');
      if (!list) return null;
      const runs = new Map();
      for (const a of list.artifacts.filter(isMark)) {
        const id = a.workflow_run && a.workflow_run.id;
        if (id && !runs.has(id)) { const r = await gh('/actions/runs/' + id); if (r) runs.set(id, r); }
      }
      return filesOf(list, runs, env.GITHUB_REPOSITORY);
    },
    restore: async (q) => {
      const p = await project();
      if (!p || !p.id) return { ok: false, why: 'the project could not be read with this key' };
      try {
        const r = await fetchFn(api('/v1/projects/' + p.id + '/rollback/' + q.id), { method: 'POST', headers: vh, redirect: 'manual', signal: AbortSignal.timeout(30000) });
        return r.ok ? { ok: true } : { ok: false, why: (String(r.status) + ' ' + codeOf(await r.text())).trim() };
      } catch (e) { return { ok: false, why: 'the call did not complete' }; }
    },
    onMain: async (sha) => { const c = await gh('/compare/' + BRANCH + '...' + sha); return !!c && (c.status === 'identical' || c.status === 'behind'); },
  };
}

async function drive(it, answers, log) {
  let r = it.next();
  while (!r.done) {
    const q = r.value, a = answers[q.ask] ? await answers[q.ask](q) : undefined;
    if (q.ask !== 'wait') log(q.ask + ': ' + (q.ask === 'marks' ? (a ? a.length + ' file(s)' : 'not read') : q.ask === 'deployments' ? (a ? a.length + ' listed' : 'not read') : JSON.stringify(a)));
    r = it.next(a);
  }
  return r.value;
}

async function main(mode) {
  const env = {};
  for (const n of INPUTS) env[n] = process.env[n];
  const a = answerer(env, fetch);
  const out = (k, v) => { if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, k + '=' + v + '\n'); };
  const say = (t) => { console.log(t); if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, t + '\n'); };
  let commit;
  if (env.EVENT_NAME === 'status') {
    commit = env.EVENT_SHA;
    const ev = { context: env.EVENT_CONTEXT, state: env.EVENT_STATE, creator: env.EVENT_CREATOR, sha: commit };
    if (!SHA.test(String(commit)) || !lib.acts(ev, await a.onMain(commit))) { say("Not the provider's success on a commit of main; nothing done."); return 0; }
  } else {
    commit = await a.serving();
    if (!SHA.test(String(commit))) { say('What is serving could not be read; nothing done.'); return 1; }
  }
  if (mode === 'check') {
    const c = await drive(lib.check(commit, OPTS), a, (t) => console.log(t));
    out('verdict', c.verdict.replace(/ /g, '-'));
    if (c.verdict === 'failed') { fs.mkdirSync('mark', { recursive: true }); fs.writeFileSync('mark/failed.txt', commit + '\n'); out('commit', commit); }
    say('Check of ' + commit.slice(0, 8) + ': ' + c.verdict + ', ' + c.readings + ' reading(s).');
    return c.verdict === 'healthy' ? 0 : c.verdict === 'failed' ? 0 : 1;
  }
  const p = await drive(lib.putBack(commit, OPTS), a, (t) => console.log(t));
  say(p.says);
  return 1;                          // a restore, done or not, always ends red
}

async function selfTest() {
  let bad = 0;
  const ok = (c, name, shown) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + name + (c || shown === undefined ? '' : '  -- ' + shown)); if (!c) bad = 1; };
  const J = JSON.stringify, A = 'a'.repeat(40), B = 'b'.repeat(40);
  console.log("--- the automatic rollback's script (OKF-TOGAF#270) ---");
  const page = { status: 200, body: '<p>' + TEXT + '</p>' };
  ok(J(readingOf(page, { status: 200, body: J({ commit: A, well: true }) })) === J({ commit: A, status: 200, text: true, well: true }), 'a good page is read with its commit');
  ok(J(readingOf(page, { status: 404, body: '' })) === J({ commit: null, status: 200, text: true, well: false }), 'a page with no health file names no commit and is not well');
  ok(readingOf(page, { status: 200, body: 'not json' }).commit === null && readingOf(page, { status: 200, body: J({ commit: 'main', well: true }) }).commit === null, "a health file that isn't one, or names no commit's id, names none");
  ok(readingOf({ status: 0, body: '' }, { status: 0, body: '' }).status === 0, 'a page that does not answer reads as 0');
  const list = { deployments: [{ uid: 'd3', meta: { githubCommitSha: B }, aliasAssigned: 30, readySubstate: 'PROMOTED' }, { uid: 'd2', meta: {}, aliasAssigned: false }, { uid: 'd1', meta: { githubCommitSha: A }, aliasAssigned: 10, readySubstate: 'PROMOTED' }] };
  ok(J(deploymentsOf(list, 'd3', null)) === J([{ id: 'd3', commit: B, serving: true, served: 30 }, { id: 'd2', commit: null, serving: false, served: undefined }, { id: 'd1', commit: A, serving: false, served: 10 }]), 'deployments are read with which serves and when each did');
  ok(deploymentsOf(list, 'd1', { toDeploymentId: 'd1', requestedAt: 40, jobStatus: 'succeeded' })[2].served === 40, "a rollback the project's last request made moves when its deployment served");
  ok(deploymentsOf(list, 'd1', { toDeploymentId: 'd1', requestedAt: 40, jobStatus: 'failed' })[2].served === 10 && deploymentsOf(list, 'd1', { toDeploymentId: 'd1', requestedAt: 40 })[2].served === 10, 'a request that failed, or says nothing, does not (757-DT2)');
  const staged = deploymentsOf({ deployments: [...list.deployments, { uid: 'd4', meta: { githubCommitSha: A }, aliasAssigned: 50, readySubstate: 'STAGED' }, { uid: 'd0', meta: { githubCommitSha: A }, aliasAssigned: 5, isRollbackCandidate: true }] }, 'd3', null);
  ok(staged[3].served === undefined && staged[4].served === 5, 'a staged deployment has not served, whatever its address; one the provider would roll back to has (757-DT2)', J(staged));
  ok(deploymentsOf(null, 'd1', null) === null && deploymentsOf(list, null, null) === null, 'deployments not read, or no serving one known, give no answer');
  const run7 = { id: 7, path: '.github/workflows/' + WORKFLOW, head_branch: 'main', event: 'status', head_repository: { full_name: 'o/r' } };
  const arts = { total_count: 1, artifacts: [{ name: 'failed-' + A, expired: false, workflow_run: { id: 7 } }] };
  const marksOf = (x, rs) => J(lib.failedMarks(filesOf(x, new Map(rs.map((r) => [r.id, r])), 'o/r'), OPTS));
  ok(marksOf(arts, [run7]) === J([A]), "a mark is read from this workflow's own run on main");
  ok(marksOf(arts, [{ ...run7, head_repository: { full_name: 'x/r' } }]) === '[]' && marksOf(arts, [{ ...run7, path: '.github/workflows/other.yml' }]) === '[]', "a fork's run, or a run of another workflow, gives no mark");
  ok(filesOf({ ...arts, total_count: 2 }, new Map([[7, run7]]), 'o/r') === null && filesOf(null, new Map(), 'o/r') === null, 'a list that does not hold them all, or was not read, gives no answer');
  ok(filesOf(arts, new Map(), 'o/r') === null, "a mark's name whose run was not read gives no answer (757-DT2)");
  ok(J(filesOf({ total_count: 1, artifacts: [{ name: 'log', workflow_run: { id: 9 } }] }, new Map(), 'o/r')) === '[]', "a file whose name isn't a mark's needs no run read (757-DT2)");

  // The answers, with the network made up.
  const calls = [];
  const reply = (u) => u.includes('/rollback/') ? { status: 201, b: '' } : u.includes('/v9/projects/') ? { status: 200, b: J({ id: 'prj_1', lastAliasRequest: null }) }
    : u.includes('/v4/aliases/') ? { status: 200, b: J({ deploymentId: 'd3' }) } : u.includes('/v13/deployments/') ? { status: 200, b: J({ meta: { githubCommitSha: B } }) }
      : u.includes('/v6/deployments') ? { status: 200, b: J(list) } : u.includes('/actions/artifacts') ? { status: 200, b: J(arts) } : u.includes('/actions/runs/7') ? { status: 200, b: J(run7) }
        : u.includes('/compare/') ? { status: 200, b: J({ status: 'behind' }) } : u.includes('/health.json') ? { status: 200, b: J({ commit: A, well: true }) } : { status: 200, b: page.body };
  const fake = async (u, o) => { calls.push({ u, o: o || {} }); const r = reply(u); return { status: r.status, ok: r.status < 300, text: async () => r.b }; };
  const an = answerer({ GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'made-up-token', ROLLBACK_KEY: 'made-up-key' }, fake);
  const deps = await an.deployments();
  ok(Array.isArray(deps) && deps[0].serving === true && calls.some((c) => /\/v9\/projects\/okf-probe\?rollbackInfo=true/.test(c.u)), "the project's last rollback is asked for (757-DT2)", calls.map((c) => c.u).join(' '));
  const rr = await an.restore({ id: 'd1' });
  const post = calls.find((c) => c.o.method === 'POST');
  ok(rr.ok === true && post && /\/v1\/projects\/prj_1\/rollback\/d1\?slug=/.test(post.u) && post.o.redirect === 'manual', 'the restore call follows no redirect (757-DT2)', post && post.o.redirect);
  // [762-DT2: the target's run log is public; a refusal gives the status and the provider's code, not its text.]
  const said = async (status, b) => (await answerer({ ROLLBACK_KEY: 'made-up-key' }, async (u) => (u.includes('/rollback/') ? { status, ok: false, text: async () => b } : fake(u))).restore({ id: 'd1' })).why;
  const no402 = await said(402, J({ error: { code: 'payment_required', message: 'a message, with team_1 in it' } })), noise = await said(500, '<html>an answer that is not JSON</html>'), odd = await said(403, J({ error: { code: 'a code with words in it' } }));
  ok(no402 === '402 payment_required' && noise === '500' && odd === '403', "a refused restore says the provider's status and code, and none of its text (762-DT2)", J([no402, noise, odd]));
  ok(J(lib.failedMarks(await an.marks(), OPTS)) === J([A]) && !calls.some((c) => /\/workflows\//.test(c.u)), 'marks are read by their own runs, with no list of runs (757-DT2)');
  await an.page(); await an.serving(); await an.onMain(A);
  const holds = (c, k) => J(c.o.headers || {}).includes(k) || c.u.includes(k);
  ok(calls.some((c) => holds(c, 'made-up-key')) && calls.some((c) => holds(c, 'made-up-token')) && calls.filter((c) => holds(c, 'made-up-key')).every((c) => c.u.startsWith('https://api.vercel.com/')) && calls.filter((c) => holds(c, 'made-up-token')).every((c) => c.u.startsWith('https://api.github.com/')) && calls.every((c) => !c.u.includes('made-up')),
    "the key goes to the provider's API alone, the token to GitHub's, and neither into an address");

  // The workflow beside the script, where it is.
  const yml = ['./auto-rollback.yml', '../.github/workflows/auto-rollback.yml'].map((f) => path.join(__dirname, f)).find((f) => fs.existsSync(f));
  const y = yml ? fs.readFileSync(yml, 'utf8').replace(/\r/g, '') : '';
  const steps = y.split(/\n      - /).slice(1);
  const withKey = steps.filter((x) => /secrets\.ROLLBACK_KEY/.test(x));
  ok(y && (y.match(/secrets\.ROLLBACK_KEY/g) || []).length === 2 && withKey.length === 2 && withKey.every((x) => /run: node rollback\/run\.js /.test(x)) && (y.match(/github\.token/g) || []).length === 2,
    'the key and the token are set on the two script steps alone (757-DT2)');
  ok(/\nconcurrency:\n  group: auto-rollback\n  queue: max\n/.test(y) && !/cancel-in-progress: true/.test(y), 'a waiting check is kept, not cancelled by a later event (757-DT2)');
  return bad;
}

module.exports = { readingOf, deploymentsOf, filesOf, selfTest };
if (require.main === module) {
  const mode = process.argv[2];
  if (mode === '--self-test') { selfTest().then((c) => process.exit(c), (e) => { console.log('FAIL  ' + e.stack); process.exit(1); }); return; }
  if (mode !== 'check' && mode !== 'restore') { console.log('Usage: node run.js check | restore | --self-test'); process.exit(1); }
  main(mode).then((c) => process.exit(c), (e) => { console.log('The script broke: ' + e.message); process.exit(1); });
}
