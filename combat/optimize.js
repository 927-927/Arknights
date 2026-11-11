'use strict';
// optimize.js: PURE search algorithms on the "placement instance" of combat/CONTRACT.md section 7.
// Knows nothing about the game and requires no other project module.
//
//   inst = { limit, hp: Float64Array(nE), w: Float64Array(nE),
//            cands: [ { id, op, tile, dir, cost, pot: Float64Array(nE) } ] }
//   value(S)    = sum_i w[i] * min(hp[i], sum_{p in S} pot[p][i])     (damage beyond an enemy's HP is wasted)
//   feasible(S) = each operator at most once, each tile at most once, |S| <= limit
//
// Two properties of value() carry every algorithm below (checkSubmodular tests them numerically):
//   monotone:   adding a candidate never lowers the value (hp, w and pot are all >= 0; prepare() enforces it);
//   submodular: the gain of adding x to a set only SHRINKS as the set grows (diminishing returns: the more
//               damage an enemy already takes, the more of x's damage is overkill). Each term is min(const, .)
//               of a non-negative additive function, i.e. concave-of-modular, and such sums are submodular.
//
// Conventions. A "set" is an array of candidate ids. Every search returns
//   { set (ids, ascending in byId order: numbers first, then strings), value, stats: { explored, pruned: {bound, dominance, symmetry, infeasible}, evals, timeMs } }
// explored = search nodes (candidate sets) visited; evals = marginal-gain evaluations (one scan of one pot
// vector each); value is always recomputed from the definition for the returned set. Instances are immutable.
//
// Reading order for teaching: value/feasible -> gain/place (incremental evaluation) -> greedy -> Heap ->
// lazyGreedy -> bruteForce -> branchAndBound -> dominancePrune -> beamSearch -> localSearch ->
// simulatedAnnealing -> knapsack01 -> checkSubmodular.

const EPS = 1e-9;            // relative tolerance when two values are compared "as equal" (strict mode, checks)
const PRUNE_TOL = 1e-12;     // branch and bound: a bound within this (relative) of the value to beat counts as "not better".
                             // The same real number summed in two orders differs by ~1e-16; without this, such ties are never cut.
const IMPROVE_TOL = 1e-12;   // local search: a move must improve by more than this (relative), so rounding noise never counts as progress
// ASSUMPTION: the default search-effort knobs below are untuned starting points, not calibrated on real stages.
const NODE_CAP_DEFAULT = 200000;    // branch and bound gives up (proven: false) after this many nodes; pass nodeCap: Infinity to insist
const BEAM_WIDTH_DEFAULT = 8;
const SA_STEPS_DEFAULT = 2000;
const SA_COOLING_DEFAULT = 0.995;   // geometric cooling: T_k = T0 * cooling^k
const SA_T0_FACTOR = 0.25;          // default T0 = this * mean solo value of a candidate

