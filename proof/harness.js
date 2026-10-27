#!/usr/bin/env node
// OKF-TOGAF#234's local harness (368-DT2 pieces 2 and 3, with 742-CC's
// corrections): the request and its evaluation, before any act. Given a
// proposed act on the mock world, the request tool gives the operator the
// intent chain, the authority path or its absence, and the Requires rows,
// names a failure by its own word, and writes the request with its
// fingerprint, the one the gate binds the shipped act to. Anything it infers
// is a proposal, never a fact. Written before the code (piece 1): it fails
// until gate/lib/act-request.js, a copy of the practice's tools/lib/, exists.
// No git, no environment, no network. Exit 1 on a failure.
'use strict';
const crypto = require('crypto');
const WORLD = require('../gate/world.json');
const STORE = require('../gate/store.json');

const sha = (s) => crypto.createHash('sha256').update(String(s).replace(/\r\n/g, '\n')).digest('hex');
const FP_FIELDS = ['operator', 'role', 'action', 'target', 'surface', 'path', 'work_item', 'intent', 'content'];
const fingerprint = (q) => sha(JSON.stringify(FP_FIELDS.map((k) => [k, q[k] === undefined ? null : q[k]])));
const TEXT = '# Doc_Valid\n\nPublishing serves the mock intent.\n';
const RULES = STORE.rows.filter((r) => r.relation === 'Rule');
const ask = (o) => Object.assign({ operator: 'Alice', role: 'Publisher', action: 'publish', target: 'Doc_Valid', surface: 'Repo_Main', work_item: 'WI-MOCK-1', intent: 'INT-MOCK', text: TEXT }, o || {});

const cases = [];
const t = (label, fn) => cases.push([label, fn]);
let lib = null, loadError = '';
try { lib = require('../gate/lib/act-request'); } catch (e) { loadError = e.code || e.message; }
const run = (o, world) => lib.evaluate(ask(o), world || WORLD, RULES);

t('case 1: permitted, with the chain, the path and the Requires row given before acting', () => {
  const e = run(); const c = e.context;
  return e.condition === 'permitted' && e.request.evaluated === 'permitted' && e.request.path === 'main/Doc_Valid.md'
    && JSON.stringify(c.chain) === JSON.stringify(['Doc_Valid', 'INT-MOCK']) && c.path.includes('May_Publisher_Main') && c.requires.includes('Req_Main_Basis');
});
t('case 1: the request carries the content\'s hash and the fingerprint the gate recomputes', () => {
  const e = run(); return e.request.content === sha(TEXT) && e.request.fingerprint === fingerprint(e.request);
});
t('case 2: Bob, a drafter, publishing: unactionable, no path, and the path is empty', () => { const e = run({ operator: 'Bob', role: 'Drafter' }); return e.condition === 'unactionable' && e.why === 'no path' && e.context.path.length === 0; });
t('case 3: Alice to Repo_Other: unactionable beyond extent, the extent granted and the surface attempted', () => {
  const e = run({ surface: 'Repo_Other' });
  return e.condition === 'unactionable' && e.why === 'beyond extent' && e.bound.granted.includes('Repo_Main') && e.bound.attempted === 'Repo_Other';
});
t('case 4: Bob, once granted, is evaluated permitted; the gate catches the withdrawal', () => {
  const w = Object.assign({}, WORLD, { rows: WORLD.rows.concat([{ id: 'Tier_Bob_Publisher', title: 'Bob publishes', relation: 'Tier', actor: 'Bob', tier: 'Publisher' }]) });
  return run({ operator: 'Bob', role: 'Publisher' }, w).condition === 'permitted' && run({ operator: 'Bob', role: 'Publisher' }).condition === 'unactionable';
});
t('case 5: Doc_Ghost: undefined', () => run({ target: 'Doc_Ghost' }).condition === 'undefined');
t('case 6: Log_Data: misplaced, its stratum and the one the act requires named', () => { const e = run({ target: 'Log_Data' }); return e.condition === 'misplaced' && /S7/.test(e.detail) && /S4/.test(e.detail); });
t('case 7: Doc_Orphan: ill-typed, and the missing link offered as a proposal, not a fact', () => {
  const e = run({ target: 'Doc_Orphan' });
  return e.condition === 'ill-typed' && e.context.proposals.some((p) => /realizes/.test(p) && /INT-MOCK/.test(p)) && !e.context.chain.includes('INT-MOCK');
});
t('a request whose claimed intent is not on the target\'s chain is ill-typed', () => run({ intent: 'INT-OTHER-MOCK' }).condition === 'ill-typed');
t('a request naming no operator is refused before acting: unattributed', () => run({ operator: null }).condition === 'unattributed');

let failed = 0;
console.log('PROOF HARNESS (OKF-TOGAF#234, pieces 2 and 3)\n');
if (!lib) console.log(`  the request tool is not built yet (${loadError})\n`);
for (const [label, fn] of cases) {
  let ok = false, err = '';
  if (lib) { try { ok = fn() === true; } catch (e) { err = ' (' + e.message + ')'; } }
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : err}`);
}
console.log(failed ? `\nPROOF HARNESS FAILED: ${failed} of ${cases.length}.` : `\nproof harness passed: ${cases.length}.`);
process.exitCode = failed ? 1 : 0;
