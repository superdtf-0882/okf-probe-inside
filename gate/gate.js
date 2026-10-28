#!/usr/bin/env node
// The deploy gate (OKF-TOGAF#219, piece 4 of 568-CC, as 577-CC, 583-CC and
// 281-DT2 set it out), on the owner's lines "For piece 4: the gate may also
// read the commit's own id and the build's copy of its history, with no
// network call and no other variable; ..." and "Routine changes ship once
// DT2's review clears the commit that ships; ... -- David Facer 10/20/2026".
//
// On every build, in order: the commit names DT2's clearance (Cleared-By) and
// the tree that ships is the tree cleared; the clearance's base is in the
// build's history, or the gate refuses, since it cannot list what changed; and
// every file changed from that base is permitted to CC by the authority rows,
// asked of the join evaluator, a file your line excludes passing only with an
// Owner-Line, a forbidden one never.
//
// And for a commit that carries an act (OKF-TOGAF#234 piece 4, 368-DT2 with
// 742-CC's corrections): the act's request, its fingerprint, the shipped
// content and the actor it claims, decided against gate/world.json as it
// ships, so a grant withdrawn before the build is used; see actCheck below.
//
// It reads one variable by name, the commit's id, and runs git on the build's
// own checkout. It makes no network call and lists no environment. The rows
// are a copy, gate/store.json, with the corpus revision it was taken at; the
// libraries in gate/lib/ are copies of the corpus's tools/lib/, recorded in
// gate/lib/COPIED.json.
//
// HOW IT CAN BE CROSSED (RULE-10): a commit can change this folder, which is
// why the folder is in the plane class and needs the owner's line; a push that
// skips the build, or a rule outside the build, is piece 7's (GitHub's branch
// rule); who wrote a clearance is checked when CC files, not here (579-CC).
// SET TO "record" (config.json's mode) it refuses nothing, so while so set it
// is a recorder, not a control: the setting lives in this folder, in the plane
// class; a missing or garbled setting reads as "refuse"; and CC's filing
// reports a site decision made in refuse mode as a departure (308-DT2).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const clearance = require('./lib/clearance');
const { facts } = require('./lib/authority-facts');
const { evaluate } = require('./lib/authority-join');
const { matches } = require('./lib/authority');
const ar = require('./lib/act-request');

const SEP = '\u0001';

// A surface's path against a changed file is the corpus's own matching,
// tools/lib/authority.js's matches(), copied here with the other libraries, so
// the gate and the evaluator answer one question one way (282-DT2).

// The build's wiring (283-DT2 section 1): what decides whether the gate runs
// and whether its refusal stops the build. A change to any of it needs
// Owner-Line. Wiring that stops the gate or ignores it is past any gate; the
// filing act's rebuild records it as "gate not run" (AUTH-NOTMED-GATE-WIRING).
const WIRING = { 'package.json': (j) => ({ build: j && j.scripts ? j.scripts.build : undefined, prebuild: j && j.scripts ? j.scripts.prebuild : undefined }),
  'vercel.json': (j) => ({ buildCommand: j ? j.buildCommand : undefined, installCommand: j ? j.installCommand : undefined, framework: j ? j.framework : undefined }) };
function wiringChanges(changed, base, sha, fileAt) {
  const out = [];
  for (const f of Object.keys(WIRING).filter((x) => changed.includes(x))) {
    if (typeof fileAt !== 'function') { out.push(`${f} changed, and the gate cannot read it at a commit`); continue; }
    let before, after;
    try { const b = fileAt(base, f), a = fileAt(sha, f); before = WIRING[f](b === null ? null : JSON.parse(b)); after = WIRING[f](a === null ? null : JSON.parse(a)); }
    catch (e) { out.push(`${f} could not be read as JSON`); continue; }
    for (const k of Object.keys(before)) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(`${f}'s ${k} changed`);
  }
  return out;
}