const now = () => performance.now();
// The id order. Ids may be numbers or strings (CONTRACT 10), even mixed in one instance, so the order must be
// TOTAL across both types: with plain `<`, 'a' vs 5 is "equal" both ways, the (gain, id) tie-break stops being
// an order and greedy / lazyGreedy can pick different members among tied gains. Every number comes before every
// string ('number' < 'string'); numbers compare numerically, strings by UTF-16 code units. prepare() and
// dominancePrune() reject any other id (NaN included: it is unordered even among numbers).
const byId = (a, b) => { const ta = typeof a, tb = typeof b; return ta !== tb ? (ta < tb ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0; };
const bySet = (a, b) => {   // two id lists sorted by byId: lexicographic, a prefix first. Total, like byId.
  for (let i = 0; i < a.length && i < b.length; i++) { const d = byId(a[i], b[i]); if (d) return d; }
  return a.length - b.length;
};
const checkId = id => {
  if (typeof id !== 'string' && (typeof id !== 'number' || Number.isNaN(id))) throw new Error('optimize: candidate id must be a number (not NaN) or a string, got ' + String(id));
};
const tol = v => EPS * Math.max(1, Math.abs(v));
const mkStats = () => ({ explored: 0, pruned: { bound: 0, dominance: 0, symmetry: 0, infeasible: 0 }, evals: 0, timeMs: 0 });

// ---------------------------------------------------------------------------------------------------------
// 0. Definition, incremental evaluation, random instances
// ---------------------------------------------------------------------------------------------------------

// Seeded PRNG (mulberry32): 32-bit state, returns floats in [0, 1). Same seed => same sequence, everywhere.
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BY_ID = new WeakMap();   // cands array -> Map(id -> candidate); rebuilt if the array length changed
function candById(inst) {
  let m = BY_ID.get(inst.cands);
  if (!m || m.size !== inst.cands.length) { m = new Map(inst.cands.map(c => [c.id, c])); BY_ID.set(inst.cands, m); }
  return m;
}

// value(inst, set): the objective, straight from the definition. O(|set| * nE). Reference implementation:
// the searches never call it in an inner loop (they use gain/place below), only once for the set they return.
function value(inst, set) {
  const { hp, w } = inst, nE = hp.length, cand = candById(inst), dmg = new Float64Array(nE);
  for (const id of set) {
    const c = cand.get(id);
    if (!c) throw new Error('optimize: unknown candidate id ' + id);
    for (let i = 0; i < nE; i++) dmg[i] += c.pot[i];
  }
  let v = 0;
  for (let i = 0; i < nE; i++) v += (w ? w[i] : 1) * Math.min(hp[i], dmg[i]);
  return v;
}

// feasible(inst, set): one candidate per operator, one per tile, at most `limit` candidates. O(|set|).
function feasible(inst, set) {
  if (!(set.length <= inst.limit)) return false;
  const cand = candById(inst), ops = new Set(), tiles = new Set();
  for (const id of set) {
    const c = cand.get(id);
    if (!c || ops.has(c.op) || tiles.has(c.tile)) return false;
    ops.add(c.op); tiles.add(c.tile);
  }
  return true;
}

// prepare(inst) -> P: the instance in search-friendly form. Candidates are addressed by their INDEX k in
// inst.cands (P.ids[k] maps back to the id, P.index.get(id) forward); operators and tiles are renumbered
// 0..nOp-1 / 0..nTile-1 so "is it used" is one array lookup; pot vectors are stored sparsely (zeros skipped).
// Also validates the domain the proofs need: hp, w, pot >= 0. O(n * nE).
function prepare(inst) {
  const { cands, hp } = inst, n = cands.length, nE = hp.length, w = inst.w || new Float64Array(nE).fill(1);
  if (w.length !== nE) throw new Error('optimize: w has ' + w.length + ' entries, hp has ' + nE);
  let total = 0;   // value of "every enemy dead": no set can be worth more
  for (let i = 0; i < nE; i++) {
    if (!(hp[i] >= 0) || !(w[i] >= 0)) throw new Error('optimize: hp and w must be >= 0 (enemy ' + i + ')');
    total += w[i] * hp[i];
  }
  const ids = new Array(n), index = new Map(), opNo = new Map(), tileNo = new Map();
  const opOf = new Int32Array(n), tileOf = new Int32Array(n), nz = new Array(n), pv = new Array(n);
  for (let k = 0; k < n; k++) {
    const c = cands[k], I = [], V = [];
    checkId(c.id);
    if (index.has(c.id)) throw new Error('optimize: duplicate candidate id ' + c.id);
    if (!c.pot || c.pot.length !== nE) throw new Error('optimize: candidate ' + c.id + ' has ' + (c.pot ? c.pot.length : 0) + ' pot entries, expected ' + nE);
    index.set(c.id, k); ids[k] = c.id;
    if (!opNo.has(c.op)) opNo.set(c.op, opNo.size);
    if (!tileNo.has(c.tile)) tileNo.set(c.tile, tileNo.size);
    opOf[k] = opNo.get(c.op); tileOf[k] = tileNo.get(c.tile);
    for (let i = 0; i < nE; i++) {
      const p = c.pot[i];
      if (!(p >= 0)) throw new Error('optimize: pot must be >= 0 (candidate ' + c.id + ', enemy ' + i + ')');
      if (p > 0 && w[i] > 0 && hp[i] > 0) { I.push(i); V.push(p); }
    }
    nz[k] = Int32Array.from(I); pv[k] = Float64Array.from(V);
  }
  const limit = inst.limit >= 0 ? Math.min(n, Math.floor(inst.limit)) : 0;
  return { inst, n, nE, hp, w, total, limit, ids, index, opOf, tileOf, nOp: opNo.size, nTile: tileNo.size, nz, pv };
}

// Incremental evaluation. The state of a partial set S is ONE array: left[i] = HP of enemy i that S has not
// removed yet = hp[i] - min(hp[i], damage so far on i). ("Damage so far" is hp - left; storing the complement
// makes both operations one min each and keeps them exactly monotone in floating point: `left` only goes down,
// so a gain computed earlier is always >= the gain computed now. lazyGreedy and the B&B bound rely on that.)
//   newLeft(P)             the empty set: nothing removed yet
//   gain(P, left, k)       value(S + k) - value(S), in O(nonzeros of pot[k]) instead of O(|S| * nE)
//   place(P, left, k, out) adds candidate k: writes the new state to `out` (default: in place) and returns it
//   damageSoFar(P, left)   the per-enemy damage that counts (capped at hp), for display
// There is deliberately no "unplace": subtracting again would accumulate rounding error over millions of
// nodes. The tree searches keep one `left` array per depth instead (copy on descend, nothing to undo).
const newLeft = P => Float64Array.from(P.hp);
const damageSoFar = (P, left) => P.hp.map((h, i) => h - left[i]);
function gain(P, left, k) {
  const I = P.nz[k], V = P.pv[k], w = P.w;
  let g = 0;
  for (let j = 0; j < I.length; j++) { const i = I[j], l = left[i]; g += w[i] * (V[j] < l ? V[j] : l); }
  return g;
}
function place(P, left, k, out = left) {
  if (out !== left) out.set(left);
  const I = P.nz[k], V = P.pv[k];
  for (let j = 0; j < I.length; j++) { const i = I[j], l = left[i]; out[i] = V[j] < l ? l - V[j] : 0; }
  return out;
}

// Common exit: indices -> sorted ids, value recomputed from the definition, timer stopped.
function result(P, S, stats, t0, extra) {
  const set = S.map(k => P.ids[k]).sort(byId);
  stats.timeMs = now() - t0;
  return Object.assign({ set, value: value(P.inst, set), stats }, extra);
}

// randomInstance(seed, opts): a seeded random placement instance for tests and teaching.
//   nE enemies, nOps operators with K candidates each on nTiles tiles (few tiles => tile conflicts),
//   sparsity = probability that a pot entry is 0, ties = draw amounts from 3 levels and copy whole pot
//   vectors now and then (equal values, identical candidates), integer = integer amounts (exact arithmetic),
//   weights = non-uniform w, scramble = shuffle the candidate order and give non-contiguous ids.
// A candidate often shares its tile with the previous candidate of the same operator (another facing), and
// such a twin is often a weakened copy: that is the pattern dominancePrune removes.
function randomInstance(seed, opts = {}) {
  const { nE = 6, nOps = 4, nTiles = 6, K = 3, limit = 3, ties = false, sparsity = 0.4, integer = true,
    hpMax = 30, potMax = 12, weights = false, scramble = false } = opts;
  const rnd = mulberry32(seed), int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const DIRS = ['E', 'S', 'W', 'N'], T = Math.max(1, nTiles);
  const amount = max => ties ? Math.max(1, Math.round(max / 3)) * int(1, 3) : integer ? int(1, Math.max(1, Math.floor(max))) : 1e-3 + rnd() * max;
  const hp = new Float64Array(nE), w = new Float64Array(nE);
  for (let i = 0; i < nE; i++) { hp[i] = amount(hpMax); w[i] = !weights ? 1 : ties || integer ? int(1, 3) : 0.5 + 2.5 * rnd(); }
  const cands = [];
  for (let op = 0; op < nOps; op++) {
    const cost = int(5, 25), facings = new Map();   // tile -> facings this operator already has there
    let prev = null;
    for (let j = 0; j < K; j++) {
      let tile = prev && rnd() < 0.35 ? prev.tile : int(0, T - 1);
      if ((facings.get(tile) || []).length === 4) tile = int(0, T - 1);
      const taken = facings.get(tile) || [], twin = prev && tile === prev.tile;
      const dir = DIRS.find(d => !taken.includes(d)) || DIRS[int(0, 3)];
      facings.set(tile, taken.concat(dir));
      const pot = new Float64Array(nE);
      if (twin && rnd() < 0.6) { for (let i = 0; i < nE; i++) pot[i] = rnd() < 0.6 ? prev.pot[i] : 0; }   // weaker facing
      else if (ties && cands.length && rnd() < 0.25) pot.set(cands[int(0, cands.length - 1)].pot);          // exact copy
      else for (let i = 0; i < nE; i++) if (rnd() >= sparsity) pot[i] = amount(potMax);
      prev = { id: cands.length, op, tile, dir, cost, pot };
      cands.push(prev);
    }
  }
  if (scramble) {
    for (let i = cands.length - 1; i > 0; i--) { const j = int(0, i), t = cands[i]; cands[i] = cands[j]; cands[j] = t; }   // Fisher-Yates
    const perm = cands.map((_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) { const j = int(0, i), t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
    cands.forEach((c, i) => { c.id = 10 + 3 * perm[i]; });
  }
  return { limit, hp, w, cands };
}

// ---------------------------------------------------------------------------------------------------------
// 1. Dominance pruning
// ---------------------------------------------------------------------------------------------------------

// DOMINANCE PRUNING (Pareto filter inside a group). q dominates p when q is at least as good against every
// enemy (pot[q][i] >= pot[p][i] for all i) and costs no more; two identical candidates are ordered by id so
// exactly one of them survives. (cost is not part of value(), and candidates of one operator normally share
// its cost; the cost condition only keeps a cheaper deploy alive for timeline.js if a caller ever differs.)
//
// mode 'safe' (default): only candidates of the SAME operator on the SAME tile (different facings) compete.
//   Guarantee: the optimum value is unchanged. Proof (exchange argument). Take any feasible set S that
//   contains a dominated p and let q be a surviving dominator of p (same operator, same tile).
//     - q is not in S: S already holds p, and an operator appears at most once.
//     - S' = S - p + q is feasible: q uses exactly the operator and the tile that removing p freed, and
//       |S'| = |S|.
//     - value(S') >= value(S): every enemy's damage sum can only go up (pot[q] >= pot[p]) and min(hp, .) is
//       non-decreasing, weights are >= 0.
//   Apply the swap to every dominated member of an optimal set: the result is an optimal set made only of
//   survivors. "Dominates" is a strict partial order (transitive, and the id tie-break makes it irreflexive),
//   so every removed candidate has a SURVIVING dominator and all dominated candidates can go at once.
//   What is not preserved: runner-up sets that differ only by a worse facing (matters for topN lists only).
//
// mode 'aggressive': same operator, ANY tile. A HEURISTIC that CAN LOSE THE OPTIMUM: the exchange argument
//   breaks at "S' is feasible", because q's tile may already be taken by another operator in S, and that
//   operator may have nowhere else to go. test_optimize.js holds a 4-candidate counterexample (28 -> 20).
//
// Complexity: O(sum over groups of g^2 * nE) for group size g (4 facings per group in safe mode).
// Returns { inst: the pruned instance (same hp/w, surviving candidates, ids unchanged), removed, removedIds,
// dominatedBy: Map(removed id -> an id that dominates it), exchange(set), mode, stats }. exchange(set) is the
// proof as code: it swaps every removed member of a set for its surviving dominator. In safe mode the result
// is feasible whenever the input was and is worth at least as much; in aggressive mode it may be infeasible.
function dominancePrune(inst, { mode = 'safe' } = {}) {
  if (mode !== 'safe' && mode !== 'aggressive') throw new Error('dominancePrune: unknown mode ' + mode);
  const t0 = now(), stats = mkStats(), nE = inst.hp.length, groups = new Map();
  for (const c of inst.cands) {
    checkId(c.id);   // the twin tie-break below needs the total id order
    const key = JSON.stringify(mode === 'safe' ? [c.op, c.tile] : [c.op]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const cost = c => c.cost || 0;
  const dominates = (q, p) => {
    if (cost(q) > cost(p)) return false;
    let better = cost(q) < cost(p);
    for (let i = 0; i < nE; i++) { if (q.pot[i] < p.pot[i]) return false; if (q.pot[i] > p.pot[i]) better = true; }
    return better || byId(q.id, p.id) < 0;   // identical twins: the smaller id survives
  };
  const dominatedBy = new Map();   // removed id -> id of one candidate that dominates it
  for (const g of groups.values()) for (const p of g) for (const q of g) {
    if (q === p) continue;
    stats.evals++;
    if (dominates(q, p)) { dominatedBy.set(p.id, q.id); break; }
  }
  const kept = inst.cands.filter(c => !dominatedBy.has(c.id));
  const survivor = id => { while (dominatedBy.has(id)) id = dominatedBy.get(id); return id; };   // climbs the partial order: terminates
  const exchange = set => set.map(survivor).sort(byId);
  stats.pruned.dominance = dominatedBy.size; stats.explored = inst.cands.length; stats.timeMs = now() - t0;
  return { inst: Object.assign({}, inst, { cands: kept }), removed: dominatedBy.size, removedIds: [...dominatedBy.keys()].sort(byId), dominatedBy, exchange, mode, stats };
}

// ---------------------------------------------------------------------------------------------------------
// 2. Greedy          3. Lazy greedy (with the binary heap it needs)
// ---------------------------------------------------------------------------------------------------------

// GREEDY (marginal-gain greedy): repeatedly add the feasible candidate with the largest gain; ties go to the
// smaller id; stop at `limit` or when nothing feasible still gains (a zero gain stays zero forever by
// submodularity, so stopping there loses nothing).
// Guarantee, stated carefully:
//  * The famous (1 - 1/e) ~ 0.632 [Nemhauser, Wolsey, Fisher 1978, "An analysis of approximations for
//    maximizing submodular set functions - I", Mathematical Programming 14] is for a monotone submodular
//    function under a PURE CARDINALITY constraint |S| <= k. It applies here only when no two candidates can
//    clash (every candidate has its own operator and its own tile).
//  * Here the constraints are: one candidate per operator (a partition matroid), one per tile (a second
//    partition matroid) and |S| <= limit (a uniform matroid). For an intersection of k matroids plain greedy
//    guarantees 1/(k+1) [Fisher, Nemhauser, Wolsey 1978, "... - II", Mathematical Programming Study 8].
//    Counted naively that is k = 3, so 1/4. But truncating a matroid to rank `limit` leaves a matroid, so the
//    cardinality limit folds into the operator matroid: the feasible sets are an intersection of k = 2
//    matroids (they are exactly the matchings with at most `limit` edges in the bipartite operator-tile
//    graph whose edges are the candidates), and the guarantee that applies is 1/3:
//        value(greedy) >= value(optimum) / 3.
//  * 1/3 is attained: test_optimize.js builds a 4-candidate instance of this very problem where greedy gets
//    exactly a third of the optimum. Random instances are far kinder (the tests print the measured ratio:
//    mean above 0.99), yet the worst random instance of the suite sits at 0.615, below 1 - 1/e: the
//    cardinality bound really does not carry over.
// Complexity: O(limit * n) gain evaluations, each O(nonzeros of one pot vector).
function greedy(inst) {
  const t0 = now(), P = prepare(inst), stats = mkStats(), left = newLeft(P), S = [];
  const opUsed = new Uint8Array(P.nOp), tileUsed = new Uint8Array(P.nTile);
  while (S.length < P.limit) {
    let best = -1, bestGain = 0;
    for (let k = 0; k < P.n; k++) {
      if (opUsed[P.opOf[k]] || tileUsed[P.tileOf[k]]) { stats.pruned.infeasible++; continue; }
      const g = gain(P, left, k); stats.evals++;
      if (g > bestGain || (g === bestGain && best >= 0 && byId(P.ids[k], P.ids[best]) < 0)) { best = k; bestGain = g; }
    }
    if (best < 0) break;   // nothing feasible has a positive gain
    place(P, left, best); S.push(best); opUsed[P.opOf[best]] = 1; tileUsed[P.tileOf[best]] = 1;
  }
  stats.explored = S.length + 1;   // the sets on the greedy path, the empty set included
  return result(P, S, stats, t0);
}

// BINARY HEAP on an array (children of slot i are 2i+1 and 2i+2). `before(x, y)` says x must leave before y:
// a max-heap with (x, y) => x.key > y.key, a min-heap with <. push and pop are O(log n), peek is O(1).
class Heap {
  constructor(before) { this.a = []; this.before = before; }
  get size() { return this.a.length; }
  peek() { return this.a[0]; }
  push(x) {   // sift up: move the hole towards the root while x beats the parent
    const a = this.a;
    let i = a.length;
    a.push(x);
    while (i > 0) { const p = (i - 1) >> 1; if (!this.before(x, a[p])) break; a[i] = a[p]; i = p; }
    a[i] = x;
  }
  pop() {     // take the root, then sift the last element down from the root
    const a = this.a, top = a[0], x = a.pop(), n = a.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.before(a[c + 1], a[c])) c++;
        if (!this.before(a[c], x)) break;
        a[i] = a[c]; i = c;
      }
      a[i] = x;
    }
    return top;
  }
}

// LAZY GREEDY (Minoux 1978, "accelerated greedy"). Same answer as greedy, fewer evaluations.
// Idea: by submodularity a gain computed in an earlier round is an UPPER BOUND on today's gain. Keep all
// candidates in a max-heap keyed by their last known ("stale") gain. Pop the top: if its gain was computed in
// this round it is the true maximum (everything below it is bounded by a stale gain that is already smaller)
// and it is taken; otherwise recompute just that one and push it back.
// Guarantee: returns exactly the set greedy returns. The heap orders by (gain descending, id ascending), the
// same tie-break as greedy, and a fresh top beats every other candidate's true gain under that order. (This
// needs byId to be a TOTAL order, mixed number/string ids included: see byId.)
// Complexity: worst case the same O(limit * n) evaluations as greedy plus O(log n) per heap operation; in
// practice far fewer. stats.evalsGreedy = what plain greedy would have spent, stats.evalsSaved = the difference.
function lazyGreedy(inst) {
  const t0 = now(), P = prepare(inst), stats = mkStats(), left = newLeft(P), S = [];
  const opUsed = new Uint8Array(P.nOp), tileUsed = new Uint8Array(P.nTile);
  const blocked = k => opUsed[P.opOf[k]] || tileUsed[P.tileOf[k]];
  const heap = new Heap((a, b) => a.gain > b.gain || (a.gain === b.gain && byId(a.id, b.id) < 0));
  let evalsGreedy = 0;   // plain greedy re-evaluates every still-feasible candidate at the start of each round
  if (P.limit > 0) {
    for (let k = 0; k < P.n; k++) { heap.push({ k, id: P.ids[k], gain: gain(P, left, k), round: 0 }); stats.evals++; }
    evalsGreedy = P.n;
  }
  while (S.length < P.limit && heap.size) {
    const e = heap.pop();
    if (blocked(e.k)) { stats.pruned.infeasible++; continue; }   // S only grows, so it stays blocked: drop for good
    if (e.round < S.length) {                                    // stale: refresh this one candidate only
      e.gain = gain(P, left, e.k); e.round = S.length; stats.evals++;
      heap.push(e);
      continue;
    }
    if (e.gain <= 0) break;                                      // fresh maximum is 0: nothing gains any more
    place(P, left, e.k); S.push(e.k); opUsed[P.opOf[e.k]] = 1; tileUsed[P.tileOf[e.k]] = 1;
    if (S.length < P.limit) for (let k = 0; k < P.n; k++) if (!blocked(k)) evalsGreedy++;
  }
  stats.explored = S.length + 1; stats.evalsGreedy = evalsGreedy; stats.evalsSaved = evalsGreedy - stats.evals;
  return result(P, S, stats, t0);
}

// ---------------------------------------------------------------------------------------------------------
// 4. Brute force          5. Branch and bound
// ---------------------------------------------------------------------------------------------------------

// The N best {value, S} seen so far, in a BOUNDED MIN-HEAP: the root is the N-th best, which is exactly the
// value a new set has to beat, so offer() is O(1) for a set that does not make the list and O(log N) otherwise.
class TopN {
  constructor(N) { this.N = N >= 1 ? Math.floor(N) : 1; this.heap = new Heap((a, b) => a.value < b.value); }
  threshold() { return this.heap.size === this.N ? this.heap.peek().value : -Infinity; }   // value to beat
  offer(value, S) {
    if (this.heap.size < this.N) this.heap.push({ value, S: S.slice() });
    else if (value > this.heap.peek().value) { this.heap.pop(); this.heap.push({ value, S: S.slice() }); }
  }
  list(P) {   // best first, equal values by bySet (not by a joined string: ids 1 and '1' join alike); values recomputed
    return this.heap.a.map(e => { const set = e.S.map(k => P.ids[k]).sort(byId); return { set, value: value(P.inst, set) }; })
      .sort((a, b) => b.value - a.value || bySet(a.set, b.set));
  }
}
const factorials = L => { const f = [1]; for (let d = 1; d <= L; d++) f.push(f[d - 1] * d); return f; };

// BRUTE FORCE over COMBINATIONS: depth-first, a set is extended only with candidates of a LARGER id than its
// last member, so every feasible set is generated exactly once, as its increasing-id sequence, never as one of
// its |S|! orderings. Every node of the tree is a feasible set (the root is the empty set).
// Guarantee: exact (it looks at every feasible set). Reference for the tests; hopeless beyond toy sizes.
// Complexity: O(#feasible sets * n) evaluations, #feasible sets <= sum_{k <= limit} C(n, k).
// Options: topN keeps the N best sets (result.top), onSet(ids, value) is called for every feasible set,
// nodeCap stops early (result.complete = false). result.permutationSequences = sum of |S|! over the visited
// sets = the number of nodes a search over ORDERED sequences would have visited for the same sets.
function bruteForce(inst, { topN = 1, onSet = null, nodeCap = Infinity } = {}) {
  const t0 = now(), P = prepare(inst), stats = mkStats(), { n, limit: L } = P;
  const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => byId(P.ids[a], P.ids[b]));   // increasing id
  const lefts = Array.from({ length: L + 1 }, () => new Float64Array(P.nE));   // one state per depth, nothing to undo
  lefts[0].set(P.hp);
  const opUsed = new Uint8Array(P.nOp), tileUsed = new Uint8Array(P.nTile), S = [], top = new TopN(topN), fact = factorials(L);
  let sequences = 0, capped = false;
  const dfs = (start, val) => {
    stats.explored++; sequences += fact[S.length];
    top.offer(val, S);
    if (onSet) onSet(S.map(k => P.ids[k]), val);
    if (S.length === L) return;
    const left = lefts[S.length];
    for (let j = start; j < n && !capped; j++) {
      const k = order[j];
      if (opUsed[P.opOf[k]] || tileUsed[P.tileOf[k]]) { stats.pruned.infeasible++; continue; }
      if (stats.explored >= nodeCap) { capped = true; return; }
      const g = gain(P, left, k); stats.evals++;
      place(P, left, k, lefts[S.length + 1]);
      S.push(k); opUsed[P.opOf[k]] = 1; tileUsed[P.tileOf[k]] = 1;
      dfs(j + 1, val + g);
      S.pop(); opUsed[P.opOf[k]] = 0; tileUsed[P.tileOf[k]] = 0;
    }
  };
  dfs(0, 0);
  const list = top.list(P);
  stats.pruned.symmetry = sequences - stats.explored; stats.timeMs = now() - t0;
  return { set: list[0].set, value: list[0].value, top: list, complete: !capped, permutationSequences: sequences, stats };
}

// For every position j >= start: sumR[j] = sum of the r largest positive gains among positions >= j, and
// sumR1[j] = the same with r - 1. One right-to-left pass with a tiny sorted buffer of the current top r.
// O((n - start) * r). Entries < 0 mark infeasible candidates and are skipped.
function suffixTopSums(g, start, n, r, sumR, sumR1, buf) {
  let m = 0;   // buf[0..m) = the largest gains seen so far, descending, m <= r
  sumR[n] = 0; sumR1[n] = 0;
  for (let j = n - 1; j >= start; j--) {
    const x = g[j];
    if (x > 0 && (m < r || x > buf[m - 1])) {
      let i = m < r ? m++ : m - 1;
      while (i > 0 && buf[i - 1] < x) { buf[i] = buf[i - 1]; i--; }
      buf[i] = x;
    }
    let s = 0;
    for (let i = 0; i < m && i < r - 1; i++) s += buf[i];
    sumR1[j] = s; sumR[j] = m === r ? s + buf[r - 1] : s;
  }
}

// BRANCH AND BOUND (depth-first, exact).
// Tree. Candidates are put in ONE fixed order (solo value descending, ties by id; order[] maps a position
// back to a candidate). A node is a feasible set S; its children add one candidate at a LATER position than
// S's last one ("next index" branching). SYMMETRY BREAKING: a set is reached only through its increasing
// sequence, i.e. exactly once, instead of once per ordering. permutationSequences = sum of |S|! over the
// visited sets (what a search over ordered sequences would visit for the same sets) and
// permutationsAvoided = permutationSequences - explored (also reported as stats.pruned.symmetry).
//
// Bound. At node S with value v, let r = limit - |S| slots be left and g(x) = value(S + x) - v for every
// remaining candidate x that is still feasible (later position, operator and tile unused):
//     UB(S) = min( v + sum of the r largest g(x),  total )          total = sum_i w[i] * hp[i]
// Admissible (never below the best completion). Let T be any feasible superset of S built from later
// candidates. (1) Submodularity: value(T) - v <= sum_{x in T \ S} g(x), because each x's gain can only shrink
// once the other members of T are also present. (2) T \ S has at most r members, all of them among the
// remaining feasible candidates, and gains are >= 0 (monotone), so that sum is <= the sum of the r LARGEST
// g(x). Ignoring that those r candidates may clash with each other on operators or tiles only makes the
// bound looser, never wrong. (3) No set is worth more than all enemies dead, hence the cap by `total`
// (equivalently: the future gain is capped by the remaining HP weight total - v).
// The code applies this bound one level early, to each child c_j of S, with the gains already computed at S
// (stale gains are still upper bounds, the lazy-greedy argument again):
//     UB(S + c_j) <= v + g(c_j) + [r - 1 largest g among positions > j]      (cuts that one child)
//                 <= v + [r largest g among positions >= j]                  (non-increasing in j: once it
//                                                                             fails, all later children fail)
// For r = 1 the first form is the child's exact value, so leaves that cannot improve are never visited.
//
// Pruning test. Default: cut when UB <= threshold. Safe for finding ONE optimum: such a subtree holds
// nothing strictly better than a set already in hand. (In code: UB <= threshold + PRUNE_TOL * |threshold|.
// Two sets that tie in exact arithmetic differ by rounding noise once their gains are summed in different
// orders; without the tolerance a saturated instance, where thousands of sets tie at "everything dead", is
// never cut.) strict: true cuts only when UB < threshold (minus the tolerance EPS), which keeps every tie;
// result.optima then lists ALL optimal feasible sets.
// topN > 1: threshold = the N-th best value found so far (TopN's root, -Infinity until N sets are known).
// A cut subtree then holds only sets that could not enter the list, so when proven the N best VALUES are
// exact. (All feasible sets count, including a set plus a member that adds nothing.)
//
// Incumbent: opts.incumbent (ids, or any result object with .set) or the greedy set. A good incumbent prunes
// from the first node on. nodeCap (default NODE_CAP_DEFAULT): stop after that many nodes; result.proven is
// then false and the result is the best known (never worse than the incumbent).
//
// Guarantee: when proven is true, result.value is the optimum and result.top holds the N best values, both
// up to PRUNE_TOL (1e-12 relative; exact for integer data below 1e12).
// Complexity: worst case every feasible set, sum_{k <= limit} C(n, k) nodes, each O(n * (nonzeros + limit));
// the problem contains weighted max coverage, which is NP-hard, so only the pruning makes it practical.
function branchAndBound(inst, { incumbent = null, nodeCap = NODE_CAP_DEFAULT, topN = 1, strict = false } = {}) {
  const t0 = now(), P = prepare(inst), stats = mkStats(), { n, limit: L, total } = P;

  // fixed branching order: strong candidates first => good sets early, large gains at the front of the bound
  const solo = new Float64Array(n);
  for (let k = 0; k < n; k++) solo[k] = gain(P, P.hp, k);
  stats.evals += n;
  const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => solo[b] - solo[a] || byId(P.ids[a], P.ids[b]));

  // incumbent: recorded before the search starts; DFS must not record the same set a second time
  const seedIds = incumbent ? (Array.isArray(incumbent) ? incumbent : incumbent.set) : greedy(inst).set;
  if (!feasible(inst, seedIds)) throw new Error('branchAndBound: the incumbent is not a feasible set');
  const seed = seedIds.map(id => P.index.get(id)), seedValue = value(inst, seedIds), inSeed = new Uint8Array(n);
  for (const k of seed) inSeed[k] = 1;
  stats.incumbent = { value: seedValue, from: incumbent ? 'given' : 'greedy' };
  const top = new TopN(topN);
  top.offer(seedValue, seed);
  let optima = strict ? [{ value: seedValue, S: seed.slice() }] : null, bestValue = seedValue;

  const cut = strict ? (ub, thr) => ub < thr - tol(thr) : (ub, thr) => ub <= thr + PRUNE_TOL * Math.max(1, Math.abs(thr));

  // per-depth scratch (depth <= limit): state, gains at this node, the two suffix sums, the top-r buffer
  const mk = len => Array.from({ length: L + 1 }, () => new Float64Array(len));
  const lefts = mk(P.nE), gains = mk(n), sumR = mk(n + 1), sumR1 = mk(n + 1), bufs = mk(L + 1), fact = factorials(L);
  lefts[0].set(P.hp);
  const opUsed = new Uint8Array(P.nOp), tileUsed = new Uint8Array(P.nTile), S = [];
  let sequences = 0, seedHits = 0, capped = false;

  const record = val => {
    if (S.length === seed.length && seedHits === seed.length) return;   // this IS the incumbent: already recorded
    top.offer(val, S);
    if (!strict) return;
    if (val > bestValue + tol(bestValue)) { bestValue = val; optima = []; }
    if (val >= bestValue - tol(bestValue)) { optima.push({ value: val, S: S.slice() }); if (val > bestValue) bestValue = val; }
  };

  const dfs = (start, val) => {
    const depth = S.length, r = L - depth;
    stats.explored++; sequences += fact[depth];
    record(val);
    if (r === 0) return;
    const left = lefts[depth], g = gains[depth], sR = sumR[depth], sR1 = sumR1[depth];
    for (let j = start; j < n; j++) {   // gains of all remaining candidates w.r.t. S; -1 marks "clashes with S"
      const k = order[j];
      if (opUsed[P.opOf[k]] || tileUsed[P.tileOf[k]]) { g[j] = -1; stats.pruned.infeasible++; }
      else { g[j] = gain(P, left, k); stats.evals++; }
    }
    suffixTopSums(g, start, n, r, sR, sR1, bufs[depth]);
    for (let j = start; j < n; j++) {
      if (g[j] < 0) continue;
      const thr = top.threshold();
      if (cut(Math.min(val + sR[j], total), thr)) {             // this child and every later one
        for (let i = j; i < n; i++) if (g[i] >= 0) stats.pruned.bound++;
        return;
      }
      if (cut(Math.min(val + g[j] + sR1[j + 1], total), thr)) { stats.pruned.bound++; continue; }   // this child only
      if (stats.explored >= nodeCap) { capped = true; return; }
      const k = order[j];
      place(P, left, k, lefts[depth + 1]);
      S.push(k); opUsed[P.opOf[k]] = 1; tileUsed[P.tileOf[k]] = 1; seedHits += inSeed[k];
      dfs(j + 1, val + g[j]);
      S.pop(); opUsed[P.opOf[k]] = 0; tileUsed[P.tileOf[k]] = 0; seedHits -= inSeed[k];
      if (capped) return;
    }
  };
  dfs(0, 0);

  const list = top.list(P);
  const out = { set: list[0].set, value: list[0].value, proven: !capped, top: list,
    permutationSequences: sequences, permutationsAvoided: sequences - stats.explored, stats };
  if (strict) {
    out.optima = optima.filter(o => o.value >= bestValue - tol(bestValue))
      .map(o => { const set = o.S.map(k => P.ids[k]).sort(byId); return { set, value: value(inst, set) }; });
  }
  stats.pruned.symmetry = out.permutationsAvoided; stats.timeMs = now() - t0;
  return out;
}

