'use strict';
// Tests for combat/optimize.js. Run: node combat/test_optimize.js
// One line per passed check; exits non-zero if any check fails.
const assert = require('node:assert');
const O = require('./optimize.js');

let passed = 0, failed = 0;
function check(name, fn) {
  try { const note = fn(); passed++; console.log('ok   ' + name + (note ? '  [' + note + ']' : '')); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')); }
}
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const key = set => set.join(',');
const ascending = set => set.every((x, i) => i === 0 || set[i - 1] < x);
const pct = x => (100 * x).toFixed(1) + '%';

// ---------- the instance suite: 320 seeded random instances + degenerate ones ----------
function params(seed) {
  const r = O.mulberry32(seed * 7919 + 13), pick = a => a[Math.floor(r() * a.length)];
  return { nE: pick([1, 2, 3, 4, 5, 6, 8, 10]), nOps: pick([1, 2, 3, 4, 5, 6, 8]), nTiles: pick([1, 2, 3, 4, 6, 9]), K: pick([1, 2, 3, 4, 5]),
    limit: pick([1, 2, 3, 4, 5]), ties: r() < 0.4, sparsity: pick([0, 0.3, 0.6, 0.85]), integer: r() < 0.7, weights: r() < 0.5, scramble: r() < 0.5,
    hpMax: pick([5, 30, 30, 100]), potMax: pick([5, 12, 12, 40]) };
}
const CASES = [];
for (let seed = 1; seed <= 320; seed++) { const opts = params(seed); CASES.push({ name: 'rand#' + seed, opts, inst: O.randomInstance(seed, opts) }); }
const N_RANDOM = CASES.length;
const DEGENERATE = {
  'no candidates': { nOps: 0 },
  'limit 0': { limit: 0 },
  'all-zero pot': { sparsity: 1 },
  'hp below a single pot': { hpMax: 1, potMax: 50, sparsity: 0 },
  'no enemies': { nE: 0 },
  'limit above candidate count': { limit: 50, nOps: 3, K: 2 },
  'limit Infinity': { limit: Infinity, nOps: 3, K: 2 },
  'one tile for everybody': { nTiles: 1, nOps: 5, K: 3 },
  'one operator, many candidates': { nOps: 1, K: 8, nTiles: 9, limit: 4 },
  'everything tied': { ties: true, sparsity: 0, potMax: 1, hpMax: 3, nOps: 4, K: 3, limit: 3 },
};
for (const [name, opts] of Object.entries(DEGENERATE)) for (let s = 1; s <= 3; s++) CASES.push({ name: name + '#' + s, opts, inst: O.randomInstance(9000 + s, opts) });
{ // enemies with 0 HP and 0 weight mixed in
  const inst = O.randomInstance(77, { nE: 6, nOps: 4, K: 3, limit: 3, sparsity: 0.2 });
  inst.hp[0] = 0; inst.w[1] = 0; inst.hp[2] = 0; inst.w[2] = 0;
  CASES.push({ name: 'zero-HP and zero-weight enemies', opts: {}, inst });
}
// "hard" family: many clashes on few tiles and partial overkill, so greedy is often wrong and B&B must search
const HARD = [
  { nE: 12, nOps: 7, nTiles: 5, K: 4, limit: 4, sparsity: 0.5, integer: false, hpMax: 30, potMax: 15, weights: true },
  { nE: 12, nOps: 7, nTiles: 5, K: 4, limit: 4, sparsity: 0.5, ties: true, hpMax: 30, potMax: 15, scramble: true },
  { nE: 8, nOps: 7, nTiles: 4, K: 4, limit: 5, sparsity: 0.3, integer: false, hpMax: 15, potMax: 15 },
];
const HARD_FROM = CASES.length;
HARD.forEach((opts, f) => { for (let s = 1; s <= 8; s++) CASES.push({ name: `hard${f}#${s}`, opts, inst: O.randomInstance(5000 + 10 * f + s, opts) }); });

// brute force once per instance, with every feasible set's value seen through onSet
function brute(x) {
  if (!x.brute) {
    const vals = [];
    let extraParents = 0;   // sum over non-empty feasible sets of (|S| - 1): how often a level-wise search re-derives a set
    const res = O.bruteForce(x.inst, { topN: 5, onSet: (ids, v) => { vals.push(v); if (ids.length) extraParents += ids.length - 1; } });
    vals.sort((a, b) => b - a);
    const opt = vals[0];
    x.brute = { res, opt, top5: vals.slice(0, 5), nSets: vals.length, extraParents, nOptimal: vals.filter(v => v >= opt - 1e-9 * Math.max(1, Math.abs(opt))).length };
  }
  return x.brute;
}
function randomFeasible(inst, seed) {   // a random feasible set: shuffled candidates, first fit
  const r = O.mulberry32(seed), c = inst.cands.slice(), ops = new Set(), tiles = new Set(), set = [];
  for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)), t = c[i]; c[i] = c[j]; c[j] = t; }
  for (const x of c) if (set.length < inst.limit && !ops.has(x.op) && !tiles.has(x.tile)) { set.push(x.id); ops.add(x.op); tiles.add(x.tile); }
  return set;
}
// a search over ORDERED sequences (what symmetry breaking avoids): counts every sequence, the empty one included
function naivePermutationCount(inst) {
  const L = Math.min(inst.limit, inst.cands.length);
  let count = 0;
  const rec = (ops, tiles, depth) => {
    count++;
    if (depth >= L) return;
    for (const c of inst.cands) {
      if (ops.has(c.op) || tiles.has(c.tile)) continue;
      ops.add(c.op); tiles.add(c.tile); rec(ops, tiles, depth + 1); ops.delete(c.op); tiles.delete(c.tile);
    }
  };
  rec(new Set(), new Set(), 0);
  return count;
}
const mk = (limit, hp, rows) => ({ limit, hp: Float64Array.from(hp), w: new Float64Array(hp.length).fill(1),
  cands: rows.map(([id, op, tile, dir, pot]) => ({ id, op, tile, dir, cost: 10, pot: Float64Array.from(pot) })) });