// The decision for one commit, from what the build read. Pure: the same input
// gives the same record, so the filing act can rebuild it from the commit.
function decide(input) {
  const out = { gate: 'authority gate, piece 4', commit: input.sha, store_revision: input.store ? input.store.revision : null, cleared_by: null, owner_line: null, files: null, outcome: null, refusals: [] };
  const refuse = (rule, detail) => out.refusals.push({ rule, detail });
  const done = () => { out.outcome = out.refusals.length ? 'refused' : 'allowed'; return out; };

  if (input.varSha && input.varSha !== input.sha) refuse('commit', 'the commit the hosting names is not the one checked out');
  const store = input.store;
  if (!store || !Array.isArray(store.rows) || !store.actor || !store.action || !store.repository) { refuse('rows', 'no readable copy of the authority rows'); return done(); }

  const c = clearance.clearedBy(input.message);
  const o = clearance.ownerLine(input.message);
  if (c && !c.malformed) out.cleared_by = c.review;
  if (o === false) refuse('owner-line', 'more than one Owner-Line');
  else if (o) out.owner_line = o;
  for (const why of clearance.gateRefusals(c, { tree: input.tree, hasBase: input.isAncestor, ownerLine: o || null })) refuse('clearance', why);
  if (!c || c.malformed || !input.isAncestor(c.base)) return done();

  const changed = input.changed(c.base);
  if (!Array.isArray(changed)) { refuse('files', 'the changed files could not be listed'); return done(); }
  out.files = changed.length;
  for (const w of wiringChanges(changed, c.base, input.sha, input.fileAt)) if (!o || /cannot read|could not be read/.test(w)) refuse('wiring', o ? w : w + '; it needs Owner-Line');

  // The pusher's check asks the join alone: the einsum evaluator takes about
  // ninety seconds on these rows, against milliseconds on the mock world,
  // where the act's check asks both (lib/act-request.js; 373-DT2, 751-CC).
  let rel;
  try { rel = evaluate(store.rows.filter((x) => x.relation === 'Rule'), facts(store.rows).relations); }
  catch (e) { refuse('rows', 'the evaluator could not read the rows: ' + e.message); return done(); }
  const has = (name, ...xs) => !!rel[name] && rel[name].has(xs.join(SEP));
  const a = store.actor, k = store.action, R = store.repository;
  const lines = store.rows.filter((x) => x.relation === 'Line' && x.given_to === a).map((x) => x.id);

  if (!has('Permitted', a, k, R)) {
    refuse(has('Barred', a, k, R) ? 'forbidden' : 'not-granted', `${R} is not permitted to ${a} for ${k}`);
    return done();
  }
  const within = store.rows.filter((x) => x.relation === 'Surface' && x.path && has('Within', x.id, R));
  // One refusal per file, by its strongest reason: a file under two surfaces
  // the line excludes is excluded once, and one also forbidden is forbidden
  // (282-DT2's check on the record).
  const RANK = { forbidden: 3, 'not-granted': 2, excluded: 1 };
  for (const f of changed) {
    let worst = null;
    for (const s of within.filter((x) => matches(x.path, f))) {
      if (has('Permitted', a, k, s.id)) continue;
      const why = has('Barred', a, k, s.id) ? { rule: 'forbidden', detail: `${f} is in ${s.id}, which no line overrides` }
        : lines.some((l) => has('Excluded', l, s.id)) ? (o ? null : { rule: 'excluded', detail: `${f} is in ${s.id}, which the line excludes; it needs Owner-Line` })
        : { rule: 'not-granted', detail: `${f} is in ${s.id}, which nothing grants` };
      if (why && (!worst || RANK[why.rule] > RANK[worst.rule])) worst = why;
    }
    if (worst) refuse(worst.rule, worst.detail);
  }
  actCheck(input, store, changed, refuse, out, c.base);
  return done();
}

// ------------------------------------------------------------- the act (OKF-TOGAF#234 piece 4)
// A commit that carries an act names its request file and fingerprint
// (Request:) and the actor it claims (Actor:). The gate reads the request and
// the world as they ship, binds the shipped content to the fingerprint, decides
// the act with lib/act-request.js (both evaluators) and holds the act's files
// to the request: the request file and the request's path, nothing else, so no
// act changes the world that grants it. A commit with no Request line is
// decided as before, with no act record.
const REQUEST = /^Request:[ \t]+(\S+)[ \t]+([0-9a-f]{64}|\S+)[ \t]*$/;
const ACTOR = /^Actor:[ \t]+(\S+)[ \t]*$/;
const REQUEST_FILE = /^requests\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/;
const IDENTITY = 'none: no platform-established pushing identity is available to the build; the Actor line is the commit\'s claim';
function lineOf(message, re) { const m = String(message || '').split(/\r?\n/).map((l) => re.exec(l)).filter(Boolean); return m.length === 1 ? m[0] : m.length ? false : null; }