// solve(inst, opts): the exact pipeline in one call: safe dominance pruning, then branch and bound (greedy
// incumbent inside). opts are branchAndBound's; a given incumbent is first moved onto surviving candidates.
// stats.pruned.dominance is filled in. With topN > 1 remember that dominance pruning removes runner-ups that
// differ only by a worse facing.
function solve(inst, opts = {}) {
  const dp = dominancePrune(inst, { mode: 'safe' }), inc = opts.incumbent;
  const o = inc ? Object.assign({}, opts, { incumbent: dp.exchange(Array.isArray(inc) ? inc : inc.set) }) : opts;
  const r = branchAndBound(dp.inst, o);
  r.stats.pruned.dominance = dp.removed; r.stats.timeMs += dp.stats.timeMs;
  return r;
}

// ---------------------------------------------------------------------------------------------------------
// 6. Beam search, local search, simulated annealing
// ---------------------------------------------------------------------------------------------------------

// BEAM SEARCH (level by level). Level d holds at most `width` sets of size d; each is extended by every
// feasible candidate, children that are the same SET reached in a different order are merged through a
// canonical key (the sorted member list: memoisation of states), and the `width` best children form the
// next level. The answer is the best set seen on any level.
// Guarantee: none in general (width 1 is greedy up to tie-breaking). With width >= the number of feasible
// sets of every size nothing is ever dropped and the result is the optimum.
// Complexity: O(limit * width * n) evaluations plus sorting each level.
// stats: explored = sets kept on the levels, pruned.symmetry = duplicates merged by the key,
// pruned.beam = children dropped because the level was full.
function beamSearch(inst, width = BEAM_WIDTH_DEFAULT) {
  const t0 = now(), P = prepare(inst), stats = mkStats(), W = width >= 1 ? width : 1;
  stats.pruned.beam = 0;
  let level = [{ S: [], left: newLeft(P), value: 0 }], best = level[0];
  stats.explored = 1;
  for (let d = 0; d < P.limit && level.length; d++) {
    const kids = new Map();   // canonical key -> child
    for (const st of level) for (let k = 0; k < P.n; k++) {
      if (st.S.some(m => P.opOf[m] === P.opOf[k] || P.tileOf[m] === P.tileOf[k])) { stats.pruned.infeasible++; continue; }
      const S = st.S.concat(k).sort((a, b) => a - b), key = S.join(',');
      if (kids.has(key)) { stats.pruned.symmetry++; continue; }   // same set, other order: already evaluated
      stats.evals++;
      kids.set(key, { S, key, parent: st, k, value: st.value + gain(P, st.left, k) });
    }
    const ranked = [...kids.values()].sort((a, b) => b.value - a.value || byId(a.key, b.key));
    stats.pruned.beam += Math.max(0, ranked.length - W);
    level = ranked.slice(0, W);
    for (const c of level) { c.left = place(P, c.parent.left, c.k, new Float64Array(P.nE)); c.parent = null; }   // states only for survivors
    stats.explored += level.length;
    if (level.length && level[0].value > best.value) best = level[0];
  }
  return result(P, best.S, stats, t0);
}