// ---------- building blocks ----------
check('Heap: max-heap and min-heap pop in order', () => {
  const r = O.mulberry32(5), xs = Array.from({ length: 500 }, () => Math.floor(r() * 100));
  const maxH = new O.Heap((a, b) => a > b), minH = new O.Heap((a, b) => a < b);
  for (const x of xs) { maxH.push(x); minH.push(x); }
  const down = [], up = [];
  while (maxH.size) down.push(maxH.pop());
  while (minH.size) up.push(minH.pop());
  assert.deepStrictEqual(down, xs.slice().sort((a, b) => b - a));
  assert.deepStrictEqual(up, xs.slice().sort((a, b) => a - b));
  assert.strictEqual(maxH.pop(), undefined);
  const h = new O.Heap((a, b) => a < b), ref = [];   // interleaved pushes and pops against a sorted array
  for (let i = 0; i < 2000; i++) {
    if (ref.length && r() < 0.4) { ref.sort((a, b) => a - b); assert.strictEqual(h.pop(), ref.shift()); }
    else { const x = r(); h.push(x); ref.push(x); }
    assert.strictEqual(h.size, ref.length);
  }
});
check('TopN: bounded min-heap keeps exactly the N best values', () => {
  const r = O.mulberry32(6), P = O.prepare(mk(1, [1], []));
  for (const N of [1, 3, 7]) {
    const top = new O.TopN(N), vals = Array.from({ length: 200 }, () => Math.floor(r() * 50));
    for (const v of vals) top.offer(v, []);
    assert.deepStrictEqual(top.heap.a.map(e => e.value).sort((a, b) => b - a), vals.slice().sort((a, b) => b - a).slice(0, N));
    assert.strictEqual(top.threshold(), vals.slice().sort((a, b) => b - a)[N - 1]);
  }
  assert.strictEqual(new O.TopN(4).threshold(), -Infinity);
  assert.ok(P);
});
check('mulberry32 and randomInstance are deterministic per seed', () => {
  const a = O.mulberry32(42), b = O.mulberry32(42), c = O.mulberry32(43);
  const xa = Array.from({ length: 20 }, a), xb = Array.from({ length: 20 }, b), xc = Array.from({ length: 20 }, c);
  assert.deepStrictEqual(xa, xb); assert.notDeepStrictEqual(xa, xc);
  assert.ok(xa.every(x => x >= 0 && x < 1));
  const flat = i => JSON.stringify({ l: i.limit, hp: [...i.hp], w: [...i.w], c: i.cands.map(k => [k.id, k.op, k.tile, k.dir, k.cost, [...k.pot]]) });
  for (const x of CASES.slice(0, 40)) assert.strictEqual(flat(O.randomInstance(Number(x.name.slice(5)), x.opts)), flat(x.inst));
});
check('randomInstance produces ties, tile conflicts, multi-candidate operators, twins and identical candidates', () => {
  let ties = 0, tileConflicts = 0, multi = 0, twins = 0, identical = 0, scrambled = 0;
  for (const x of CASES.slice(0, N_RANDOM)) {
    const c = x.inst.cands;
    if (brute(x).nOptimal > 1) ties++;
    if (c.some(p => c.some(q => p !== q && p.op !== q.op && p.tile === q.tile))) tileConflicts++;
    if (c.some(p => c.some(q => p !== q && p.op === q.op))) multi++;
    if (c.some(p => c.some(q => p !== q && p.op === q.op && p.tile === q.tile && p.dir !== q.dir))) twins++;
    if (c.some(p => c.some(q => p !== q && p.pot.length && p.pot.every((v, i) => v === q.pot[i])))) identical++;
    if (c.some((p, i) => p.id !== i)) scrambled++;
  }
  for (const n of [ties, tileConflicts, multi, twins, identical, scrambled]) assert.ok(n >= 20, 'feature too rare: ' + [ties, tileConflicts, multi, twins, identical, scrambled]);
  return `of ${N_RANDOM}: tied optimum ${ties}, tile conflicts ${tileConflicts}, multi-candidate operators ${multi}, same-tile twins ${twins}, identical candidates ${identical}, scrambled ids ${scrambled}`;
});
check('value and feasible on a hand-made instance', () => {
  const inst = mk(2, [10, 4], [[0, 'A', 1, 'E', [6, 3]], [1, 'A', 2, 'E', [1, 1]], [2, 'B', 1, 'S', [7, 0]], [3, 'B', 3, 'S', [0, 9]], [4, 'C', 4, 'W', [2, 2]]]);
  assert.strictEqual(O.value(inst, []), 0);
  assert.strictEqual(O.value(inst, [0]), 9);
  assert.strictEqual(O.value(inst, [0, 3]), 6 + 4);          // enemy 1: min(4, 3 + 9)
  assert.strictEqual(O.value(inst, [0, 2]), 10 + 3);         // enemy 0: min(10, 13); the set itself is infeasible (tile 1 twice)
  assert.strictEqual(O.feasible(inst, []), true);
  assert.strictEqual(O.feasible(inst, [0, 3]), true);
  assert.strictEqual(O.feasible(inst, [0, 1]), false);       // operator A twice
  assert.strictEqual(O.feasible(inst, [0, 2]), false);       // tile 1 twice
  assert.strictEqual(O.feasible(inst, [0, 3, 4]), false);    // over the limit
  assert.strictEqual(O.feasible(inst, [99]), false);         // unknown id
  assert.throws(() => O.value(inst, [99]), /unknown candidate/);
  inst.w[1] = 3;
  assert.strictEqual(O.value(inst, [0, 3]), 6 + 3 * 4);
});
check('string ids, plain-array hp/pot and a missing w work everywhere (what another module might hand in)', () => {
  const src = O.randomInstance(12, { nE: 5, nOps: 4, K: 3, nTiles: 4, limit: 3, sparsity: 0.3 });
  const inst = { limit: 3, hp: [...src.hp], cands: src.cands.map(c => ({ id: 'c' + String(c.id).padStart(2, '0'), op: 'op' + c.op, tile: c.tile, dir: c.dir, cost: c.cost, pot: [...c.pot] })) };
  const ref = O.bruteForce(src), b = O.bruteForce(inst), toStr = set => set.map(id => 'c' + String(id).padStart(2, '0')).sort();
  assert.strictEqual(b.value, ref.value);
  assert.deepStrictEqual(b.set, toStr(ref.set));
  for (const r of [O.branchAndBound(inst), O.solve(inst), O.beamSearch(inst, 1e9)]) { assert.strictEqual(r.value, ref.value); assert.ok(O.feasible(inst, r.set)); }
  assert.deepStrictEqual(O.greedy(inst).set, toStr(O.greedy(src).set));
  assert.deepStrictEqual(O.lazyGreedy(inst).set, O.greedy(inst).set);
  assert.deepStrictEqual(O.dominancePrune(inst).removedIds, toStr(O.dominancePrune(src).removedIds));
  const g = O.greedy(inst).set;
  assert.ok(O.localSearch(inst, g).value >= O.value(inst, g) && O.simulatedAnnealing(inst, g, { steps: 200 }).value >= O.value(inst, g));
  assert.strictEqual(O.checkSubmodular(inst, 100, 1).violations, 0);
  assert.strictEqual(O.branchAndBound(inst, { topN: 4 }).top.length, 4);
});
// The documented id order (spec, written out independently of optimize.js): numbers before strings, numbers
// numerically, strings by code units. Every returned set must be strictly ascending in it.
const idOrder = (a, b) => typeof a !== typeof b ? (typeof a === 'number' ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0;
const ascendingMixed = set => set.every((x, i) => i === 0 || idOrder(set[i - 1], x) < 0);
check('MIXED number/string ids in one instance: lazyGreedy === greedy, sets sorted numbers-then-strings (total id order)', () => {
  // the reviewer's instance: after 'a' the gains of 5, 'b' and 2 tie at 2; the smallest id in the total order is 2
  const inst = mk(2, [3, 3], [[5, 0, 0, 'E', [1, 2]], ['a', 1, 1, 'E', [2, 2]], [9, 2, 2, 'E', [0, 1]], ['b', 3, 3, 'E', [1, 2]], [2, 4, 4, 'E', [1, 1]]]);
  assert.deepStrictEqual(O.greedy(inst).set, [2, 'a']);
  assert.deepStrictEqual(O.lazyGreedy(inst).set, [2, 'a']);
  assert.strictEqual(O.greedy(inst).value, 6);
  // numeric strings next to numbers: 9 < '10' < '9' (as strings '10' < '9'; a number never equals a string)
  const ns = mk(3, [10, 10, 10], [['9', 0, 0, 'E', [5, 0, 0]], [9, 1, 1, 'E', [0, 5, 0]], ['10', 2, 2, 'E', [0, 0, 5]]]);
  for (const r of [O.greedy(ns), O.lazyGreedy(ns), O.bruteForce(ns), O.branchAndBound(ns), O.solve(ns), O.beamSearch(ns, 1e9)]) assert.deepStrictEqual(r.set, [9, '10', '9']);
  // seeded fuzz: ids of both types (numeric strings included) mixed inside every instance, many tied gains
  let n = 0, mixedPicks = 0;
  for (let seed = 1; seed <= 1500; seed++) {
    const x = O.randomInstance(seed, { nE: 3, nOps: 6, K: 2, nTiles: 8, limit: 3, ties: true, sparsity: 0.3, weights: seed % 2 === 0 });
    const r = O.mulberry32(seed * 31 + 7), used = new Set();
    for (const c of x.cands) {
      let id;
      do { const v = Math.floor(r() * 30), t = r(); id = t < 0.4 ? v : t < 0.7 ? String(v) : String.fromCharCode(97 + (v % 26)) + (v % 3); } while (used.has(typeof id + ':' + id));
      used.add(typeof id + ':' + id); c.id = id;
    }
    const g = O.greedy(x), l = O.lazyGreedy(x), b = O.bruteForce(x), bb = O.branchAndBound(x);
    assert.deepStrictEqual(l.set, g.set, 'seed ' + seed + ': lazy greedy chose another set');
    for (const res of [g, l, b, bb, O.solve(x), O.beamSearch(x, 4)]) assert.ok(ascendingMixed(res.set) && O.feasible(x, res.set), 'seed ' + seed + ': ' + JSON.stringify(res.set));
    for (const t of b.top) assert.ok(ascendingMixed(t.set));
    assert.strictEqual(bb.value, b.value, 'seed ' + seed);
    if (new Set(g.set.map(id => typeof id)).size === 2) mixedPicks++;
    n++;
  }
  assert.ok(mixedPicks >= 300, 'too few greedy sets mixing both id types: ' + mixedPicks);
  return `${n} instances, ${mixedPicks} greedy sets mix numbers and strings`;
});
check('MIXED ids: equal-value top lists are ordered by the id order, whatever the candidate order (1 before \'1\')', () => {
  for (const rows of [[['1', 0, 0, 'E', [4]], [1, 1, 1, 'E', [4]]], [[1, 1, 1, 'E', [4]], ['1', 0, 0, 'E', [4]]]]) {
    const inst = mk(1, [10], rows);
    for (const r of [O.bruteForce(inst, { topN: 3 }), O.branchAndBound(inst, { topN: 3 })]) assert.deepStrictEqual(r.top.map(t => t.set), [[1], ['1'], []]);
  }
});
check('MIXED ids: dominancePrune keeps exactly one of two identical twins (the smaller id: the number)', () => {
  for (const [a, b] of [[5, 'a'], ['a', 5], ['5', 5], [5, '5']]) {
    const inst = mk(1, [10], [[a, 'X', 0, 'E', [3]], [b, 'X', 0, 'S', [3]]]), d = O.dominancePrune(inst);
    assert.strictEqual(d.removed, 1, JSON.stringify([a, b]));
    assert.deepStrictEqual(d.inst.cands.map(c => c.id), [5]);
  }
});
check('prepare and dominancePrune reject ids that are neither a number nor a string (and NaN)', () => {
  for (const bad of [NaN, undefined, null, true, {}, [1]]) {
    const inst = mk(1, [10], [[0, 'X', 0, 'E', [3]], [bad, 'Y', 1, 'E', [2]]]);
    assert.throws(() => O.greedy(inst), /candidate id must be a number/, String(bad));
    assert.throws(() => O.dominancePrune(inst), /candidate id must be a number/, String(bad));
  }
});
check('prepare rejects negative or NaN pot, hp, w, wrong-length pot or w, and duplicate ids', () => {
  const bad = f => { const inst = mk(2, [10, 4], [[0, 'A', 1, 'E', [6, 3]], [1, 'B', 2, 'E', [1, 1]]]); f(inst); return () => O.greedy(inst); };
  assert.throws(bad(i => { i.cands[0].pot[1] = -1; }), /pot must be >= 0/);
  assert.throws(bad(i => { i.cands[0].pot[1] = NaN; }), /pot must be >= 0/);
  assert.throws(bad(i => { i.hp[0] = -5; }), /hp and w must be >= 0/);
  assert.throws(bad(i => { i.w[0] = -1; }), /hp and w must be >= 0/);
  assert.throws(bad(i => { i.cands[1].id = 0; }), /duplicate candidate id/);
  assert.throws(bad(i => { i.cands[1].pot = Float64Array.from([1]); }), /pot entries, expected 2/);
  assert.throws(bad(i => { i.w = Float64Array.from([1, 1, 1]); }), /w has 3 entries/);
});
check('gain/place (incremental HP-left array) agree with value() from the definition', () => {
  let sets = 0;
  for (const x of CASES) {
    const P = O.prepare(x.inst), r = O.mulberry32(11);
    for (let t = 0; t < 6; t++) {
      const left = O.newLeft(P), ids = [];
      let v = 0;
      for (let k = 0; k < P.n; k++) if (r() < 0.4) {   // any subset, feasible or not
        const g = O.gain(P, left, k), before = O.value(x.inst, ids);
        ids.push(P.ids[k]);
        assert.ok(close(g, O.value(x.inst, ids) - before), x.name + ': gain differs from the definition');
        const out = O.place(P, left, k, new Float64Array(P.nE));
        O.place(P, left, k);
        assert.deepStrictEqual([...out], [...left]);
        v += g;
      }
      assert.ok(close(v, O.value(x.inst, ids)), x.name);
      assert.ok(left.every((l, i) => l >= 0 && l <= x.inst.hp[i]));
      assert.ok(close(O.damageSoFar(P, left).reduce((s, d, i) => s + P.w[i] * d, 0), v), x.name + ': damageSoFar');
      sets++;
    }
  }
  return sets + ' random subsets';
});

// ---------- brute force (the reference) ----------
check('bruteForce: visits every feasible set once, best and top-5 match a plain sort of all values', () => {
  let nodes = 0;
  for (const x of CASES) {
    const b = brute(x);
    assert.strictEqual(b.res.stats.explored, b.nSets);
    assert.ok(close(b.res.value, b.opt), x.name);
    assert.ok(O.feasible(x.inst, b.res.set) && ascending(b.res.set), x.name);
    assert.strictEqual(b.res.top.length, Math.min(5, b.nSets));
    b.res.top.forEach((t, i) => { assert.ok(close(t.value, b.top5[i]), x.name + ' top ' + i); assert.ok(O.feasible(x.inst, t.set)); });
    assert.strictEqual(b.res.complete, true);
    nodes += b.nSets;
  }
  const seen = new Set();   // every feasible set exactly once, in increasing-id order (one instance, explicitly)
  const x = CASES[2];
  O.bruteForce(x.inst, { onSet: ids => { assert.ok(ascending(ids) && O.feasible(x.inst, ids)); assert.ok(!seen.has(key(ids))); seen.add(key(ids)); } });
  assert.strictEqual(seen.size, brute(x).nSets);
  assert.strictEqual(O.bruteForce(CASES[4].inst, { nodeCap: 3 }).complete, brute(CASES[4]).nSets <= 3);
  return `${CASES.length} instances, ${nodes} feasible sets in total, largest ${Math.max(...CASES.map(c => brute(c).nSets))}`;
});
check('permutationSequences (analytic sum of |S|!) equals a real search over ordered sequences', () => {
  let n = 0, seqs = 0, sets = 0;
  for (const x of CASES) {
    const b = brute(x);
    if (b.nSets > 1500) continue;
    assert.strictEqual(b.res.permutationSequences, naivePermutationCount(x.inst), x.name);
    assert.strictEqual(b.res.stats.pruned.symmetry, b.res.permutationSequences - b.nSets);
    n++; seqs += b.res.permutationSequences; sets += b.nSets;
  }
  return `${n} instances: ${seqs} ordered sequences vs ${sets} sets (x${(seqs / sets).toFixed(1)})`;
});

// ---------- branch and bound ----------
check('branchAndBound value === bruteForce value (1e-9), set feasible, proven', () => {
  for (const x of CASES) {
    const b = brute(x), r = x.bb = O.branchAndBound(x.inst);
    assert.ok(close(r.value, b.opt), `${x.name}: B&B ${r.value} vs brute ${b.opt}`);
    assert.ok(O.feasible(x.inst, r.set), x.name + ': infeasible set');
    assert.ok(ascending(r.set), x.name + ': set not sorted');
    assert.ok(close(O.value(x.inst, r.set), r.value), x.name + ': reported value is not the value of the set');
    assert.strictEqual(r.proven, true);
    assert.ok(r.stats.explored <= b.nSets, x.name + ': explored more nodes than there are feasible sets');
  }
  return CASES.length + ' instances';
});
check('branchAndBound topN=5: the 5 best values equal the 5 best of brute force, sets distinct and feasible', () => {
  let withTies = 0;
  for (const x of CASES) {
    const b = brute(x), r = O.branchAndBound(x.inst, { topN: 5 });
    assert.strictEqual(r.top.length, Math.min(5, b.nSets), x.name + ': list length');
    r.top.forEach((t, i) => {
      assert.ok(close(t.value, b.top5[i]), `${x.name}: top[${i}] ${t.value} vs brute ${b.top5[i]}`);
      assert.ok(O.feasible(x.inst, t.set) && ascending(t.set), x.name);
      assert.ok(close(O.value(x.inst, t.set), t.value), x.name);
    });
    assert.strictEqual(new Set(r.top.map(t => key(t.set))).size, r.top.length, x.name + ': duplicate set in top');
    assert.ok(close(r.value, b.opt) && r.proven);
    if (r.top.length > 1 && close(r.top[0].value, r.top[1].value)) withTies++;
  }
  return `${CASES.length} instances, ${withTies} with a tie for first place`;
});
check('branchAndBound strict: optima lists ALL optimal feasible sets (count equals brute force)', () => {
  let total = 0;
  for (const x of CASES) {
    const b = brute(x), r = O.branchAndBound(x.inst, { strict: true });
    assert.ok(close(r.value, b.opt), x.name);
    assert.strictEqual(r.optima.length, b.nOptimal, x.name + ': number of optimal sets');
    assert.strictEqual(new Set(r.optima.map(o => key(o.set))).size, r.optima.length, x.name + ': duplicate optimum');
    for (const o of r.optima) assert.ok(O.feasible(x.inst, o.set) && close(o.value, b.opt), x.name);
    total += r.optima.length;
  }
  return total + ' optimal sets over ' + CASES.length + ' instances';
});
check('branchAndBound nodeCap: proven is false when the cap is hit, result never worse than the incumbent', () => {
  let capped = 0;
  for (const x of CASES) {
    const b = brute(x), g = O.greedy(x.inst), r = O.branchAndBound(x.inst, { nodeCap: 2 });
    assert.ok(r.stats.explored <= 2, x.name);
    assert.ok(r.value >= g.value - 1e-9 && r.value <= b.opt + 1e-9 * Math.max(1, b.opt), x.name);
    assert.ok(O.feasible(x.inst, r.set));
    if (!r.proven) capped++; else assert.ok(close(r.value, b.opt), x.name + ': proven but not optimal');
  }
  assert.ok(capped > 100);
  return `cap hit on ${capped} of ${CASES.length} (the others finished within 2 nodes and are optimal)`;
});
check('branchAndBound with a given incumbent (empty set, random set, the optimum, a result object)', () => {
  for (const x of CASES) {
    const b = brute(x);
    for (const inc of [[], randomFeasible(x.inst, 3), b.res.set, O.greedy(x.inst)]) {
      const r = O.branchAndBound(x.inst, { incumbent: inc, topN: 3 });
      assert.ok(close(r.value, b.opt) && r.proven, x.name);
      r.top.forEach((t, i) => assert.ok(close(t.value, b.top5[i]), x.name + ': top with incumbent'));
      assert.strictEqual(new Set(r.top.map(t => key(t.set))).size, r.top.length, x.name + ': incumbent recorded twice');
    }
  }
  const x = CASES[0], two = x.inst.cands.filter(c => c.op === x.inst.cands[0].op).map(c => c.id).slice(0, 2);
  if (two.length === 2) assert.throws(() => O.branchAndBound(x.inst, { incumbent: two }), /not a feasible set/);
});
check('branchAndBound statistics are consistent (symmetry count, incumbent, evals)', () => {
  for (const x of CASES) {
    const b = brute(x), r = x.bb;
    assert.strictEqual(r.permutationsAvoided, r.permutationSequences - r.stats.explored);
    assert.strictEqual(r.stats.pruned.symmetry, r.permutationsAvoided);
    assert.ok(r.permutationSequences <= b.res.permutationSequences && r.permutationsAvoided >= 0);
    assert.ok(close(r.stats.incumbent.value, O.greedy(x.inst).value) && r.stats.incumbent.from === 'greedy');
    assert.ok(r.stats.explored >= 1 && r.stats.evals >= x.inst.cands.length && r.stats.timeMs >= 0);
    for (const f of ['bound', 'dominance', 'symmetry', 'infeasible']) assert.ok(Number.isFinite(r.stats.pruned[f]) && r.stats.pruned[f] >= 0);
  }
});
check('branchAndBound: rounding-level ties do not defeat the bound (saturated real-valued instance, topN=5)', () => {
  // Thousands of sets kill everything here; their values agree only up to rounding. Before PRUNE_TOL existed
  // this search did not finish within 500000 nodes.
  const inst = O.randomInstance(1, { nE: 60, nOps: 12, nTiles: 20, K: 10, limit: 8, sparsity: 0.5, integer: false, hpMax: 100, potMax: 60 });
  const total = inst.hp.reduce((s, h, i) => s + inst.w[i] * h, 0), r = O.branchAndBound(inst, { topN: 5, nodeCap: 20000 });
  assert.strictEqual(r.proven, true);
  assert.strictEqual(r.top.length, 5);
  for (const t of r.top) assert.ok(close(t.value, total) && O.feasible(inst, t.set));
  return `${inst.cands.length} candidates, limit 8: proven after ${r.stats.explored} nodes`;
});
check('solve (safe dominance pruning + branch and bound) === brute force, also with an incumbent that uses removed candidates', () => {
  let removed = 0;
  for (const x of CASES) {
    const b = brute(x), r = O.solve(x.inst);
    assert.ok(close(r.value, b.opt) && r.proven && O.feasible(x.inst, r.set), x.name);
    for (const inc of [b.res.set, randomFeasible(x.inst, 9)]) {
      const r2 = O.solve(x.inst, { incumbent: inc });
      assert.ok(close(r2.value, b.opt) && r2.proven && O.feasible(x.inst, r2.set), x.name + ': solve with incumbent');
    }
    removed += r.stats.pruned.dominance;
  }
  return removed + ' candidates removed by dominance on the way';
});

// ---------- dominance ----------
check("dominancePrune 'safe' keeps the brute-force optimum; every removed candidate has a surviving dominator", () => {
  let removed = 0, all = 0, hit = 0;
  for (const x of CASES) {
    const d = O.dominancePrune(x.inst), kept = d.inst.cands;
    assert.ok(close(O.bruteForce(d.inst).value, brute(x).opt), x.name + ': optimum changed');
    assert.strictEqual(kept.length + d.removed, x.inst.cands.length);
    assert.strictEqual(d.removedIds.length, d.removed);
    assert.strictEqual(d.inst.limit, x.inst.limit); assert.strictEqual(d.inst.hp, x.inst.hp);
    for (const id of d.removedIds) {
      const p = x.inst.cands.find(c => c.id === id);
      assert.ok(kept.some(q => q.op === p.op && q.tile === p.tile && q.pot.every((v, i) => v >= p.pot[i])), x.name + ': removed without a surviving dominator');
    }
    for (const p of kept) for (const q of kept) if (p !== q && p.op === q.op && p.tile === q.tile) assert.ok(!q.pot.every((v, i) => v >= p.pot[i]), x.name + ': a dominated candidate survived');
    removed += d.removed; all += x.inst.cands.length; if (d.removed) hit++;
  }
  assert.ok(removed > 100);
  return `${removed} of ${all} candidates removed, on ${hit} instances`;
});
check("dominancePrune exchange(): the exchange argument as code keeps a set feasible and never lowers its value ('safe')", () => {
  let swapped = 0, sets = 0, gained = 0;
  for (const x of CASES) {
    const d = O.dominancePrune(x.inst), survivors = new Set(d.inst.cands.map(c => c.id));
    for (const set of [brute(x).res.set, randomFeasible(x.inst, 21), randomFeasible(x.inst, 22), randomFeasible(x.inst, 23)]) {
      const e = d.exchange(set), v0 = O.value(x.inst, set), v1 = O.value(x.inst, e);
      assert.ok(O.feasible(x.inst, e), x.name + ': exchange made the set infeasible');
      assert.ok(e.every(id => survivors.has(id)), x.name + ': exchange left a removed candidate in');
      assert.ok(v1 >= v0 - 1e-9 * Math.max(1, v0), x.name + ': exchange lowered the value');
      assert.strictEqual(e.length, set.length);
      sets++; if (key(e) !== key(set.slice().sort((a, b) => a - b))) swapped++; if (v1 > v0 + 1e-9) gained++;
    }
  }
  return `${sets} feasible sets, ${swapped} contained removed candidates, ${gained} got strictly better`;
});
check('dominancePrune: of two identical candidates (same operator, tile, pot) exactly one survives, the smaller id', () => {
  const inst = mk(2, [10, 10], [[7, 'A', 1, 'E', [3, 4]], [5, 'A', 1, 'S', [3, 4]], [9, 'A', 1, 'W', [3, 4]], [6, 'B', 1, 'E', [3, 4]], [8, 'A', 2, 'E', [3, 4]]]);
  const d = O.dominancePrune(inst);
  assert.deepStrictEqual(d.inst.cands.map(c => c.id).sort(), [5, 6, 8]);   // B on tile 1 and A on tile 2 are other groups
  assert.strictEqual(d.removed, 2);
  assert.strictEqual(d.dominatedBy.get(7), 5);
  assert.throws(() => O.dominancePrune(inst, { mode: 'nope' }), /unknown mode/);
});
check("dominancePrune 'aggressive' LOSES the optimum on a 4-candidate instance with a tile conflict (28 -> 20)", () => {
  // A is slightly better on t1 than on t2, B is only good on t1. Optimum: B on t1, A on t2.
  // Aggressive (same operator, any tile) keeps A@t1 and B@t1 only: they fight over t1.
  const inst = mk(2, [100, 100], [[0, 'A', 't1', 'E', [5, 5]], [1, 'A', 't2', 'E', [4, 4]], [2, 'B', 't1', 'E', [10, 10]], [3, 'B', 't2', 'E', [1, 1]]]);
  const full = O.bruteForce(inst), safe = O.dominancePrune(inst), agg = O.dominancePrune(inst, { mode: 'aggressive' });
  assert.deepStrictEqual(full.set, [1, 2]); assert.strictEqual(full.value, 28);
  assert.strictEqual(safe.removed, 0); assert.strictEqual(O.bruteForce(safe.inst).value, 28);
  assert.deepStrictEqual(agg.removedIds, [1, 3]);
  assert.strictEqual(O.bruteForce(agg.inst).value, 20);
  assert.strictEqual(O.branchAndBound(agg.inst).value, 20);
  assert.deepStrictEqual(agg.exchange([1, 2]), [0, 2]);       // where the proof breaks: the swap puts A and B on t1
  assert.strictEqual(O.feasible(inst, [0, 2]), false);
  let lost = 0, removedSafe = 0, removedAgg = 0;
  for (const x of CASES.slice(0, N_RANDOM)) {
    const a = O.dominancePrune(x.inst, { mode: 'aggressive' });
    removedAgg += a.removed; removedSafe += O.dominancePrune(x.inst).removed;
    const v = O.branchAndBound(a.inst).value;
    assert.ok(v <= brute(x).opt + 1e-9 * Math.max(1, brute(x).opt));
    if (!close(v, brute(x).opt)) lost++;
  }
  return `random suite: aggressive removes ${removedAgg} candidates (safe: ${removedSafe}) and loses the optimum on ${lost} of ${N_RANDOM} instances`;
});

// ---------- greedy, lazy greedy ----------
let ratioNote = '';
check('greedy: feasible, never below 1/3 of the optimum (the bound for 2 matroids)', () => {
  let min = 1, sum = 0, n = 0, optimal = 0, below = 0;
  for (const x of CASES) {
    const b = brute(x), g = x.greedy = O.greedy(x.inst);
    assert.ok(O.feasible(x.inst, g.set) && ascending(g.set), x.name);
    assert.ok(g.value <= b.opt + 1e-9 * Math.max(1, b.opt), x.name);
    assert.ok(g.value >= b.opt / 3 - 1e-9 * Math.max(1, b.opt), x.name + ': greedy below 1/3 of the optimum');
    if (b.opt > 0) { const r = g.value / b.opt; min = Math.min(min, r); sum += r; n++; if (close(g.value, b.opt)) optimal++; if (r < 1 - 1 / Math.E) below++; }
  }
  ratioNote = `greedy/optimum over ${n} instances with optimum > 0: min ${min.toFixed(4)}, mean ${(sum / n).toFixed(4)}, greedy optimal on ${optimal} (${pct(optimal / n)}), below 1-1/e=0.632 on ${below}`;
  assert.ok(below >= 1, 'the suite should contain an instance below 1 - 1/e (the comment at greedy() cites it)');
  return ratioNote;
});
check('greedy worst case: a 4-candidate instance where greedy gets exactly 1/3 of the optimum', () => {
  // g = (op0, tile0) takes operator 0 away from o1 and tile 0 away from o2, and kills the enemy o3 would kill.
  const inst = mk(3, [10, 10, 10], [[0, 'op0', 'tile0', 'E', [10, 0, 0]], [1, 'op0', 'tile1', 'E', [0, 10, 0]], [2, 'op1', 'tile0', 'E', [0, 0, 10]], [3, 'op2', 'tile2', 'E', [10, 0, 0]]]);
  const g = O.greedy(inst), b = O.bruteForce(inst), bb = O.branchAndBound(inst);
  assert.deepStrictEqual(g.set, [0]); assert.strictEqual(g.value, 10);
  assert.deepStrictEqual(b.set, [1, 2, 3]); assert.strictEqual(b.value, 30);
  assert.strictEqual(bb.value, 30);
  assert.deepStrictEqual(O.lazyGreedy(inst).set, [0]);
  // without relying on the id tie-break: make g strictly the best first pick
  const inst2 = mk(3, [11, 10, 10], [[0, 'op0', 'tile0', 'E', [11, 0, 0]], [1, 'op0', 'tile1', 'E', [0, 10, 0]], [2, 'op1', 'tile0', 'E', [0, 0, 10]], [3, 'op2', 'tile2', 'E', [10, 0, 0]]]);
  assert.strictEqual(O.greedy(inst2).value, 11); assert.strictEqual(O.bruteForce(inst2).value, 30);
  return `ratio ${g.value}/${b.value}; strict variant 11/30 = ${(11 / 30).toFixed(3)}`;
});
check('lazyGreedy set === greedy set (same tie-breaking), never more evaluations', () => {
  let eg = 0, el = 0;
  for (const x of CASES) {
    const g = x.greedy, l = O.lazyGreedy(x.inst);
    assert.deepStrictEqual(l.set, g.set, x.name + ': lazy greedy chose another set');
    assert.strictEqual(l.value, g.value);
    assert.strictEqual(l.stats.evalsGreedy, g.stats.evals, x.name + ': evalsGreedy is not what greedy really spent');
    assert.ok(l.stats.evals <= g.stats.evals, x.name);
    assert.strictEqual(l.stats.evalsSaved, g.stats.evals - l.stats.evals);
    eg += g.stats.evals; el += l.stats.evals;
  }
  return `evaluations: greedy ${eg}, lazy ${el}, saved ${pct(1 - el / eg)}`;
});

// ---------- beam, local search, simulated annealing ----------
check('beamSearch with a huge width === optimum; narrow beams are feasible and never above it', () => {
  let opt3 = 0, n = 0;
  for (const x of CASES) {
    const b = brute(x), wide = O.beamSearch(x.inst, 1e9);
    assert.ok(close(wide.value, b.opt), `${x.name}: beam(1e9) ${wide.value} vs ${b.opt}`);
    assert.ok(O.feasible(x.inst, wide.set) && ascending(wide.set));
    assert.strictEqual(wide.stats.pruned.beam, 0);
    assert.strictEqual(wide.stats.explored, b.nSets, x.name + ': the unbounded beam must hold every feasible set exactly once');
    assert.strictEqual(wide.stats.evals, b.nSets - 1, x.name + ': every non-empty set must be evaluated exactly once');
    assert.strictEqual(wide.stats.pruned.symmetry, b.extraParents, x.name + ': a set of size s is re-derived from each of its s parents, s - 1 of them merged by the key');
    for (const w of [1, 3]) {
      const r = O.beamSearch(x.inst, w);
      assert.ok(O.feasible(x.inst, r.set) && r.value <= b.opt + 1e-9 * Math.max(1, b.opt), x.name);
      assert.ok(close(O.value(x.inst, r.set), r.value));
      if (w === 3) { n++; if (close(r.value, b.opt)) opt3++; }
    }
  }
  return `width 3 already optimal on ${opt3} of ${n}`;
});
check('localSearch: never worsens, ends feasible, never above the optimum (from empty, random and greedy starts)', () => {
  let improved = 0, runs = 0, reachedOpt = 0;
  const moves = { add: 0, replace: 0, swap: 0 };
  for (const x of CASES) {
    const b = brute(x);
    for (const start of [[], randomFeasible(x.inst, 1), randomFeasible(x.inst, 2), x.greedy.set]) {
      const v0 = O.value(x.inst, start), r = O.localSearch(x.inst, start);
      assert.ok(O.feasible(x.inst, r.set) && ascending(r.set), x.name + ': infeasible end');
      assert.ok(r.value >= v0 - 1e-9 * Math.max(1, v0), x.name + ': local search made it worse');
      assert.ok(r.value <= b.opt + 1e-9 * Math.max(1, b.opt), x.name);
      runs++; if (r.value > v0 + 1e-9) improved++; if (close(r.value, b.opt)) reachedOpt++;
      for (const m in moves) moves[m] += r.stats.moves[m];
    }
    for (const mv of [['add'], ['replace'], ['swap']]) {   // each neighbourhood alone
      const start = randomFeasible(x.inst, 4), r = O.localSearch(x.inst, start, { moves: mv });
      assert.ok(O.feasible(x.inst, r.set) && r.value >= O.value(x.inst, start) - 1e-9 * Math.max(1, r.value), x.name);
    }
  }
  assert.throws(() => O.localSearch(CASES[0].inst, [CASES[0].inst.cands[0].id, CASES[0].inst.cands[0].id]), /not feasible/);
  return `${runs} runs, improved ${improved}, ended at the optimum ${reachedOpt}; moves taken: add ${moves.add}, replace ${moves.replace}, swap ${moves.swap}`;
});
check("localSearch 'swap' escapes a local optimum that 'add' and 'replace' cannot leave", () => {
  const inst = mk(2, [10, 10], [[0, 'A', 't1', 'E', [1, 0]], [1, 'B', 't2', 'E', [0, 1]], [2, 'A', 't2', 'E', [5, 0]], [3, 'B', 't1', 'E', [0, 5]]]);
  const stuck = O.localSearch(inst, [0, 1], { moves: ['add', 'replace'] }), free = O.localSearch(inst, [0, 1]);
  assert.deepStrictEqual(stuck.set, [0, 1]); assert.strictEqual(stuck.value, 2);
  assert.deepStrictEqual(free.set, [2, 3]); assert.strictEqual(free.value, 10);
  assert.strictEqual(free.stats.moves.swap, 1);
});
check('simulatedAnnealing: feasible, never worse than the start, never above the optimum, deterministic per seed', () => {
  let reachedOpt = 0, runs = 0, worse = 0;
  for (const x of CASES) {
    const b = brute(x);
    for (const start of [[], x.greedy.set]) {
      const v0 = O.value(x.inst, start), r = O.simulatedAnnealing(x.inst, start, { seed: 7, steps: 300 });
      assert.ok(O.feasible(x.inst, r.set) && ascending(r.set), x.name);
      assert.ok(r.value >= v0 - 1e-9 * Math.max(1, v0), x.name + ': annealing returned something worse than its start');
      assert.ok(r.value <= b.opt + 1e-9 * Math.max(1, b.opt), x.name);
      runs++; if (close(r.value, b.opt)) reachedOpt++; worse += r.stats.worseAccepted;
    }
    const a = O.simulatedAnnealing(x.inst, [], { seed: 3, steps: 100 }), a2 = O.simulatedAnnealing(x.inst, [], { seed: 3, steps: 100 });
    assert.deepStrictEqual(a.set, a2.set); assert.strictEqual(a.stats.accepted, a2.stats.accepted);
  }
  assert.ok(worse > 0, 'annealing never accepted a worse neighbour: the temperature does nothing');
  return `${runs} runs of 300 steps, at the optimum on ${reachedOpt} (${pct(reachedOpt / runs)}), ${worse} downhill moves accepted`;
});

// ---------- knapsack ----------
check('knapsack01 === knapsackBrute on 200 random cases (value, budget, item limit, reconstruction)', () => {
  const r = O.mulberry32(2024), int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  let limited = 0, bound = 0;
  for (let t = 0; t < 200; t++) {
    const n = int(0, 12), real = r() < 0.3;
    const items = Array.from({ length: n }, () => ({ cost: int(0, 12), value: real ? r() * 20 : int(0, 20) }));
    const budget = int(0, 40), limit = r() < 0.2 ? Infinity : int(0, n + 1);
    const a = O.knapsack01(items, budget, limit), b = O.knapsackBrute(items, budget, limit);
    assert.ok(close(a.value, b.value), `case ${t}: DP ${a.value} vs brute ${b.value}`);
    assert.ok(a.chosen.every((i, j) => Number.isInteger(i) && i >= 0 && i < n && (j === 0 || a.chosen[j - 1] < i)), 'chosen must be ascending item indices');
    const cost = a.chosen.reduce((s, i) => s + items[i].cost, 0), val = a.chosen.reduce((s, i) => s + items[i].value, 0);
    assert.ok(cost <= budget && a.chosen.length <= limit, `case ${t}: reconstruction breaks a constraint`);
    assert.ok(close(val, a.value), `case ${t}: reconstructed items are worth ${val}, reported ${a.value}`);
    assert.strictEqual(a.cost, cost);
    if (limit < n) limited++;
    const free = O.knapsackBrute(items, Infinity, Infinity).value;
    if (a.value < free - 1e-9) bound++;
  }
  assert.deepStrictEqual(O.knapsack01([{ cost: 3, value: 5 }], 2), { chosen: [], value: 0, cost: 0 });
  assert.deepStrictEqual(O.knapsack01([{ cost: 3, value: 5 }, { cost: 2, value: 4 }, { cost: 1, value: 4 }], 3, 2), { chosen: [1, 2], value: 8, cost: 3 });
  assert.deepStrictEqual(O.knapsack01([{ cost: 3, value: 5 }, { cost: 2, value: 4 }, { cost: 1, value: 4 }], 3, 1), { chosen: [0], value: 5, cost: 3 });
  assert.deepStrictEqual(O.knapsack01([{ cost: 3, value: 5 }, { cost: 2, value: 4 }], Infinity), { chosen: [0, 1], value: 9, cost: 5 });
  assert.throws(() => O.knapsack01([{ cost: 1.5, value: 1 }], 3), /integers/);
  return `${limited} cases with a binding item limit, ${bound} where budget or limit costs value`;
});

// ---------- the properties everything rests on ----------
check('checkSubmodular: 0 violations of submodularity and monotonicity on every instance', () => {
  let trials = 0;
  for (const x of CASES) {
    const c = O.checkSubmodular(x.inst, 40, 1 + trials);
    assert.strictEqual(c.violations, 0, `${x.name}: ${c.submodular} submodularity and ${c.monotone} monotonicity violations, worst ${c.worst}`);
    trials += c.trials;
  }
  return trials + ' random (A subset of B, x) triples';
});
check('checkSubmodular does detect broken instances (negative pot => not monotone, and not submodular)', () => {
  const inst = O.randomInstance(5, { nE: 4, nOps: 3, K: 2, sparsity: 0 });
  inst.cands[0].pot[0] = -50;
  const c = O.checkSubmodular(inst, 200, 1);
  assert.ok(c.monotone > 0 && c.violations > 0 && c.worst > 0);
  // x = +10, y = -10, z = +10 on one enemy with 10 HP: x gains 0 on top of {z} but 10 on top of {z, y}
  const c2 = O.checkSubmodular(mk(3, [10], [[0, 'a', 0, 'E', [10]], [1, 'b', 1, 'E', [-10]], [2, 'c', 2, 'E', [10]]]), 300, 1);
  assert.ok(c2.submodular > 0, 'the submodularity test is blind');
  assert.strictEqual(c2.violations, c2.submodular + c2.monotone);
  return `${c.monotone} monotonicity violations on the first, ${c2.submodular} submodularity violations on the second`;
});

// ---------- measurements asked for ----------
check('REPORT empirical greedy/optimum ratio', () => ratioNote);
check('REPORT fraction of nodes branch and bound explores vs brute force', () => {
  let sumFrac = 0, bbNodes = 0, bruteNodes = 0, n = 0, maxFrac = 0, bound = 0, bbEvals = 0, bruteEvals = 0;
  for (const x of CASES) {
    const b = brute(x), r = x.bb, f = r.stats.explored / b.nSets;
    sumFrac += f; maxFrac = Math.max(maxFrac, f); bbNodes += r.stats.explored; bruteNodes += b.nSets; bound += r.stats.pruned.bound;
    bbEvals += r.stats.evals; bruteEvals += b.res.stats.evals; n++;
  }
  assert.ok(bbNodes < bruteNodes);
  const hard = CASES.slice(HARD_FROM), hb = hard.reduce((s, x) => s + x.bb.stats.explored, 0), hs = hard.reduce((s, x) => s + brute(x).nSets, 0);
  const hardWrong = hard.filter(x => !close(x.greedy.value, brute(x).opt)).length;
  return `mean per-instance fraction ${pct(sumFrac / n)} (max ${pct(maxFrac)}); in total ${bbNodes} of ${bruteNodes} nodes = ${pct(bbNodes / bruteNodes)}; ` +
    `${bound} subtrees cut by the bound; gain evaluations ${bbEvals} vs ${bruteEvals} = ${pct(bbEvals / bruteEvals)}; ` +
    `hard family alone (${hard.length} instances, greedy not optimal on ${hardWrong}): ${hb} of ${hs} nodes = ${pct(hb / hs)}`;
});
check('REPORT a larger instance (96 candidates, 40 enemies, limit 6; no brute force possible)', () => {
  const inst = O.randomInstance(1, { nE: 40, nOps: 12, nTiles: 30, K: 8, limit: 6, sparsity: 0.5, integer: false, hpMax: 120, potMax: 60, weights: true });
  const g = O.greedy(inst), l = O.lazyGreedy(inst), d = O.dominancePrune(inst);
  const bb = O.branchAndBound(d.inst, { nodeCap: 300000 }), beam = O.beamSearch(inst, 32), ls = O.localSearch(inst, g.set), sa = O.simulatedAnnealing(inst, g.set, { seed: 1, steps: 4000 });
  assert.deepStrictEqual(l.set, g.set);
  for (const r of [g, bb, beam, ls, sa]) assert.ok(O.feasible(inst, r.set));
  assert.ok(bb.value >= g.value - 1e-9 && ls.value >= g.value - 1e-9 && sa.value >= g.value - 1e-9);
  if (bb.proven) for (const r of [g, beam, ls, sa]) assert.ok(r.value <= bb.value + 1e-9 * bb.value, 'a heuristic beat a proven optimum');
  const rel = r => (r.value / bb.value).toFixed(4);
  return `dominance removed ${d.removed}; B&B ${bb.proven ? 'PROVEN optimal' : 'NOT proven (node cap)'} value ${bb.value.toFixed(2)} after ${bb.stats.explored} nodes, ${bb.stats.pruned.bound} bound cuts, ${Math.round(bb.stats.timeMs)} ms, ` +
    `${bb.permutationsAvoided} ordered sequences avoided; relative to it: greedy ${rel(g)}, beam(32) ${rel(beam)}, local search ${rel(ls)}, annealing ${rel(sa)}; lazy greedy saved ${pct(l.stats.evalsSaved / l.stats.evalsGreedy)} of greedy's evaluations`;
});

console.log(`\n${passed} checks passed, ${failed} failed`);
if (failed) process.exit(1);