function actCheck(input, store, changed, refuse, out, base) {
  const rq = lineOf(input.message, REQUEST);
  // A change inside a mock surface's folder is an act, request or none
  // (376-DT2). The folders are those of the world as it ships and of the world
  // at the clearance's base, together (377-DT2), so removing, emptying or
  // renaming them in the same commit doesn't remove the check.
  let baseWorld = null;
  try { baseWorld = typeof input.fileAt === 'function' ? JSON.parse(input.fileAt(base, 'gate/world.json')) : null; } catch (e) { baseWorld = null; }
  const folders = (w) => (w && Array.isArray(w.rows) ? w.rows.filter((x) => x.relation === 'Surface' && typeof x.path === 'string' && x.path).map((x) => x.path) : []);
  const mockPaths = [...new Set(folders(input.world).concat(folders(baseWorld)))];
  const inMock = changed.filter((f) => mockPaths.some((m) => matches(m, f)));
  if (rq === null && !inMock.length) return;
  const ac = lineOf(input.message, ACTOR);
  const act = out.act = { condition: null, why: null, operator: null, actor_claimed: ac ? ac[1] : null, identity: IDENTITY, request: rq ? rq[1] : null, fingerprint: null, rows: [], requires: [], bound: null, evaluated: null, evaluated_is: 'the request\'s own statement, outside the fingerprint', detail: '' };
  const fail = (rule, detail, why) => { act.condition = act.condition || rule; act.why = act.why || why || null; act.detail = act.detail || detail; refuse(rule, detail); };
  if (rq === null) return fail('unactionable', `${inMock.join(', ')} changed in a mock surface, and the commit names no request`, 'no request');
  if (rq === false) return fail('request', 'more than one Request line');
  // The request lives in requests/ and nowhere else, so it can't be the world
  // or any other file the gate reads (376-DT2). It isn't read otherwise.
  if (!REQUEST_FILE.test(rq[1])) return fail('request', `${rq[1]}: a request is requests/<name>.json, and is not read from anywhere else`);
  if (ac === false) return fail('unattributed', 'more than one Actor line');
  const world = input.world;
  if (!world || !Array.isArray(world.rows) || !world.rows.length) return fail('rows', 'no readable world to decide the act by');
  const read = typeof input.readShipped === 'function' ? input.readShipped : () => null;
  let q = null;
  try { q = JSON.parse(read(rq[1])); } catch (e) { q = null; }
  if (!q || typeof q !== 'object') return fail('request', `${rq[1]} is not a readable request`);
  act.operator = q.operator || null; act.fingerprint = q.fingerprint || null; act.evaluated = q.evaluated || null;
  if (ar.fingerprint(q) !== q.fingerprint || rq[2] !== q.fingerprint) return fail('request', 'the fingerprint does not match the request: not the act that was authorized');
  const text = typeof q.path === 'string' ? read(q.path) : null;
  if (text === null || ar.sha(text) !== q.content) return fail('request', `${q.path} as shipped differs from the request evaluated: not the act that was authorized`);
  if (!ac) return fail('unattributed', 'the commit names no actor');
  if (ac[1] !== q.operator) return fail('unattributed', `the commit names ${ac[1]}; the request's operator is ${q.operator}`);

  const e = ar.evaluate(q, world, store.rows.filter((x) => x.relation === 'Rule'));
  act.rows = e.context.path; act.requires = e.context.requires; act.bound = e.bound;
  if (e.condition !== 'permitted') return fail(e.condition, e.detail, e.why);
  const beyond = changed.filter((f) => f !== rq[1] && f !== q.path);
  if (beyond.length) {
    let granted = [];
    try {
      const wr = evaluate(store.rows.filter((x) => x.relation === 'Rule'), facts(world.rows).relations);
      granted = [...(wr.Permitted || [])].map((x) => x.split(SEP)).filter(([a, k]) => a === q.operator && k === q.action).map(([, , s]) => s).sort();
    } catch (e) { granted = []; }
    act.bound = { granted, attempted: q.surface, path: q.path, beyond };
    return fail('unactionable', `the act also changes ${beyond.join(', ')}, which its request doesn't name`, 'beyond extent');
  }
  act.condition = 'permitted'; act.detail = e.detail;
}