// LOCAL SEARCH (first-improvement hill climbing). From a feasible set, take the FIRST neighbour that is
// better and restart from it; stop when no neighbour improves (a local optimum). Neighbourhoods (opts.moves):
//   'add'     S + y                    a feasible candidate into a free slot
//   'replace' S - x + y                one member out, any candidate that then fits in (this includes turning
//                                      an operator on its tile, moving it, or substituting another operator)
//   'swap'    two members trade tiles  (a, t1), (b, t2) -> (a, t2), (b, t1), any facings. One replace cannot
//                                      do it (whoever moves first lands on the other's tile), and a detour
//                                      over a third tile starts with a step that rarely improves.
// Guarantee: never worse than the start set, ends feasible and locally optimal for the chosen moves. No
// approximation ratio is claimed.
// Complexity per pass: add O(n), replace O(|S| * n), swap O(|S|^2 * facings^2) evaluations; the number of
// passes is finite because the value strictly increases.
// Evaluating "S minus x" needs the state without x: it is rebuilt from the other members (at most limit - 1
// place() calls), not obtained by subtracting x (see the note at gain/place).
function localSearch(inst, set, { moves = ['add', 'replace', 'swap'] } = {}) {
  const t0 = now(), P = prepare(inst), stats = mkStats(), { n } = P;
  if (!feasible(inst, set)) throw new Error('localSearch: the start set is not feasible');
  stats.moves = { add: 0, replace: 0, swap: 0 };
  const stateOf = members => {
    const left = newLeft(P);
    let v = 0;
    for (const k of members) { v += gain(P, left, k); place(P, left, k); }
    stats.evals += members.length;
    return { left, v };
  };
  const clash = (k, members) => members.some(m => P.opOf[m] === P.opOf[k] || P.tileOf[m] === P.tileOf[k]);
  const at = new Map();   // (operator, tile) -> candidates there, one per facing; used by the swap move
  for (let k = 0; k < n; k++) { const key = P.opOf[k] * P.nTile + P.tileOf[k]; if (!at.has(key)) at.set(key, []); at.get(key).push(k); }
  const scratch = new Float64Array(P.nE);
  let S = set.map(id => P.index.get(id));

  const firstImprovement = () => {
    const cur = stateOf(S), better = v => v > cur.v + IMPROVE_TOL * Math.max(1, cur.v);
    if (moves.includes('add') && S.length < P.limit) {
      for (let k = 0; k < n; k++) {
        if (clash(k, S)) continue;
        stats.explored++; stats.evals++;
        if (better(cur.v + gain(P, cur.left, k))) return { move: 'add', S: S.concat(k) };
      }
    }
    if (moves.includes('replace')) {
      for (const x of S) {
        const rest = S.filter(m => m !== x), base = stateOf(rest);
        for (let k = 0; k < n; k++) {
          if (k === x || clash(k, rest)) continue;
          stats.explored++; stats.evals++;
          if (better(base.v + gain(P, base.left, k))) return { move: 'replace', S: rest.concat(k) };
        }
      }
    }
    if (moves.includes('swap')) {
      for (let a = 0; a < S.length; a++) for (let b = a + 1; b < S.length; b++) {
        const x = S[a], y = S[b], rest = S.filter(m => m !== x && m !== y), base = stateOf(rest);
        const px = at.get(P.opOf[x] * P.nTile + P.tileOf[y]) || [], py = at.get(P.opOf[y] * P.nTile + P.tileOf[x]) || [];
        for (const p of px) for (const q of py) {   // p = x's operator on y's tile, q = y's operator on x's tile
          stats.explored++; stats.evals += 2;
          const v = base.v + gain(P, base.left, p) + gain(P, place(P, base.left, p, scratch), q);
          if (better(v)) return { move: 'swap', S: rest.concat(p, q) };
        }
      }
    }
    return null;
  };
  for (let nb = firstImprovement(); nb; nb = firstImprovement()) { S = nb.S; stats.moves[nb.move]++; }
  return result(P, S, stats, t0);
}

