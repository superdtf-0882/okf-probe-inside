// authority-einsum -- the second evaluator of the authority rules: each rule
// compiled into Boolean tensor contractions, as Tensor Logic writes a Datalog
// rule (DTOG-d7-plan sections 1 and 6; 269-DT2 change 4). Built under
// OKF-TOGAF#219, piece 2 of 568-CC, on the owner's line approving the plan
// with 269-DT2's four changes.
//
// A relation of arity n is a dense Boolean tensor over the domain of
// constants. A rule's body is contracted literal by literal, summing out each
// variable once no later literal or the head needs it, and the step function
// turns any count above zero into true. A negated literal is the complement of
// its tensor, read only once its stratum is complete. Recursive rules repeat
// to a fixpoint.
//
// It parses the Rule rows itself and shares nothing with the join evaluator
// (lib/authority-join.js) but the relations lib/authority-facts.js builds.
//
// HOW IT CAN BE CROSSED (RULE-10): the tensors are dense, so a domain much
// larger than the practice's would be slow before it was wrong; the size is
// printed with each run.

'use strict';

const SEP = '\u0001';

// This evaluator's own reading of a literal, written apart from the join's.
function literal(text, id) {
  const s = String(text).trim();
  const neg = /^not\s+/.test(s);
  const rest = s.replace(/^not\s+/, '');
  const open = rest.indexOf('(');
  if (open < 1 || !rest.endsWith(')')) throw new Error(`${id}: "${text}" is not a literal`);
  const args = rest.slice(open + 1, -1).split(',').map((x) => x.trim()).filter((x) => x.length);
  return { neg, pred: rest.slice(0, open).trim(), args };
}

// A tensor: a Boolean array over the domain, one axis per argument.
function make(arity, D) { return { arity, data: new Uint8Array(Math.max(1, D ** arity)) }; }
function offset(ix, D) { let o = 0; for (const i of ix) o = o * D + i; return o; }

// Every assignment of n variables over the domain, as index arrays.
function* assignments(n, D) {
  const ix = new Array(n).fill(0);
  if (n === 0) { yield ix; return; }
  while (true) {
    yield ix;
    let p = n - 1;
    while (p >= 0 && ++ix[p] === D) { ix[p] = 0; p--; }
    if (p < 0) return;
  }
}

// One factor of a rule's body: a literal's tensor seen over its distinct
// variables, complemented when the literal is negated.
function factor(lit, T, D) {
  const vars = [...new Set(lit.args)];
  const out = make(vars.length, D);
  const t = T[lit.pred];
  for (const ix of assignments(vars.length, D)) {
    const at = lit.args.map((v) => ix[vars.indexOf(v)]);
    const v = t && t.arity === lit.args.length ? t.data[offset(at, D)] : 0;
    out.data[offset(ix, D)] = lit.neg ? 1 - v : v;
  }
  return { vars, t: out };
}

// Contract two factors: the product over their union of variables, summed over
// the variables `keep` leaves out, then the step function.
function contract(a, b, keep, D) {
  const U = [...new Set(a.vars.concat(b.vars))];
  const K = U.filter((v) => keep.has(v));
  const sums = new Uint32Array(Math.max(1, D ** K.length));
  for (const ix of assignments(U.length, D)) {
    const va = a.t.data[offset(a.vars.map((v) => ix[U.indexOf(v)]), D)];
    if (!va) continue;
    const vb = b.t.data[offset(b.vars.map((v) => ix[U.indexOf(v)]), D)];
    if (!vb) continue;
    sums[offset(K.map((v) => ix[U.indexOf(v)]), D)] += va * vb;
  }
  const t = make(K.length, D);
  for (let i = 0; i < sums.length; i++) t.data[i] = sums[i] > 0 ? 1 : 0;
  return { vars: K, t };
}

// The head's tensor: the body contracted left to right, each variable summed
// out once nothing after it needs it.
function apply(rule, T, D) {
  const lits = rule.body.filter((l) => !l.neg).concat(rule.body.filter((l) => l.neg));
  let acc = { vars: [], t: Object.assign(make(0, D), { data: new Uint8Array([1]) }) };
  lits.forEach((lit, i) => {
    const need = new Set(rule.head.args);
    lits.slice(i + 1).forEach((l) => l.args.forEach((v) => need.add(v)));
    acc = contract(acc, factor(lit, T, D), need, D);
  });
  const out = make(rule.head.args.length, D);
  for (const ix of assignments(acc.vars.length, D)) {
    if (!acc.t.data[offset(ix, D)]) continue;
    out.data[offset(rule.head.args.map((v) => ix[acc.vars.indexOf(v)]), D)] = 1;
  }
  return out;
}

function evaluate(ruleRows, relations) {
  const values = new Set();
  for (const s of Object.values(relations)) for (const k of s) k.split(SEP).forEach((x) => values.add(x));
  const dom = [...values].sort();
  const D = Math.max(1, dom.length);
  const at = new Map(dom.map((x, i) => [x, i]));
  const T = {};
  for (const [n, s] of Object.entries(relations)) {
    const tuples = [...s].map((k) => k.split(SEP));
    const arity = tuples.length ? tuples[0].length : 0;
    T[n] = make(arity, D);
    for (const tu of tuples) T[n].data[offset(tu.map((x) => at.get(x)), D)] = 1;
  }
  const rules = ruleRows.map((r) => ({ id: r.id, stratum: r.stratum, head: literal(r.head, r.id), body: [].concat(r.body || []).map((b) => literal(b, r.id)) }));
  for (const r of rules) if (!T[r.head.pred] || T[r.head.pred].arity !== r.head.args.length) T[r.head.pred] = T[r.head.pred] && T[r.head.pred].data.some((x) => x) ? T[r.head.pred] : make(r.head.args.length, D);
  for (const s of [...new Set(rules.map((r) => r.stratum))].sort((a, b) => a - b)) {
    const here = rules.filter((r) => r.stratum === s);
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of here) {
        const h = apply(r, T, D);
        const into = T[r.head.pred];
        for (let i = 0; i < h.data.length; i++) if (h.data[i] && !into.data[i]) { into.data[i] = 1; changed = true; }
      }
    }
  }
  const out = {};
  for (const [n, t] of Object.entries(T)) {
    out[n] = new Set();
    for (const ix of assignments(t.arity, D)) if (t.data[offset(ix, D)]) out[n].add(ix.map((i) => dom[i]).join(SEP));
  }
  out.__domain = D;
  return out;
}

module.exports = { evaluate };