// ------------------------------------------------------------- the build
function git(...args) { return String(execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] })).trim(); }
function tryGit(...args) { try { return git(...args); } catch (e) { return null; } }

// ------------------------------------------------------------- the end of a build
// The watching mode (OKF-TOGAF#219's recorder, 628-CC with 308-DT2's
// additions): config.mode "record" writes every decision down, naming its
// mode, and ends the build normally, serving nothing; any other value, a
// missing setting included, is "refuse", the gate as proved. A gate that
// cannot decide is written down as could-not-decide, and refuses in refuse
// mode as an uncaught error did before.
function finish({ decision, error, config }) {
  const mode = config && config.mode === 'record' ? 'record' : 'refuse';
  const d = error || !decision
    ? { gate: 'authority gate, piece 4', commit: (decision && decision.commit) || null, outcome: 'could-not-decide', refusals: [], why: String((error && error.message) || error || 'no decision') }
    : decision;
  const line = 'GATE DECISION ' + JSON.stringify(Object.assign({}, d, { mode }));
  const stops = d.outcome !== 'allowed';
  const why = d.outcome === 'could-not-decide' ? 'could not decide: ' + d.why : (d.refusals || []).map((x) => x.rule + ': ' + x.detail).join(' | ');
  if (mode === 'record') return { exitCode: 0, line, serve: false, note: stops ? 'GATE RECORDED, would refuse: ' + why : 'GATE RECORDED, would allow' };
  return { exitCode: stops ? 1 : 0, line, serve: !stops && !!config && config.serve_decision === true, note: stops ? 'GATE REFUSED: ' + why : null };
}

function main() {
  const root = path.join(__dirname, '..');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) { config = {}; }
  let d = null, error = null;
  try {
    const sha = tryGit('rev-parse', 'HEAD');
    let store = null;
    try { store = JSON.parse(fs.readFileSync(path.join(__dirname, 'store.json'), 'utf8')); } catch (e) { store = null; }
    const fileAt = (rev, p) => { try { return String(execFileSync('git', ['show', rev + ':' + p], { stdio: ['ignore', 'pipe', 'ignore'] })); } catch (e) { return null; } };
    let world = null;
    try { world = JSON.parse(fileAt(sha, 'gate/world.json')); } catch (e) { world = null; }
    d = sha ? decide({
      sha,
      world,
      readShipped: (p) => fileAt(sha, p),
      varSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
      message: tryGit('log', '-1', '--format=%B', sha) || '',
      tree: tryGit('rev-parse', sha + '^{tree}'),
      isAncestor: (b) => { try { execFileSync('git', ['merge-base', '--is-ancestor', b, sha], { stdio: 'ignore' }); return true; } catch (e) { return false; } },
      changed: (b) => { const r = tryGit('diff', '--name-only', '--no-renames', b, sha); return r === null ? null : r.split('\n').filter(Boolean); },
      fileAt,
      store,
    }) : { gate: 'authority gate, piece 4', commit: null, outcome: 'refused', refusals: [{ rule: 'commit', detail: 'no commit checked out' }] };
  } catch (e) { error = e; }
  const r = finish({ decision: d, error, config });
  console.log(r.line);
  // Only the throwaway target serves its record; a live site never does (583-CC),
  // and the watching mode never does.
  if (r.serve) {
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
    fs.writeFileSync(path.join(root, 'public', 'gate-decision.json'), JSON.stringify(d, null, 2) + '\n');
  }
  if (r.note) (r.exitCode ? console.error : console.log)(r.note);
  process.exitCode = r.exitCode;
}

if (require.main === module) main();
module.exports = { decide, matches, wiringChanges, finish };