// SIMULATED ANNEALING (Kirkpatrick, Gelatt, Vecchi 1983). A random walk over feasible sets that always
// accepts a better neighbour and accepts a worse one with probability exp(delta / T); the temperature T falls
// geometrically (T0 * cooling^step), so the walk explores first and climbs at the end. It can leave the local
// optima hill climbing gets stuck in.
// Neighbour: pick a random candidate k. If k is in the set, drop it. Otherwise insert k and evict whatever
// clashes with it (same operator or tile), plus one random member if the set is then over the limit. Every
// neighbour is feasible and every feasible set is reachable.
// Guarantee: returns the best set it visited, so never worse than the start set; no optimality guarantee for
// a finite number of steps. Deterministic for a given seed.
// Complexity: steps * O(limit) evaluations (each neighbour's value is rebuilt from its members).
function simulatedAnnealing(inst, set, { seed = 1, steps = SA_STEPS_DEFAULT, T0 = null, cooling = SA_COOLING_DEFAULT } = {}) {
  const t0 = now(), P = prepare(inst), stats = mkStats(), { n } = P, rnd = mulberry32(seed);
  if (!feasible(inst, set)) throw new Error('simulatedAnnealing: the start set is not feasible');
  const left = new Float64Array(P.nE);
  const valueOf = members => {
    left.set(P.hp);
    let v = 0;
    for (const k of members) { v += gain(P, left, k); place(P, left, k); }
    stats.evals += members.length;
    return v;
  };
  if (T0 == null) { let s = 0; for (let k = 0; k < n; k++) s += gain(P, P.hp, k); T0 = n ? SA_T0_FACTOR * s / n : 0; }
  let S = set.map(id => P.index.get(id)), cur = valueOf(S), best = S.slice(), bestValue = cur, T = T0;
  stats.accepted = 0; stats.worseAccepted = 0; stats.T0 = T0;
  for (let step = 0; step < steps && n > 0 && P.limit > 0; step++, T *= cooling) {
    const k = Math.floor(rnd() * n);
    let N;
    if (S.includes(k)) N = S.filter(m => m !== k);
    else {
      N = S.filter(m => P.opOf[m] !== P.opOf[k] && P.tileOf[m] !== P.tileOf[k]);
      if (N.length >= P.limit) N.splice(Math.floor(rnd() * N.length), 1);
      N.push(k);
    }
    const v = valueOf(N), delta = v - cur;
    stats.explored++;
    if (delta >= 0 || (T > 0 && rnd() < Math.exp(delta / T))) {
      stats.accepted++; if (delta < 0) stats.worseAccepted++;
      S = N; cur = v;
      if (cur > bestValue) { bestValue = cur; best = S.slice(); }
    }
  }
  return result(P, best, stats, t0);
}

