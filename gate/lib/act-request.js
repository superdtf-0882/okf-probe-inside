// act-request -- the request for an act and its evaluation, before acting
// (OKF-TOGAF#234, pieces 2 and 3 of 368-DT2's plan with 742-CC's
// corrections; fixed on 373-DT2). Given a proposed act -- who, in what role,
// doing what, to what, where, under which Work Item and intent, with what
// text -- it gives the operator the intent chain, the authority path or its
// absence, the Requires rows, the instruments and words the target names, and
// the result, named by its own word; and it writes the request down with a
// fingerprint, the one the probe's gate binds the shipped act to (piece 4).
//
// THIS MODULE IS PURE: it reads nothing from disk, git, the environment or
// the network. The caller passes the world (rows, kinds, acts, intents,
// records) and the Rule rows. The relations are lib/authority-facts.js's, and
// both evaluators, lib/authority-join.js and lib/authority-einsum.js, decide
// the authority, unchanged. A caller may pass its own evaluators
// ({ evaluators: [...] }), so a test can give two that disagree.
//
// The conditions, checked in this order, the first that holds deciding:
//   rows          no rows in the world, or no Rule rows: nothing to decide by
//   unattributed  the request names no operator, or one no Actor row defines
//   unactionable  the authority isn't established, and why:
//                   'undecided'      the evaluators disagree
//                   'barred'         a grant reaches the surface and a bar there refuses it
//                   'no path'        no row grants the action anywhere
//                   'beyond extent'  the grants don't reach the surface, or the
//                                    request's path lies outside it
//   undefined     no record defines the target, or no kinds row defines its kind
//   misplaced     the target's stratum is not the one the act requires, or no
//                 acts row states the stratum, so placement can't be shown
//   ill-typed     the request names no intent, or the target's chain doesn't
//                 reach the intent it names
//   requires      a Requires row's condition is unmet, or is one this module
//                 can't read
//   permitted     with the rows that permit this act
// Authority comes before the thing: an act to a surface no acts row covers
// is first a question of whether the operator may act there at all.
//
// Anything inferred, such as a missing realizes link, is returned in
// context.proposals and never written into the chain.
//
// HOW IT CAN BE CROSSED (RULE-10): the fingerprint is anyone's to compute
// (370-DT2 section 3). It binds what ships to the request the gate decides;
// it doesn't show the operator was given this evaluation. The request's
// `evaluated` field is the request's own statement, outside the fingerprint,
// and is read back as that, never as the gate's finding. A Requires condition
// this module has no reader for is refused, not passed. A path is compared
// with its surface's folder as text, after any path holding a '.' or '..'
// segment, an empty segment, a leading '/' or a backslash is refused.

'use strict';

const crypto = require('crypto');
const { facts, SEP } = require('./authority-facts');
const join = require('./authority-join');
const einsum = require('./authority-einsum');

const FP_FIELDS = ['operator', 'role', 'action', 'target', 'surface', 'path', 'work_item', 'intent', 'content'];
const sha = (s) => crypto.createHash('sha256').update(String(s).replace(/\r\n/g, '\n')).digest('hex');
const fingerprint = (q) => sha(JSON.stringify(FP_FIELDS.map((k) => [k, q[k] === undefined ? null : q[k]])));
const present = (v) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
const uniq = (xs) => [...new Set(xs)];

// The Requires conditions this module can read, by their exact words.
const CONDITIONS = {
  'the request names its Work Item and its intent': (q) => present(q.work_item) && present(q.intent),
};

const tuples = (set) => [...(set || [])].map((x) => x.split(SEP));

// A path that could leave its folder however it is compared.
const unsafePath = (p) => /\\/.test(p) || p.startsWith('/') || p.split('/').some((seg, i, all) => seg === '.' || seg === '..' || (seg === '' && i < all.length - 1));

