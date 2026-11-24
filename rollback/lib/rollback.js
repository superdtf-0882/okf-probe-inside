'use strict';
// rollback.js -- the decisions of the automatic rollback (OKF-TOGAF#270; plan 1322-CC, rulings
// 754-DT2 and 755-DT2, conditions taken in by 1324-CC and 1325-CC, note 756-DT2).
//
// After a deploy of the probe target, a workflow reads what the public address serves. Three
// failed readings in a row of the new deploy make it failed; one good one makes it healthy; a
// deploy that never shows, or is replaced, is neither. On a failure the deployment put back is
// the latest that served and hasn't failed the check. Nothing is restored when unsure.
//
// Pure: no network, no file, no environment, no clock. The workflow's script answers what
// flow() asks for. A deployment is { id, commit, serving, served, failed }: serving means
// serving now; served orders when each last began to serve, the larger the later, and a
// deployment without it never served; failed is the check's own recorded verdict.

//
// How this can be crossed (RULE-10): a break the three readings don't see stays live; a mark is
// lost with the run that kept it; whoever can push to the target's main branch can change what
// asks these questions. A page in front of a stale copy can look like a deploy that never shows.

const ROW = 3;
const SHA = /^[0-9a-f]{40}$/;
const MARK = /^failed-([0-9a-f]{40})$/;
const PROVIDER = { context: 'Vercel', creator: 'vercel[bot]' };

// One reading of the public address: { commit, status, text, well, serving }. commit is what the
// health file names, null when the page gave none; serving is what the provider says is serving,
// asked only then.
const isGood = (r) => r.status === 200 && r.text === true && r.well === true;

function verdict(commit, readings) {
  let shown = false, row = 0;
  for (const r of readings) {
    const of = r.commit || r.serving || null;
    if (of === commit) {
      shown = true;
      if (r.commit && isGood(r)) return 'healthy';
      if (++row === ROW) return 'failed';
    } else if (of === null) {
      row = 0;                       // nothing known: not a failed reading, and it breaks the row
    } else {
      if (shown) return 'replaced';
      row = 0;
    }
  }
  return shown ? 'undecided' : 'not shown';
}

// The deployment put back: the latest that served and hasn't failed, when the failed one is
// serving now. Another deployment of the failed commit isn't put back, nor one with no known commit.
function priorOf(commit, deployments) {
  if (!Array.isArray(deployments) || !deployments.some((d) => d.serving && d.commit === commit)) return null;
  const can = deployments.filter((d) => !d.serving && !d.failed && d.commit && d.commit !== commit && typeof d.served === 'number');
  can.sort((a, b) => b.served - a.served);
  return can.length ? can[0].id : null;
}