// ---------------------------------------------------------------------------------------------------------
// 7. Knapsack          8. Property check
// ---------------------------------------------------------------------------------------------------------

// 0/1 KNAPSACK with an item-count dimension (dynamic programming). Choose at most `limit` items with total
// cost <= budget and maximum total value (values simply add up here: no overkill, unlike value()). Typical
// use: which operators to bring for a DP budget and a deploy limit.
//   best[k][b] = best value using at most k of the items seen so far with total cost <= b
//   item i:      best[k][b] = max(best[k][b], best[k-1][b - cost_i] + value_i)
// k runs downwards, so when row k reads row k-1 that row still describes "before item i": this is what
// keeps an item from being used twice. (The order of b is free here, unlike in the 1-D knapsack array.)
// take[i][k][b] remembers whether item i improved that cell; walking it backwards rebuilds the chosen items.
// Guarantee: exact for non-negative INTEGER costs (it throws otherwise).
// Complexity: O(n * limit * budget) time and that many bytes for the reconstruction table.
// Returns { chosen: item indices ascending, value, cost }.
function knapsack01(items, budget, limit = Infinity) {
  const n = items.length;
  let sum = 0;
  for (const it of items) {
    if (!Number.isInteger(it.cost) || it.cost < 0) throw new Error('knapsack01: costs must be non-negative integers');
    sum += it.cost;
  }
  const B = Math.min(Math.floor(budget), sum), L = limit >= 0 ? Math.min(n, Math.floor(limit)) : 0;
  if (!(B >= 0) || L === 0) return { chosen: [], value: 0, cost: 0 };
  const W = B + 1, best = new Float64Array((L + 1) * W), take = new Uint8Array(n * (L + 1) * W);
  for (let i = 0; i < n; i++) {
    const c = items[i].cost, v = items[i].value;
    if (!(v > 0)) continue;   // an item worth nothing is never needed
    for (let k = L; k >= 1; k--) for (let b = B; b >= c; b--) {
      const withItem = best[(k - 1) * W + b - c] + v;
      if (withItem > best[k * W + b]) { best[k * W + b] = withItem; take[(i * (L + 1) + k) * W + b] = 1; }
    }
  }
  const chosen = [];
  let k = L, b = B;
  for (let i = n - 1; i >= 0; i--) if (take[(i * (L + 1) + k) * W + b]) { chosen.push(i); k--; b -= items[i].cost; }
  return { chosen: chosen.reverse(), value: best[L * W + B], cost: B - b };
}