// The path surfaces under a surface: itself if it has a path, else those
// within it.
function pathSurfaces(rows, rel, surface) {
  const byId = new Map(rows.filter((r) => r.relation === 'Surface').map((r) => [r.id, r]));
  const s = byId.get(surface);
  if (s && present(s.path)) return [s];
  return tuples(rel.Within).filter(([, r]) => r === surface).map(([p]) => byId.get(p)).filter(Boolean);
}

// The request as written down. The path is the request's own if it names one,
// else the target's file in the one path surface under the surface.
function request(p, rows, rel) {
  let path = present(p.path) ? p.path : null;
  if (!path && rel) {
    const ps = pathSurfaces(rows, rel, p.surface);
    if (ps.length === 1 && present(p.target)) path = ps[0].path + p.target + '.md';
  }
  const q = {};
  for (const k of FP_FIELDS) q[k] = k === 'path' ? path : k === 'content' ? (present(p.content) ? p.content : present(p.text) ? sha(p.text) : null) : (p[k] === undefined ? null : p[k]);
  return q;
}

function evaluate(proposal, world, ruleRows, opts) {
  const p = proposal || {};
  const evaluators = (opts && opts.evaluators) || [join, einsum];
  const context = { chain: [], path: [], requires: [], governed_by: [], words: [], proposals: [] };
  let rows = [], rel = null;
  const out = (condition, why, detail, extra) => {
    const q = request(p, rows, rel);
    q.evaluated = condition;
    q.fingerprint = fingerprint(q);
    return Object.assign({ condition, why: why || null, detail: detail || '', bound: null, request: q, context }, extra || {});
  };
  if (!world || !Array.isArray(world.rows) || world.rows.length === 0) return out('rows', null, 'no readable world: no rows to decide the act');
  if (!Array.isArray(ruleRows) || ruleRows.length === 0) return out('rows', null, 'no Rule rows: nothing to decide the act by');
  rows = world.rows;
  const f = facts(rows);
  const results = evaluators.map((e) => e.evaluate(ruleRows, f.relations));
  rel = results[0];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const op = p.operator;
  const has = (name, ...xs) => !!rel[name] && rel[name].has(xs.join(SEP));
  const reach = tuples(rel.Under).filter(([x]) => x === p.surface).map(([, r]) => r);
  const permittedIn = (r) => tuples(r.Permitted).filter(([a, k]) => a === op && k === p.action).map(([, , s]) => s).sort();
  const granted = permittedIn(rel);

  // The rows that grant the operator this action: those reaching the
  // attempted surface, else (the extent) all of them.
  const tiers = rows.filter((r) => r.relation === 'Tier' && r.actor === op);
  const mays = [];
  for (const t of tiers) for (const m of rows.filter((r) => r.relation === 'May' && r.tier === t.tier && r.action === p.action)) mays.push([t, m]);
  const lines = [];
  for (const l of rows.filter((r) => r.relation === 'Line' && r.given_to === op)) {
    for (const g of [].concat(l.grants || [])) if (g && g.action === p.action && g.surface) lines.push([l, g.surface]);
  }
  const here = mays.filter(([, m]) => reach.includes(m.surface)).flatMap(([t, m]) => [t.id, m.id])
    .concat(lines.filter(([l, s]) => reach.includes(s) && !has('Excluded', l.id, p.surface)).map(([l]) => l.id));
  const anywhere = mays.flatMap(([t, m]) => [t.id, m.id]).concat(lines.map(([l]) => l.id));
  context.path = uniq(here.length ? here : anywhere);
  context.requires = rows.filter((r) => r.relation === 'Requires' && r.action === p.action && reach.includes(r.surface)).map((r) => r.id);
  const bars = rows.filter((r) => r.relation === 'Forbidden' && r.action === p.action
    && (r.actor === op || tiers.some((t) => t.tier === r.tier))
    && ((r.surface && reach.includes(r.surface)) || (r.class && has('InClass', p.surface, r.class)))).map((r) => r.id);

  if (!present(op)) return out('unattributed', null, 'the request names no operator');
  const actor = byId.get(op);
  if (!actor || actor.relation !== 'Actor') return out('unattributed', null, `${op}: no Actor row defines the operator`);

  const q = request(p, rows, rel);
  const bound = { granted, attempted: p.surface, path: q.path };
  if (results.some((r) => permittedIn(r).join() !== granted.join())) {
    return out('unactionable', 'undecided', `the evaluators disagree on where ${op} may ${p.action}: ${results.map((r) => permittedIn(r).join(', ') || 'nowhere').join(' against ')}`, { bound });
  }
  if (!granted.includes(p.surface)) {
    if (has('Authorized', op, p.action, p.surface) && bars.length) return out('unactionable', 'barred', `${uniq(here).join(', ')} give ${op} ${p.action} to ${p.surface}; ${bars.join(', ')} bars it`, { bound });
    if (!granted.length) return out('unactionable', 'no path', `no row gives ${op} ${p.action} anywhere`);
    return out('unactionable', 'beyond extent', `${op} may ${p.action} to ${granted.join(', ')}, not ${p.surface}`, { bound });
  }
  if (!present(q.path) || unsafePath(String(q.path))) return out('unactionable', 'beyond extent', `${q.path || 'no path'}: a path that could leave its folder is refused`, { bound });
  if (!pathSurfaces(rows, rel, p.surface).some((s) => String(q.path).startsWith(s.path))) return out('unactionable', 'beyond extent', `${q.path} lies outside ${p.surface}`, { bound });

  const rec = [].concat(world.records || []).find((r) => r.id === p.target);
  if (!present(p.target) || !rec) return out('undefined', null, `${p.target}: no record defines the target`);
  context.governed_by = [].concat(rec.governed_by || []);
  context.words = [].concat(rec.words || []);
  const kind = [].concat(world.kinds || []).find((k) => k.kind === rec.kind);
  if (!kind) return out('undefined', null, `${rec.id} is a ${rec.kind}, a kind no kinds row defines`);

  const actRow = [].concat(world.acts || []).find((a) => a.action === p.action && reach.includes(a.surface));
  if (!actRow) return out('misplaced', null, `no row states the stratum ${p.action} to ${p.surface} requires, so ${rec.id}'s placement at ${kind.stratum} can't be shown`);
  if (kind.stratum !== actRow.stratum) return out('misplaced', null, `${rec.id} is a ${rec.kind} at ${kind.stratum}; ${p.action} to ${actRow.surface} requires ${actRow.stratum}`);

  const intents = new Map([].concat(world.intents || []).map((i) => [i.id, i]));
  const realizes = [].concat(rec.realizes || []).filter((i) => intents.has(i));
  context.chain = [rec.id].concat(realizes);
  if (!realizes.length) {
    if (present(p.intent)) context.proposals.push(`proposed, not a fact: ${rec.id} realizes ${p.intent} (from the request's intent; no row says so)`);
    return out('ill-typed', null, `${rec.id} realizes no defined intent, so no chain reaches ${p.intent || 'an intent'}`);
  }
  if (!present(p.intent)) return out('ill-typed', null, 'the request names no intent, so the act resolves to none');
  if (!realizes.includes(p.intent)) return out('ill-typed', null, `${rec.id}'s chain reaches ${realizes.join(', ')}, not ${p.intent}`);

  for (const id of context.requires) {
    const r = byId.get(id);
    const read = CONDITIONS[r.condition];
    if (!read) return out('requires', null, `${id}: "${r.condition}" is a condition this tool can't read, so it is not passed`);
    if (!read(Object.assign({}, p, q))) return out('requires', null, `${id}: ${r.condition}, unmet`);
  }
  return out('permitted', null, `permitted by ${context.path.join(', ')}`);
}

module.exports = { evaluate, request, fingerprint, sha, FP_FIELDS, CONDITIONS };