// The commits the check has failed, from the files its own runs on main kept. null when the runs
// couldn't be read. A file another branch, another workflow, a fork or another kind of event
// kept is no mark, whatever its name.
function failedMarks(files, opts) {
  if (!Array.isArray(files)) return null;
  const out = [];
  for (const f of files) {
    if (!f || f.workflow !== opts.workflow || f.branch !== opts.branch || f.fork === true || f.expired === true) continue;
    if (f.event !== 'status' && f.event !== 'workflow_dispatch') continue;
    const m = MARK.exec(String(f.name));
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// Whether a status event acts: the provider's success on a commit of the main branch.
function acts(event, onMain) {
  return !!event && event.context === PROVIDER.context && event.creator === PROVIDER.creator && event.state === 'success' &&
    SHA.test(String(event.sha)) && onMain === true;
}

const PROMOTE = 'New pushes stay off the public address until one is promoted.';

// Reading until the verdict is settled. Asks: page, serving (when the page named no commit), wait.
function* check(commit, opts) {
  const readings = [];
  let unshown = 0, v = 'not shown';
  while (unshown < opts.tries && readings.length < opts.tries + 12) {
    if (readings.length) yield { ask: 'wait' };
    const r = { ...((yield { ask: 'page' }) || { commit: null, status: 0 }) };
    if (!r.commit) r.serving = (yield { ask: 'serving' }) || null;
    readings.push(r);
    v = verdict(commit, readings);
    if (v === 'healthy' || v === 'failed' || v === 'replaced') break;
    if (v === 'not shown') unshown++;
  }
  return { verdict: v, readings: readings.length };
}

// Putting back. Asks: marks, deployments, serving (right before the call), restore, then page.
function* putBack(commit, opts) {
  const no = (says) => ({ restored: null, red: true, says });
  const failed = failedMarks(yield { ask: 'marks' }, opts);
  if (failed === null) return no('The record of failed checks could not be read, so nothing was put back.');
  const deployments = yield { ask: 'deployments' };
  if (!Array.isArray(deployments)) return no("The provider's deployments could not be read, so nothing was put back.");
  const id = priorOf(commit, deployments.map((d) => ({ ...d, failed: d.failed === true || failed.includes(d.commit) })));
  if (!id) return no('No deployment that served and has not failed could be put back.');
  const prior = deployments.find((d) => d.id === id);
  if ((yield { ask: 'serving' }) !== commit) return no('The failed deployment no longer serves, so nothing was put back.');
  const r = yield { ask: 'restore', id };
  if (!r || r.ok !== true) return no('The provider did not put it back: ' + String((r && r.why) || 'no answer') + '. The failed deployment may still be serving.');
  let after = 'not healthy';
  for (let i = 0; i < opts.after; i++) {
    yield { ask: 'wait' };
    const p = (yield { ask: 'page' }) || {};
    if (p.commit === prior.commit && isGood(p)) { after = 'healthy'; break; }
  }
  return { restored: id, after, red: true,
    says: 'Put back ' + id + ' (' + String(prior.commit).slice(0, 8) + '); its page reads ' + after + '. ' + PROMOTE };
}

// The whole, as the workflow's steps run it: check, keep the mark, put back.
function* flow(commit, opts) {
  const c = yield* check(commit, opts);
  if (c.verdict === 'healthy') return { ...c, restored: null, red: false, says: 'The deploy is healthy.' };
  if (c.verdict !== 'failed') return { ...c, restored: null, red: true, says: 'The deploy was not checked (' + c.verdict + '); nothing was put back.' };
  yield { ask: 'mark', commit };
  return { ...c, ...(yield* putBack(commit, opts)) };
}

function selfTest() {
  let bad = 0;
  const ok = (c, name, shown) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + name + (c || shown === undefined ? '' : '  -- ' + shown)); if (!c) bad = 1; };
  const api = module.exports;
  const call = (n, ...a) => { try { return typeof api[n] === 'function' ? api[n](...a) : undefined; } catch (e) { return { thrown: e.message }; } };
  const J = (x) => JSON.stringify(x);
  console.log('--- the automatic rollback (OKF-TOGAF#270) ---');

  const sha = (c) => c.repeat(40);
  const NEW = sha('f'), OLD = sha('a'), BAD = sha('b');
  const good = { commit: NEW, status: 200, text: true, well: true };
  const down = { commit: NEW, status: 500 };
  const old = { commit: OLD, status: 200, text: true, well: true };

  // 1. The verdict.
  ok(call('verdict', NEW, [old, down, down, down]) === 'failed', 'three failed readings in a row of the new deploy make it failed');
  ok(call('verdict', NEW, [old, down, down, good]) === 'healthy', 'one good reading makes it healthy');
  ok(call('verdict', NEW, [old, old, old]) === 'not shown', 'a deploy that never shows is neither', J(call('verdict', NEW, [old, old, old])));
  ok(call('verdict', NEW, [old, down, down]) === 'undecided', 'two failed readings decide nothing yet');
  ok(call('verdict', NEW, [down, down, { ...old, commit: BAD }]) === 'replaced', 'a deploy replaced while it is read is neither');
  ok(call('verdict', NEW, [{ ...good, well: false }, { ...good, well: false }, { ...good, well: false }]) === 'failed', 'a page that answers while its health file says it is not well is a failed reading');
  ok(call('verdict', NEW, [{ ...good, text: false }, { ...good, text: false }, { ...good, text: false }]) === 'failed', 'a page without its known text is a failed reading');
  const dark = { commit: null, status: 0 };
  ok(call('verdict', NEW, [{ ...dark, serving: NEW }, { ...dark, serving: NEW }, { ...dark, serving: NEW }]) === 'failed',
    'a page that stops answering counts against the deploy the provider says is serving');
  ok(call('verdict', NEW, [{ ...dark, serving: OLD }, { ...dark, serving: OLD }, { ...dark, serving: OLD }]) === 'not shown' && call('verdict', NEW, [dark, dark, dark]) === 'not shown',
    'an unreachable page with another deployment serving, or an unknown one, is not a failed check');

  ok(call('verdict', NEW, [down, down, dark, down]) === 'undecided', 'a reading with nothing known breaks the row of failed readings (757-DT2)', J(call('verdict', NEW, [down, down, dark, down])));

  // 2. The deployment put back.
  const list = [{ id: 'F', commit: NEW, serving: true, served: 4 }, { id: 'B', commit: BAD, served: 3, failed: true }, { id: 'E', commit: sha('e'), served: 1 }, { id: 'G', commit: OLD, served: 2 }];
  ok(call('priorOf', NEW, list) === 'G', 'the latest that served and has not failed is put back, not the failed one nor the older one', J(call('priorOf', NEW, list)));
  ok(call('priorOf', NEW, [{ id: 'F', commit: NEW, serving: true, served: 4 }, { id: 'B', commit: BAD, served: 2, failed: true }, { id: 'G', commit: OLD, served: 3 }]) === 'G',
    'after G is put back for B, F failing puts back G (754-DT2)');
  ok(call('priorOf', NEW, [{ id: 'F', commit: NEW, served: 4 }, { id: 'G', commit: OLD, serving: true, served: 5 }]) === null, 'nothing is put back when the failed one no longer serves');
  ok(call('priorOf', NEW, [{ id: 'F', commit: NEW, serving: true, served: 4 }, { id: 'P', commit: BAD }]) === null, 'a deployment that never served is not put back');
  ok(call('priorOf', NEW, [{ id: 'F', commit: NEW, serving: true, served: 4 }, { id: 'F2', commit: NEW, served: 3 }]) === null, 'another deployment of the failed commit is not put back');

  ok(call('priorOf', NEW, [{ id: 'F', commit: NEW, serving: true, served: 4 }, { id: 'U', commit: null, served: 3 }, { id: 'G', commit: OLD, served: 2 }]) === 'G', 'a deployment with no known commit is not put back (757-DT2)');

  // 3. The failed marks.
  const mark = (o) => ({ name: 'failed-' + BAD, workflow: 'auto-rollback', branch: 'main', event: 'status', expired: false, ...o });
  const marks = (xs) => { const r = call('failedMarks', xs, { workflow: 'auto-rollback', branch: 'main' }); return Array.isArray(r) ? r.join() : J(r); };
  ok(marks([mark()]) === BAD, 'a mark names the commit the check failed', marks([mark()]));
  ok(marks([mark({ branch: 'codex-probe-b' }), mark({ workflow: 'other' })]) === '', 'a file of the same name from another branch or workflow is no mark (756-DT2)');
  ok(marks([mark({ fork: true }), mark({ event: 'pull_request' }), mark({ expired: true })]) === '', "a file from a fork whose branch is named main, from a pull request, or expired, is no mark");
  ok(marks([mark({ name: 'failed-main' }), mark({ name: 'failed-' + BAD + 'x' }), mark({ name: 'verdict' })]) === '', "a name that isn't a commit's id is no mark");
  ok(call('failedMarks', null, { workflow: 'auto-rollback', branch: 'main' }) === null, 'runs that could not be read give no answer, not an empty one');

  // 4. Which events act.
  const ev = (o) => ({ context: 'Vercel', state: 'success', creator: 'vercel[bot]', sha: NEW, ...o });
  ok(call('acts', ev(), true) === true, "the provider's success on a commit of main acts");
  ok([ev({ creator: 'someone' }), ev({ context: 'ci' }), ev({ state: 'pending' }), ev({ sha: 'abc; rm' })].every((e) => call('acts', e, true) === false) && call('acts', ev(), false) === false,
    "another's status, another state, a name that isn't a commit's id, or a commit off main does not act");

  // 5. The flow, its questions answered one at a time.
  // answers: { page: [...], serving: [...], deployments, marks, restore }
  const drive = (answers) => {
    const asked = [];
    const page = [...(answers.page || [])], serving = [...(answers.serving || [])];
    const it = call('flow', NEW, { workflow: 'auto-rollback', branch: 'main', tries: 6, after: 3 });
    if (!it || typeof it.next !== 'function') return { asked, result: it };
    let r = it.next(), n = 0;
    while (!r.done && n++ < 60) {
      const q = r.value;
      asked.push(q.ask);
      const a = q.ask === 'page' ? (page.length > 1 ? page.shift() : page[0])
        : q.ask === 'serving' ? (serving.length > 1 ? serving.shift() : serving[0])
          : q.ask === 'deployments' ? answers.deployments
            : q.ask === 'marks' ? answers.marks
              : q.ask === 'restore' ? (answers.restoreAsked = q.id, answers.restore)
                : q.ask === 'mark' ? (answers.marked = q.commit, true) : undefined;
      r = it.next(a);
    }
    return { asked, result: r.done ? r.value : { unfinished: true }, answers };
  };
  const deps = [{ id: 'F', commit: NEW, serving: true, served: 4 }, { id: 'G', commit: OLD, served: 2 }, { id: 'B', commit: BAD, served: 3 }];
  let d = drive({ page: [old, good] });
  ok(d.result && d.result.verdict === 'healthy' && d.result.red === false && !d.asked.includes('restore'), 'a healthy deploy restores nothing and ends green', J(d.result));
  d = drive({ page: [old] });
  ok(d.result && d.result.verdict === 'not shown' && d.result.red === true && !d.asked.includes('restore'), 'a deploy that never shows restores nothing and ends red', J(d.result));
  d = drive({ page: [down, down, down, { ...old }], serving: [NEW], deployments: deps, marks: [mark()], restore: { ok: true } });
  ok(d.result && d.result.verdict === 'failed' && d.answers.restoreAsked === 'G' && d.answers.marked === NEW && d.result.restored === 'G' && d.result.red === true && d.result.after === 'healthy',
    'a failed deploy is marked, the latest unfailed one put back and read again, and the run ends red', J(d.result));
  ok(d.asked.indexOf('mark') >= 0 && d.asked.indexOf('mark') < d.asked.indexOf('restore') && d.asked.lastIndexOf('serving') < d.asked.indexOf('restore') && d.asked[d.asked.indexOf('restore') - 1] === 'serving',
    'the mark is recorded first, and what serves is read again right before the restore', d.asked.join(' '));
  d = drive({ page: [down], serving: [OLD], deployments: deps, marks: [], restore: { ok: true } });
  ok(d.result && d.result.verdict === 'failed' && d.result.restored === null && !d.asked.includes('restore'), 'a failed one no longer serving right before the call is left alone', J(d.result));
  d = drive({ page: [down], serving: [NEW], deployments: deps, marks: null, restore: { ok: true } });
  ok(d.result && d.result.restored === null && d.result.red === true && !d.asked.includes('restore'), 'marks that cannot be read restore nothing and end red', J(d.result));
  d = drive({ page: [down], serving: [NEW], deployments: deps, marks: [], restore: { ok: false, why: '402' } });
  ok(d.result && d.result.restored === null && d.result.red === true && /402/.test(d.result.says || ''), "a refused restore ends red with the provider's answer", J(d.result));
  d = drive({ page: [down], serving: [NEW], deployments: null, marks: [], restore: { ok: true } });
  ok(d.result && d.result.restored === null && d.result.red === true && !d.asked.includes('restore'), 'deployments that cannot be read restore nothing and end red', J(d.result));
  d = drive({ page: [down, down, down, down], serving: [NEW], deployments: deps, marks: [mark()], restore: { ok: true } });
  ok(d.result && d.result.restored === 'G' && d.result.after !== 'healthy' && d.result.red === true && d.asked.filter((x) => x === 'restore').length === 1,
    'a restore whose page is still failing is said so, and no second restore is tried', J(d.result));
  d = drive({ page: [down, down, down, { ...old }], serving: [NEW], deployments: deps, marks: [mark()], restore: { ok: true } });
  ok(d.result && /promote/.test(d.result.says || ''), 'the report of a restore says new pushes wait until one is promoted', J(d.result && d.result.says));

  return bad;
}

module.exports = { verdict, priorOf, failedMarks, acts, check, putBack, flow, selfTest };
if (require.main === module) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 1 : 0);
  console.log('Usage: node tools/lib/rollback.js --self-test');
  process.exit(1);
}