// KNAPSACK BY BRUTE FORCE: all 2^n subsets as bitmasks. Exact; reference for the tests. O(2^n * n), n <= 24.
function knapsackBrute(items, budget, limit = Infinity) {
  const n = items.length;
  if (n > 24) throw new Error('knapsackBrute: too many items');
  let best = { chosen: [], value: 0, cost: 0 };
  for (let mask = 1; mask < (1 << n); mask++) {
    let cost = 0, val = 0, count = 0;
    for (let i = 0; i < n; i++) if ((mask >> i) & 1) { cost += items[i].cost; val += items[i].value; count++; }
    if (cost <= budget && count <= limit && val > best.value) {
      best = { chosen: Array.from({ length: n }, (_, i) => i).filter(i => (mask >> i) & 1), value: val, cost };
    }
  }
  return best;
}

// CHECK MONOTONE + SUBMODULAR numerically. For random A subset of B and x outside B (feasibility ignored):
//   submodular: value(A + x) - value(A) >= value(B + x) - value(B)
//   monotone:   value(A + x) >= value(A), value(B + x) >= value(B), value(B) >= value(A)
// Uses value() from the definition, not the incremental code. Counts violations beyond 1e-9 (relative); for
// a valid instance both counts are 0. A negative pot or weight shows up here (and prepare() rejects it).
// Complexity: O(trials * n * nE).
function checkSubmodular(inst, trials = 200, seed = 1) {
  const rnd = mulberry32(seed), ids = inst.cands.map(c => c.id), out = { trials: 0, submodular: 0, monotone: 0, violations: 0, worst: 0 };
  for (let t = 0; t < trials && ids.length > 0; t++) {
    const x = ids[Math.floor(rnd() * ids.length)], pB = rnd(), pA = rnd();
    const B = ids.filter(id => id !== x && rnd() < pB), A = B.filter(() => rnd() < pA);
    const fA = value(inst, A), fB = value(inst, B), fAx = value(inst, A.concat(x)), fBx = value(inst, B.concat(x));
    const slack = tol(fBx), dA = fAx - fA, dB = fBx - fB;
    out.trials++;
    if (dA < dB - slack) { out.submodular++; out.worst = Math.max(out.worst, dB - dA); }
    if (dA < -slack || dB < -slack || fB < fA - slack) { out.monotone++; out.worst = Math.max(out.worst, -dA, -dB, fA - fB); }
  }
  out.violations = out.submodular + out.monotone;
  return out;
}

module.exports = {
  EPS, PRUNE_TOL, NODE_CAP_DEFAULT, mulberry32, randomInstance,
  value, feasible, prepare, newLeft, gain, place, damageSoFar,
  dominancePrune, greedy, Heap, lazyGreedy, TopN, bruteForce, suffixTopSums, branchAndBound, solve,
  beamSearch, localSearch, simulatedAnnealing, knapsack01, knapsackBrute, checkSubmodular,
};
