// Timeline search: turns a placement set [{op, r, c, dir}] into a full combat timeline (deploy order, deploy times,
// skill start times) scored by sim.simulate (CONTRACT 6: compareResults / scoreOf). Level 2 of the product: the
// surrogate (optimize.js on candidates.js) proposes placement sets, this module plays them out in the simulator.
//
// Every search here is deterministic, takes a budget of simulator calls (opts.maxSims; cache hits are free), keeps
// its input as the incumbent (it never returns a worse result than it was given), stops cleanly when the budget is
// spent and returns {plan, result, stats: {sims, hits, improved, timeMs, exhausted, maxSims, ...}}:
//   sims      simulator calls this search made (traced runs included)    hits      memoised plans it reused
//   improved  accepted strictly-better moves                              exhausted the budget cut the search short
// Shared memoisation: pass opts.cache (newCache()) to several searches on the same (stage, simOpts) pair.
'use strict';
const sim = require('./sim.js');

// ---------- constants ----------
const SIM_EPS = sim.EPS ?? 1e-9;    // sim.js reaches a planned time t at the first tick with time + EPS >= t (sim.EPS, 1e-9)
const DIRS = ['E', 'S', 'W', 'N'];
const ELITE_TYPES = new Set(['ELITE', 'BOSS']);
// Search-effort defaults (untuned): simulator calls per search when opts.maxSims is not given.
const MAX_SIMS = { order: 200, delay: 120, skill: 200, timeline: 600, refine: 1500 };
const DELAY_LEAD = 1;              // s: "just before" the first enemy reaches an operator's range (delaySearch)
const DELTAS = [4, 2, 1, 0.5];     // s: hill-climbing steps on explicit skill times (skillSearch stage 2)
const HOLD_LOOKAHEAD = 2;          // the next N ELITE/BOSS entries into range tried as hold targets
const POLICY_SHARE = 0.5;          // skillSearch: at most this share of a finite budget goes to stage 1 (policies)
const POLICY_MIN_ENEMIES = [1, 2, 3];
// optimizeTimeline budget shares, of what is left when the phase starts (1 call is kept for the canonical plan)
const SHARE = { order0: 0.3, skill0: 0.4, delay0: 0.35, skill1: 0.5, order: 0.25, skill: 0.4, delay: 0.4 };
const REFINE_TOP = 3;              // refine: placement sets played out in full
const REFINE_SET_SHARE = 0.6;      // refine: share of the budget for optimizeTimeline on those sets (rest: local moves)
const REFINE_SKILL_SIMS = 30;      // refine: short skillSearch after an accepted placement move
const MC_SEEDS = 10;               // monteCarlo: seeds 1..N when no list is given
const EMPTY = Object.freeze({});

const now = () => performance.now();
const better = (a, b) => !!a && (!b || sim.compareResults(a, b) < 0);
const cmpRes = (a, b) => (a && b ? sim.compareResults(a, b) : a ? -1 : b ? 1 : 0);
const cmpNum = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

let SKILLS;                        // skills.js, loaded on first use (null if missing: synthetic operators only)
function skillsJs() {
  if (SKILLS === undefined) { try { SKILLS = require('./skills.js'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; SKILLS = null; } }
  return SKILLS;
}

// ---------- ticks ----------
// The simulator acts at ticks time = k*dt and treats a planned time t (deploy not-before, skill time, notBefore,
// retreat) as reached at the first tick with k*dt + 1e-9 >= t: every t in one such interval is the same decision.
// Keys use the tick; plans carry a short decimal that maps back to the same tick.
const dtOf = o => (o && o.dt > 0 ? o.dt : sim.DT_DEFAULT);
// Beyond this tick index k - 1 may equal k in floating point, so the correction loops below could never end; such a
// time is never reached by a fight anyway (sim.js stops at its time limit).
const TICK_EXACT_MAX = 2 ** 52;
function tickOf(t, dt) {
  if (!(t > 0)) return 0;
  if (t === Infinity) return Infinity;              // "never" (e.g. a deploy not-before = Infinity): kept as is
  let k = Math.max(0, Math.ceil((t - SIM_EPS) / dt));
  if (!(k < TICK_EXACT_MAX)) return k;
  while (k > 0 && (k - 1) * dt + SIM_EPS >= t) k--;
  while (k * dt + SIM_EPS < t) k++;
  return k;
}
function tickTime(k, dt) {
  const x = k * dt, y = Math.round(x * 1000) / 1000;
  return tickOf(y, dt) === k ? y : x;
}
const snap = (t, dt) => tickTime(tickOf(t, dt), dt);
const tickOfResult = (t, dt) => Math.round(t / dt);       // result times are r3(k*dt): recover k

// ---------- operator facts the searches need (mirrors sim.js kitOf) ----------
const KIT = new WeakMap();
function kitInfo(op, simOpts) {
  const api = (simOpts && simOpts.skillApi) || skillsJs() || null;
  let m = KIT.get(op);
  if (!m) KIT.set(op, m = new Map());
  let k = m.get(api);
  if (k) return k;
  const spec = op.skillSpec !== undefined ? op.skillSpec : api && api.compileSkill ? api.compileSkill(op) : null;
  const pr = op.profiles || (spec && api && api.profiles ? api.profiles(op, spec) : null);
  const base = pr && pr.base ? pr.base : op, active = pr && pr.active ? pr.active : base;
  const usable = !!spec && spec.fidelity !== 'unsupported';
  k = { spec, usable,
    baseRange: base.range || op.range || [], baseAir: !!(base.canHitAir ?? op.canHitAir), block: (base.block ?? op.block ?? 0) | 0,
    activeRange: active.range || base.range || op.range || [], activeAir: !!(active.canHitAir ?? base.canHitAir ?? op.canHitAir),
    dpGen: usable && (spec.trigger === 'MANUAL' || spec.trigger === 'AUTO') && ((spec.instant && spec.instant.dp > 0) || spec.dpOverDuration > 0) };
  m.set(api, k);
  return k;
}
// plan.skills matters only for MANUAL skills (AUTO ignores it; sim.js), and not at all under opts.noSkills
const isManual = (op, simOpts) => { const k = kitInfo(op, simOpts); return !simOpts.noSkills && k.usable && k.spec.trigger === 'MANUAL'; };

// range offsets (facing east, CONTRACT 1) -> Set of tile ids at (r, c) facing dir
function maskOf(stage, range, r, c, dir) {
  const s = new Set(), steps = Math.max(0, DIRS.indexOf(dir));
  for (const o of range) {
    let y = o.dr, x = o.dc;
    for (let k = 0; k < steps; k++) { const ny = x; x = -y; y = ny; }      // (dr, dc) -> (dc, -dr) per step E->S->W->N
    const rr = r + y, cc = c + x;
    if (rr >= 0 && cc >= 0 && rr < stage.H && cc < stage.W) s.add(rr * stage.W + cc);
  }
  return s;
}

// ---------- canonical plan key + memoised evaluation ----------
const OIDS = new WeakMap();
let oseq = 0;
const oid = op => { let v = OIDS.get(op); if (v === undefined) OIDS.set(op, v = ++oseq); return v; };
function entryKey(e, dt) {
  if (e === undefined || e === 'asap') return 'a';
  if (e === 'never' || e === null || e === false) return 'n';
  if (Array.isArray(e)) return e.length ? 't' + e.map(t => tickOf(t, dt)).sort((a, b) => a - b).join(',') : 'n';
  if (e && typeof e === 'object') {
    const n = e.minEnemiesInRange > 0 ? e.minEnemiesInRange : 0, h = e.minHpInRange > 0 ? e.minHpInRange : 0, b = e.notBefore > 0 ? tickOf(e.notBefore, dt) : 0;
    return n || h || b ? `p${n},${h},${b}` : 'a';                         // {} behaves as 'asap'
  }
  return 'x' + JSON.stringify(e);                                         // invalid: sim.js throws on it
}
// Two plans with the same key produce the same simulation: operator identity, tile, facing and deploy tick in list
// order; the skill entry of every MANUAL operator (AUTO / passive entries are ignored by the simulator); retreats.
function planKey(plan, simOpts) {
  simOpts = simOpts || EMPTY;
  const dt = dtOf(simOpts), list = plan.deploys || [], sk = plan.skills || {};
  let s = '';
  for (const d of list) s += `${d.op.name}#${oid(d.op)}@${d.r},${d.c}${d.dir}:${tickOf(d.t || 0, dt)};`;
  s += '|';
  for (const d of list) if (isManual(d.op, simOpts)) s += d.op.name + '=' + entryKey(sk[d.op.name], dt) + ';';
  if (simOpts.strictSkills) for (const n of Object.keys(sk).sort()) if (!list.some(d => d.op.name === n)) s += '!' + n;
  s += '|';
  for (const x of (plan.retreats || []).map(x => `${x.op && x.op.name ? x.op.name : x.op}:${tickOf(x.t || 0, dt)}`).sort()) s += x + ';';
  return s;
}
// A cache serves ONE (stage, simOpts) pair (results depend on both); it is bound on first use.
function newCache(o = {}) { return { map: new Map(), traces: new Map(), sims: 0, hits: 0, maxSims: o.maxSims ?? Infinity, stage: null, simOpts: null, derived: {} }; }
function bindCache(cache, stage, simOpts) {
  if (cache.stage === null) { cache.stage = stage; cache.simOpts = simOpts; return; }
  if (cache.stage !== stage || cache.simOpts !== simOpts) throw new Error('timeline: a cache serves one (stage, simOpts) pair; use newCache() for another');
}
const plainOpts = o => (o.trace ? { ...o, trace: false } : o);
// sim.simulate memoised on planKey. Without a cache: one plain simulation. Returns null only when the cache has a
// maxSims and it is spent (and the plan is not cached). Cached results are shared: do not mutate them.
function evaluate(stage, plan, simOpts, cache) {
  simOpts = simOpts || EMPTY;
  if (!cache) return sim.simulate(stage, plan, plainOpts(simOpts));
  bindCache(cache, stage, simOpts);
  const key = planKey(plan, simOpts), hit = cache.map.get(key);
  if (hit) { cache.hits++; return hit; }
  if (cache.sims >= cache.maxSims) return null;
  cache.sims++;
  const r = sim.simulate(stage, plan, plainOpts(simOpts));
  cache.map.set(key, r);
  return r;
}

// Per-search context: budget, counters, traced runs, nominal enemy data.
function searchCtx(stage, simOpts, o, dflt) {
  simOpts = simOpts || EMPTY;
  const cache = o.cache || newCache();
  bindCache(cache, stage, simOpts);
  const max = o.maxSims ?? dflt, s0 = cache.sims, h0 = cache.hits, t0 = now();
  const ctx = { stage, simOpts, cache, dt: dtOf(simOpts), exhausted: false, improved: 0, max,
    used: () => cache.sims - s0,
    left: () => Math.max(0, Math.min(max - (cache.sims - s0), cache.maxSims - cache.sims)),
    // memoised simulation; null (and exhausted) when the plan is new and the budget is spent
    ev(plan) {
      let r;
      if (ctx.left() > 0) r = evaluate(stage, plan, simOpts, cache);
      else { r = cache.map.get(planKey(plan, simOpts)) || null; if (r) cache.hits++; }
      if (!r) ctx.exhausted = true;
      return r;
    },
    // A run with trace (frames every 0.5 s): one simulator call, memoised separately.
    // ASSUMPTION: sim.js results do not depend on opts.trace (test_integration check 13, test_timeline check 15), so
    // the plain part also fills the main memo.
    traced(plan) {
      const key = planKey(plan, simOpts);
      if (cache.traces.has(key)) { cache.hits++; return cache.traces.get(key); }
      if (ctx.left() <= 0) { ctx.exhausted = true; return null; }
      cache.sims++;
      const r = sim.simulate(stage, plan, { ...simOpts, trace: true });
      cache.traces.set(key, r);
      if (!cache.map.has(key)) { const { trace, ...plain } = r; cache.map.set(key, plain); }
      return r;
    },
    stats: extra => ({ sims: cache.sims - s0, hits: cache.hits - h0, improved: ctx.improved, timeMs: Math.round((now() - t0) * 10) / 10, exhausted: ctx.exhausted, maxSims: max, ...extra }) };
  return ctx;
}
// data derived once per cache (enemy list, contact times)
function derived(ctx, name, fn) { const d = ctx.cache.derived; return name in d ? d[name] : (d[name] = fn()); }
const enemiesOf = ctx => derived(ctx, 'enemies', () => ctx.simOpts.enemies || sim.sampleEnemies(ctx.stage, ctx.simOpts));

// ---------- plan helpers ----------
const copyDeploy = (d, dt) => ({ op: d.op, r: d.r, c: d.c, dir: d.dir, t: snap(d.t || 0, dt) });
function normalizePlan(plan, dt) {
  const p = { deploys: (plan.deploys || []).map(d => copyDeploy(d, dt)), skills: { ...(plan.skills || {}) } };
  if (plan.retreats) p.retreats = plan.retreats.map(x => ({ ...x }));
  return p;
}
const withDeployT = (plan, k, t) => ({ ...plan, deploys: plan.deploys.map((d, i) => (i === k ? { ...d, t } : d)) });
const withSkill = (plan, name, entry) => ({ ...plan, skills: { ...plan.skills, [name]: entry } });
const usesOf = (res, name) => res.skillUses.filter(u => u.name === name);
// explicit activation times of every MANUAL operator = its actual uses in `res`
function explicitSkills(ctx, plan, res) {
  const sk = { ...plan.skills };
  for (const d of plan.deploys) if (isManual(d.op, ctx.simOpts)) sk[d.op.name] = usesOf(res, d.op.name).map(u => tickTime(tickOfResult(u.t, ctx.dt), ctx.dt));
  return sk;
}
// The concrete timeline: deploy not-before = the actual deploy time, MANUAL skills = the actual activation times.
// It replays the same run: up to an operator's actual deploy tick nothing differs (its not-before was not the
// binding condition after it), and an explicit time equal to an actual activation fires at that same tick (the skill
// is ready then, as it was). Verified by simulating it (one call); when it does not compare equal, the original
// plan is kept and canonical = false.
function canonicalPlan(ctx, plan, res) {
  if (!res) return { plan, result: res, canonical: false };
  const p = { ...plan, deploys: plan.deploys.map(d => {
    const x = res.deploys.find(y => y.name === d.op.name);
    return x ? { ...d, t: tickTime(tickOfResult(x.t, ctx.dt), ctx.dt) } : d;
  }) };
  p.skills = explicitSkills(ctx, p, res);
  const r = ctx.ev(p);
  return r && sim.compareResults(r, res) <= 0 ? { plan: p, result: r, canonical: true } : { plan, result: res, canonical: false };
}

// concreteTimeline(stage, plan, simOpts, {cache}) -> {plan, result, canonical}: any plan (policies, not-before times)
// as its concrete timeline. At most 2 simulator calls (the plan, then the canonical form).
function concreteTimeline(stage, plan, simOpts, o = {}) {
  const ctx = searchCtx(stage, simOpts, { cache: o.cache, maxSims: 2 }, 2), p = normalizePlan(plan, ctx.dt);
  return canonicalPlan(ctx, p, ctx.ev(p));
}

// ---------- enemy geometry (nominal paths) ----------
// First nominal time an enemy is on a tile of `mask`: walking a path segment from waypoint s to s+1 the simulator's
// rounded position switches tile halfway along it. Spawn times are the nominal back-to-back ones; the simulator
// starts wave k+1 only when wave k is cleared, so for later waves this is a lower bound (heuristic only).
function firstOnMask(enemies, mask, air, walkOnly) {
  let best = Infinity;
  for (const e of enemies) {
    if (e.motion === 'FLY' ? walkOnly || !air : false) continue;
    const p = e.path;
    for (let s = 0; s + 1 < p.length; s++) {
      if (e.spawn + p[s].t >= best) break;
      if (p[s].hidden) continue;
      if (mask.has(p[s].r * 1e4 + p[s].c)) { best = Math.min(best, e.spawn + p[s].t); break; }
      if (!p[s + 1].hidden && mask.has(p[s + 1].r * 1e4 + p[s + 1].c)) { best = Math.min(best, e.spawn + (p[s].t + p[s + 1].t) / 2); break; }
    }
  }
  return best;
}
const keyMask = (stage, m) => new Set([...m].map(t => Math.floor(t / stage.W) * 1e4 + t % stage.W));   // path tiles may lie outside the map
// {range, tile}: first nominal contact with the base range (targetable enemies), and with the operator's own tile
// (WALK enemies, only for a ground operator that blocks).
function contactOf(ctx, d) {
  return derived(ctx, `contact:${oid(d.op)}@${d.r},${d.c}${d.dir}`, () => {
    const k = kitInfo(d.op, ctx.simOpts), en = enemiesOf(ctx), st = ctx.stage;
    const range = firstOnMask(en, keyMask(st, maskOf(st, k.baseRange, d.r, d.c, d.dir)), k.baseAir, false);
    const ground = !(st.grid[d.r] && st.grid[d.r][d.c] && st.grid[d.r][d.c].high);
    const tile = ground && k.block > 0 ? firstOnMask(en, new Set([d.r * 1e4 + d.c]), false, true) : Infinity;
    return { range, tile };
  });
}

// ---------- trace events (actual positions under the current plan) ----------
// Frames sample every 0.5 s, so a time read from them is late by up to that much.
function frameTile(stage, y, x) { const ty = (y + 0.5) | 0, tx = (x + 0.5) | 0; return y > -0.5 && x > -0.5 && ty < stage.H && tx < stage.W ? ty * stage.W + tx : -1; }
function enemyIndex(ctx) { return derived(ctx, 'enemyIndex', () => new Map(enemiesOf(ctx).map((e, i) => [e.id ?? i, e]))); }
// Per deploy: first frame time a targetable enemy is in its base range, and the frame times an ELITE/BOSS enemy
// enters its ACTIVE (skill) range.
function traceEvents(ctx, plan, tr) {
  const idx = enemyIndex(ctx), st = ctx.stage;
  const ops = plan.deploys.map(d => { const k = kitInfo(d.op, ctx.simOpts);
    return { base: maskOf(st, k.baseRange, d.r, d.c, d.dir), act: maskOf(st, k.activeRange, d.r, d.c, d.dir), air: k.baseAir, aair: k.activeAir, first: Infinity, entries: [], inside: new Set() }; });
  for (const f of tr.trace.frames) {
    for (const o of ops) {
      const now2 = new Set();
      for (const [id, y, x] of f.enemies) {
        const e = idx.get(id), fly = e && e.motion === 'FLY', tl = frameTile(st, y, x);
        if (tl < 0) continue;
        if (o.first === Infinity && o.base.has(tl) && (o.air || !fly)) o.first = f.t;
        if (e && ELITE_TYPES.has(e.type) && o.act.has(tl) && (o.aair || !fly)) { now2.add(id); if (!o.inside.has(id)) o.entries.push(f.t); }
      }
      o.inside = now2;
    }
  }
  return ops.map(o => ({ first: o.first, entries: [...new Set(o.entries)] }));
}

// ---------- order ----------
// Deploy order matters only through DP timing (who can be paid for when; a deploy also waits for every earlier one)
// and through who is on the field when (blocking, team effects, the ranged-enemy target rule, skill SP clocks).
// Heuristic orders, deduplicated (the first name of a duplicate wins): input, cheapest first, by first nominal
// contact with the range, blockers on the enemy path first (by contact with their tile), DP generators first.
function heuristicOrders(stage, placements, simOpts, cache) {
  simOpts = simOpts || EMPTY;
  const ctx = searchCtx(stage, simOpts, { cache: cache || newCache(), maxSims: 0 }, 0);
  const n = placements.length, idx = [...Array(n).keys()];
  const ct = placements.map(p => contactOf(ctx, p)), info = placements.map(p => kitInfo(p.op, simOpts));
  const by = (...fs) => idx.slice().sort((a, b) => { for (const f of fs) { const c = cmpNum(f(a), f(b)); if (c) return c; } return a - b; });
  const cost = i => placements[i].op.cost, contact = i => ct[i].range;
  const list = [['input', idx], ['cheapest', by(cost)], ['contact', by(contact, cost)],
    ['blockersFirst', by(i => (ct[i].tile < Infinity ? 0 : 1), i => (ct[i].tile < Infinity ? ct[i].tile : ct[i].range), cost)],
    ['dpFirst', by(i => (!simOpts.noSkills && info[i].dpGen ? 0 : 1), cost)]];
  const seen = new Set(), out = [];
  for (const [name, order] of list) { const k = order.join(','); if (!seen.has(k)) { seen.add(k); out.push({ name, order }); } }
  return out;
}
function nextPermutation(a) {             // lexicographic; false after the last one
  let i = a.length - 2;
  while (i >= 0 && a[i] >= a[i + 1]) i--;
  if (i < 0) return false;
  let j = a.length - 1;
  while (a[j] <= a[i]) j--;
  [a[i], a[j]] = [a[j], a[i]];
  for (let l = i + 1, r = a.length - 1; l < r; l++, r--) [a[l], a[r]] = [a[r], a[l]];
  return true;
}
const factorial = n => (n <= 1 ? 1 : n * factorial(n - 1));
// orderSearch: deploy ORDER, every deploy as soon as DP allows (not-before = the placement's own t, default 0).
// Algorithm: exhaustive enumeration when n! <= maxSims (exact optimum over orders, n! calls); otherwise the
// heuristic orders, then first-improvement hill climbing with adjacent swaps (n-1 calls per pass) and the other
// insertion moves (one deploy moved to any other position, (n-1)(n-2) per pass; together the (n-1)^2 insertion
// neighbours) until a full pass brings nothing: when the budget did not cut it (stats.exhausted false), a local
// optimum in that neighbourhood, at least as good as every heuristic order.
// opts: {maxSims, cache, skills (plan.skills used for every order), exhaustive (force)}.
function orderSearch(stage, placements, simOpts, o = {}) {
  const ctx = searchCtx(stage, simOpts, o, MAX_SIMS.order), n = placements.length;
  const mk = order => ({ deploys: order.map(i => copyDeploy(placements[i], ctx.dt)), skills: { ...(o.skills || {}) } });
  let best = null, bestOrder = [...Array(n).keys()];
  const tried = [];
  const consider = (order, name) => {
    const r = ctx.ev(mk(order));
    if (!r) return false;
    if (name) tried.push({ name, order, score: r.score });
    if (better(r, best)) { if (best) ctx.improved++; best = r; bestOrder = order; }
    return true;
  };
  const exhaustive = o.exhaustive ?? factorial(n) <= ctx.left();
  if (exhaustive) {
    const a = [...Array(n).keys()];
    do { if (!consider(a.slice())) break; } while (nextPermutation(a));
  } else {
    // loops end on a full pass without improvement, or when an evaluation is refused (ctx.exhausted)
    for (const h of heuristicOrders(stage, placements, ctx.simOpts, ctx.cache)) if (!consider(h.order, h.name)) break;
    for (let again = !!best && !ctx.exhausted; again;) {
      const b0 = best;
      for (let i = 0; i + 1 < n && !ctx.exhausted; i++) { const q = bestOrder.slice(); [q[i], q[i + 1]] = [q[i + 1], q[i]]; consider(q); }
      // insertion: the deploy at position i moves to position p (the others keep their relative order). p = i is the
      // identity and p = i +- 1 are the adjacent swaps above, so these are the (n-1)(n-2) other moves; with the swaps
      // they are all (n-1)^2 distinct insertion neighbours of the order.
      for (let i = 0; i < n && !ctx.exhausted; i++) for (let p = 0; p < n && !ctx.exhausted; p++) {
        if (Math.abs(p - i) <= 1) continue;
        const q = bestOrder.slice(), [x] = q.splice(i, 1);
        q.splice(p, 0, x);
        consider(q);
      }
      again = best !== b0 && !ctx.exhausted;
    }
  }
  return { plan: mk(bestOrder), result: best, stats: ctx.stats({ mode: exhaustive ? 'exhaustive' : 'heuristic+hillclimb', orders: tried, order: bestOrder }) };
}

// ---------- deploy times ----------
// delaySearch: deploy TIMES (not-before), coordinate descent over the deploys until a round brings no improvement.
// Candidates per deploy are EVENT POINTS only: 0; DELAY_LEAD before the first enemy reaches its range (nominal
// paths, and the actual first contact read from a traced run of the current plan); the times the other deploys
// happen in the current result. Discrete-event idea: between two events nothing happens that a deploy decision
// could react to (no enemy enters the range, the DP and slot situation of the others does not change), so moving
// a not-before time inside such a gap only shifts the operator's SP clock and time-on-field counters (stacks) by a
// few seconds; the end points of the gaps are where the outcome can change qualitatively. Exact pruning: a
// not-before in (t_k, T_k] (T_k = the actual deploy time) is the same run as t_k, because the deploy was waiting
// for DP, a slot, an earlier deploy or its tile anyway; such candidates are skipped.
// Only a heuristic: wave gating makes spawn times depend on kills, so a change moves later events, and event points
// come from the current run. Cost: one traced call per round plus at most (#event points) calls per deploy.
function delaySearch(stage, plan, simOpts, o = {}) {
  const ctx = searchCtx(stage, simOpts, o, MAX_SIMS.delay), dt = ctx.dt, lead = o.lead ?? DELAY_LEAD;
  let cur = normalizePlan(plan, dt), res = ctx.ev(cur), rounds = 0;
  while (res && !ctx.exhausted) {                     // a refused evaluation (budget spent) sets ctx.exhausted
    rounds++;
    let any = false;
    const tr = o.useTrace === false ? null : ctx.traced(cur), act = tr ? traceEvents(ctx, cur, tr) : null;
    for (let k = 0; k < cur.deploys.length && !ctx.exhausted; k++) {
      const d = cur.deploys[k], tk = tickOf(d.t, dt), dep = res.deploys.find(x => x.name === d.op.name);
      const Tk = dep ? tickOfResult(dep.t, dt) : Infinity;
      const pts = new Set([0]), nom = contactOf(ctx, d).range;
      if (nom < Infinity) pts.add(tickOf(Math.max(0, nom - lead), dt));
      if (act && act[k].first < Infinity) pts.add(tickOf(Math.max(0, act[k].first - lead), dt));
      for (const x of res.deploys) if (x.name !== d.op.name) pts.add(tickOfResult(x.t, dt));
      let bp = null, br = res;
      for (const q of [...pts].sort((a, b) => a - b)) {
        if (q === tk || (q > tk && q <= Tk)) continue;            // same run (see above)
        const p = withDeployT(cur, k, tickTime(q, dt)), r = ctx.ev(p);
        if (!r) break;
        if (better(r, br)) { bp = p; br = r; }
      }
      if (bp) { cur = bp; res = br; ctx.improved++; any = true; }
    }
    if (!any) break;
  }
  return { plan: cur, result: res, stats: ctx.stats({ rounds }) };
}

// ---------- skill times ----------
// minHpInRange thresholds from the enemy roster: the smallest and the largest ELITE/BOSS HP (after mods); without
// elites, the largest enemy HP.
function hpThresholds(ctx) {
  const en = enemiesOf(ctx), el = en.filter(e => ELITE_TYPES.has(e.type)).map(e => e.hp), src = el.length ? el : en.map(e => e.hp);
  if (!src.length) return [];
  const lo = Math.min(...src), hi = Math.max(...src);
  return lo === hi || !el.length ? [hi] : [lo, hi];
}
function policyCandidates(ctx) {
  return ['asap', ...POLICY_MIN_ENEMIES.map(n => ({ minEnemiesInRange: n })), ...hpThresholds(ctx).map(x => ({ minHpInRange: Math.round(x) })), 'never'];
}
// Earliest start of use k (0-based) of a TIME skill, from the current result; 0 = unknown (no pruning).
// ASSUMPTION: the skills.js TIME automaton (SP rises spRate per second while inactive, from initSp at the
// deployment; a use empties spCost). Used only to prune earlier shifts: a wrong estimate wastes a call or skips one
// candidate, it never changes a reported result.
function readyAt(spec, res, name, k) {
  if (!spec || spec.spType !== 'TIME' || (spec.charges || 1) > 1 || spec.ammo || spec.stages) return 0;
  const rate = spec.spRate ?? 1;
  if (!(rate > 0)) return 0;
  if (k === 0) { const d = res.deploys.find(x => x.name === name); return d ? d.t + Math.max(0, spec.spCost - (spec.initSp || 0)) / rate : 0; }
  const prev = usesOf(res, name)[k - 1];
  return prev ? prev.end + spec.spCost / rate : 0;
}
// skillSearch: skill START TIMES of MANUAL skills (AUTO skills fire when ready whatever the plan says).
// Stage 1 (policy level), coordinate descent: per operator in deploy order the best of 'asap', minEnemiesInRange
// 1/2/3, minHpInRange (hpThresholds), 'never', the others fixed; rounds until none improves. Cost <= 7 calls per
// operator per round; at most POLICY_SHARE of a finite budget.
// Stage 2 (explicit times): the best run's skillUses become explicit time lists (the same run), then
// first-improvement hill climbing per activation: hold it until one of the next ELITE/BOSS entries into its skill
// range (traced run), drop it, append one more use (asap after the last, or at an elite entry), then shift it by
// +-delta for delta 4, 2, 1, 0.5 s (an earlier shift is clamped at the estimated ready time, readyAt). After an
// accepted move the lists are made canonical again (= the actual uses). Repeats until a full pass brings nothing:
// a local optimum. The returned plan carries explicit times for every MANUAL skill. Cost per pass: 1 traced call,
// <= HOLD_LOOKAHEAD + 1 per activation and HOLD_LOOKAHEAD + 1 per operator (appends), 2 per activation per delta
// sweep, +1 per accepted move (its canonical form).
// opts: {maxSims, cache, policy (false: skip stage 1), explicit (false: skip stage 2), deltas}.
function skillSearch(stage, plan, simOpts, o = {}) {
  const ctx = searchCtx(stage, simOpts, o, MAX_SIMS.skill), dt = ctx.dt;
  let cur = normalizePlan(plan, dt), res = ctx.ev(cur);
  const manual = cur.deploys.filter(d => isManual(d.op, ctx.simOpts)).map(d => d.op), info = { policyRounds: 0, passes: 0, explicitMismatch: false };
  if (!res || !manual.length) return { plan: cur, result: res, stats: ctx.stats(info) };
  // stage 1
  if (o.policy !== false) {
    const s1 = ctx.used(), cap = Number.isFinite(ctx.left()) ? Math.ceil(ctx.left() * POLICY_SHARE) : Infinity, pols = policyCandidates(ctx);
    for (let any = true; any && ctx.left() > 0 && ctx.used() - s1 < cap;) {
      any = false; info.policyRounds++;
      for (const op of manual) {
        let bp = null, br = res;
        for (const pol of pols) {
          if (ctx.used() - s1 >= cap) break;
          const p = withSkill(cur, op.name, pol), r = ctx.ev(p);
          if (!r) break;
          if (better(r, br)) { bp = p; br = r; }
        }
        if (bp) { cur = bp; res = br; ctx.improved++; any = true; }
      }
    }
  }
  // stage 2
  if (o.explicit === false) return { plan: cur, result: res, stats: ctx.stats(info) };
  if (ctx.left() <= 0) { ctx.exhausted = true; return { plan: cur, result: res, stats: ctx.stats(info) }; }
  {
    const p = { ...cur, skills: explicitSkills(ctx, cur, res) }, r = ctx.ev(p);
    if (!r) return { plan: cur, result: res, stats: ctx.stats(info) };
    if (sim.compareResults(r, res) > 0) { info.explicitMismatch = true; return { plan: cur, result: res, stats: ctx.stats(info) }; }
    cur = p; res = r;
  }
  const times = name => cur.skills[name];
  // try new times for one operator; on success adopt the canonical form (actual uses) when it replays the same run
  const attempt = (name, list) => {
    const p = withSkill(cur, name, list.slice().sort((a, b) => a - b)), r = ctx.ev(p);
    if (!r) return null;
    if (!better(r, res)) return false;
    ctx.improved++;
    const pc = { ...p, skills: explicitSkills(ctx, p, r) }, rc = ctx.ev(pc);
    if (rc && sim.compareResults(rc, r) <= 0) { cur = pc; res = rc; } else { cur = p; res = r; }
    return true;
  };
  const deltas = o.deltas || DELTAS;
  for (let improvedPass = true; improvedPass && !ctx.exhausted;) {
    improvedPass = false; info.passes++;
    // structural moves: hold, drop, append (elite entries from a traced run of the current plan)
    const tr = ctx.traced(cur);
    if (!tr) break;
    const evs = traceEvents(ctx, cur, tr), entriesOf = name => evs[cur.deploys.findIndex(d => d.op.name === name)].entries.map(t => tickTime(tickOf(t, dt), dt));
    for (const op of manual) {
      const ent = entriesOf(op.name);
      for (let k = 0; k < times(op.name).length; k++) {
        const tk = times(op.name)[k];
        for (const e of ent.filter(e => e > tk + SIM_EPS).slice(0, HOLD_LOOKAHEAD)) {
          const l = times(op.name).slice(); l[k] = e;
          const a = attempt(op.name, l);
          if (a === null) return { plan: cur, result: res, stats: ctx.stats(info) };
          if (a) { improvedPass = true; break; }
        }
        if (k < times(op.name).length && times(op.name)[k] === tk) {
          const a = attempt(op.name, times(op.name).filter((_, j) => j !== k));
          if (a === null) return { plan: cur, result: res, stats: ctx.stats(info) };
          if (a) { improvedPass = true; k--; }
        }
      }
      const l = times(op.name), last = l.length ? l[l.length - 1] : 0;
      for (const e of [last, ...ent.filter(e => e > last + SIM_EPS).slice(0, HOLD_LOOKAHEAD)]) {
        const a = attempt(op.name, l.concat([e]));
        if (a === null) return { plan: cur, result: res, stats: ctx.stats(info) };
        if (a) { improvedPass = true; break; }
      }
    }
    // shifts
    for (const delta of deltas) {
      for (let any = true; any && !ctx.exhausted;) {
        any = false;
        for (const op of manual) {
          const spec = kitInfo(op, ctx.simOpts).spec;
          for (let k = 0; k < times(op.name).length; k++) for (const sgn of [1, -1]) {
            const tk = times(op.name)[k];
            if (tk === undefined) break;
            let t = tk + sgn * delta;
            if (sgn < 0) {
              // earlier than the ready time = at the ready time; a clamp that lands within one tick of tk is no move
              const lo = readyAt(spec, res, op.name, k) - dt;
              if (t < lo) { t = lo; if (tickOf(t, dt) >= tickOf(tk, dt) - 1) continue; }
            }
            t = snap(Math.max(0, t), dt);
            if (tickOf(t, dt) === tickOf(tk, dt)) continue;
            const l = times(op.name).slice(); l[k] = t;
            const a = attempt(op.name, l);
            if (a === null) return { plan: cur, result: res, stats: ctx.stats(info) };
            if (a) { any = true; improvedPass = true; }
          }
        }
      }
    }
  }
  return { plan: cur, result: res, stats: ctx.stats(info) };
}

// ---------- the whole timeline ----------
// optimizeTimeline: orderSearch -> skillSearch -> delaySearch -> skillSearch, then rounds of order -> skill -> delay
// (coordinate descent across the three decision groups, the others fixed) until a full round brings no strict
// improvement or the budget ends; finally the canonical concrete timeline (canonicalPlan, 1 call). Each phase gets a
// share (SHARE) of what is left. Never worse than the input order with every deploy at once and opts.skills.
// opts: {maxSims, cache, skills (initial plan.skills)}. stats adds {rounds, phases, startScore, score, canonical}.
function optimizeTimeline(stage, placements, simOpts, o = {}) {
  const ctx = searchCtx(stage, simOpts, o, MAX_SIMS.timeline), dt = ctx.dt;
  const sub = share => ({ cache: ctx.cache, maxSims: Math.max(0, Math.floor((ctx.left() - 1) * share)) });
  let cur = { deploys: placements.map(p => copyDeploy(p, dt)), skills: { ...(o.skills || {}) } }, res = ctx.ev(cur);
  const startScore = res ? res.score : null, phases = [];
  let rounds = 0, converged = false;
  const phase = (name, out) => {
    phases.push({ phase: name, sims: out.stats.sims, improved: out.stats.improved, exhausted: out.stats.exhausted, score: out.result ? out.result.score : null });
    if (!out.result || (res && sim.compareResults(out.result, res) > 0)) return false;
    const gain = better(out.result, res);
    cur = out.plan; res = out.result;
    if (gain) ctx.improved++;
    return gain;
  };
  const asPlacements = p => p.deploys.map(d => ({ op: d.op, r: d.r, c: d.c, dir: d.dir, t: d.t }));
  if (res) {
    phase('order', orderSearch(stage, asPlacements(cur), simOpts, { ...sub(SHARE.order0), skills: cur.skills }));
    phase('skill', skillSearch(stage, cur, simOpts, sub(SHARE.skill0)));
    phase('delay', delaySearch(stage, cur, simOpts, sub(SHARE.delay0)));
    phase('skill', skillSearch(stage, cur, simOpts, sub(SHARE.skill1)));
    rounds = 1;
    while (ctx.left() > 1) {
      rounds++;
      const p0 = phases.length;
      let gain = phase('order', orderSearch(stage, asPlacements(cur), simOpts, { ...sub(SHARE.order), skills: cur.skills }));
      gain = phase('skill', skillSearch(stage, cur, simOpts, sub(SHARE.skill))) || gain;
      gain = phase('delay', delaySearch(stage, cur, simOpts, sub(SHARE.delay))) || gain;
      // a round without improvement is convergence only if no phase of it was cut by its budget share
      if (!gain) { converged = !phases.slice(p0).some(p => p.exhausted); break; }
    }
  }
  const fin = canonicalPlan(ctx, cur, res);
  ctx.exhausted = !converged;
  return { plan: fin.plan, result: fin.result, stats: ctx.stats({ rounds, phases, startScore, score: fin.result ? fin.result.score : null, canonical: fin.canonical }) };
}

// ---------- level 2: placement sets scored by the simulator ----------
// Spearman rank correlation (average ranks for ties, Pearson on the ranks); null when undefined (n < 2 or a constant).
function ranks(v) {
  const idx = v.map((_, i) => i).sort((a, b) => cmpNum(v[a], v[b]) || a - b), r = new Array(v.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
    for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function spearman(xs, ys) {
  if (!xs || !ys || xs.length !== ys.length || xs.length < 2) return null;
  const a = ranks(xs), b = ranks(ys), n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}
// Placement-level local moves of a plan, every one legal (sim.deployError): rotate one operator; move it to one of
// the 8 neighbouring tiles (same facing); swap in an unused operator of swapPool on the same tile and facing (its
// skill entry starts as 'asap'). Deploy times and the other skill entries are kept.
function placementMoves(stage, plan, simOpts, swapPool) {
  const out = [], W = stage.W, legal = { elite: simOpts.elite, rules: simOpts.rules };
  const occ = i => new Set(plan.deploys.filter((_, j) => j !== i).map(d => d.r * W + d.c));
  const put = (i, d, skills) => ({ ...plan, deploys: plan.deploys.map((x, j) => (j === i ? d : x)), skills: skills || plan.skills });
  plan.deploys.forEach((d, i) => { for (const dir of DIRS) if (dir !== d.dir) out.push({ move: 'rotate', op: d.op.name, to: dir, plan: put(i, { ...d, dir }) }); });
  plan.deploys.forEach((d, i) => {
    const o = occ(i);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if ((!dr && !dc) || sim.deployError(stage, d.op, d.r + dr, d.c + dc, o, legal)) continue;
      out.push({ move: 'move', op: d.op.name, to: [d.r + dr, d.c + dc], plan: put(i, { ...d, r: d.r + dr, c: d.c + dc }) });
    }
  });
  const used = new Set(plan.deploys.map(d => d.op.name));
  plan.deploys.forEach((d, i) => {
    const o = occ(i);
    for (const op of swapPool || []) {
      if (used.has(op.name) || sim.deployError(stage, op, d.r, d.c, o, legal)) continue;
      const sk = { ...plan.skills };
      delete sk[d.op.name]; delete sk[op.name];
      out.push({ move: 'swap', op: d.op.name, to: op.name, plan: put(i, { ...d, op }, sk) });
    }
  });
  return out;
}
// refine: Level 2. Each of the top placement sets (input order = surrogate order, best first; an entry is a
// placement list or {placements, value}) gets optimizeTimeline with an equal share of REFINE_SET_SHARE of the
// budget; the sets are ranked by the simulator (compareResults; ties keep the surrogate order). Then first-
// improvement local search on the best one over placementMoves, scored by the simulator, with a short skillSearch
// after every accepted move, until no move improves or the budget ends; finally its canonical timeline.
// Returns {plan, result (the best), ranked: [{placements, plan, result, surrogateRank, value, sims, exhausted, refined?, moves?}],
// spearman (surrogate value, or -input index when no value is given, vs simulator score, over the sets before the
// local moves; a higher score is better, so +1 = the simulator ranks the sets in the input order, -1 = reversed), stats}.
function refine(stage, placementSets, simOpts, o = {}) {
  const ctx = searchCtx(stage, simOpts, o, MAX_SIMS.refine);
  const sets = placementSets.slice(0, o.top ?? REFINE_TOP).map((s, i) => (Array.isArray(s) ? { placements: s, value: null, index: i } : { placements: s.placements, value: s.value ?? null, index: i }));
  const per = Math.floor((ctx.left() * (o.setShare ?? REFINE_SET_SHARE)) / Math.max(1, sets.length));
  const ranked = sets.map(s => {
    const out = optimizeTimeline(stage, s.placements, simOpts, { cache: ctx.cache, maxSims: Math.min(per, ctx.left()), skills: o.skills });
    return { placements: s.placements, plan: out.plan, result: out.result, surrogateRank: s.index, value: s.value, sims: out.stats.sims, exhausted: out.stats.exhausted,
      // extension (demo step): optimizeTimeline's per-phase trail, for reporting
      startScore: out.stats.startScore, rounds: out.stats.rounds, phases: out.stats.phases };
  });
  const rho = spearman(ranked.map(x => (x.value ?? -x.surrogateRank)), ranked.map(x => (x.result ? x.result.score : -Infinity)));
  ranked.sort((a, b) => cmpRes(a.result, b.result) || a.surrogateRank - b.surrogateRank);
  const moves = [];
  let cut = ranked.some(x => x.exhausted);
  if (ranked.length && ranked[0].result) {
    // local search with what is left minus 1 call, kept for the canonical timeline
    const loc = searchCtx(stage, simOpts, { cache: ctx.cache, maxSims: Math.max(0, ctx.left() - 1) }, 0);
    let cur = ranked[0].plan, res = ranked[0].result;
    for (let accepted = true; accepted && !loc.exhausted;) {
      accepted = false;
      for (const mv of placementMoves(stage, cur, ctx.simOpts, o.swapPool)) {
        const r = loc.ev(mv.plan);
        if (!r) break;
        if (!better(r, res)) continue;
        cur = mv.plan; res = r; ctx.improved++;
        const s = skillSearch(stage, cur, simOpts, { cache: ctx.cache, maxSims: Math.min(loc.left(), o.moveSkillSims ?? REFINE_SKILL_SIMS) });
        if (s.result && sim.compareResults(s.result, res) <= 0) { cur = s.plan; res = s.result; }
        moves.push({ move: mv.move, op: mv.op, to: mv.to, score: res.score });
        accepted = true;
        break;
      }
    }
    cut = cut || loc.exhausted;
    const fin = canonicalPlan(ctx, cur, res);       // a cache hit when no move was accepted (already canonical)
    ranked[0] = { ...ranked[0], placements: fin.plan.deploys.map(d => ({ op: d.op, r: d.r, c: d.c, dir: d.dir })), plan: fin.plan, result: fin.result, refined: moves.length > 0, moves };
  }
  const top = ranked[0] || { plan: null, result: null };
  ctx.exhausted = ctx.exhausted || cut;
  return { plan: top.plan, result: top.result, ranked, spearman: rho, stats: ctx.stats({ sets: sets.length, perSet: per, moves }) };
}

// ---------- spawn randomness ----------
// Random spawn groups in actions the mode can execute (hidden groups only when enabled, as sim.sampleEnemies does).
function hasRandomSpawns(stage, simOpts) {
  const mc = stage.mc;
  if (!mc || !Array.isArray(mc.waves)) return false;
  const on = sim.stageSystem(mc, !!simOpts.elite).on;
  return mc.waves.some(w => (w.fragments || []).some(f => (f.actions || []).some(a => a.randomSpawnGroupKey && (!a.hiddenGroup || simOpts.includeHidden || on.has(a.hiddenGroup)))));
}
// monteCarlo: the plan over spawn seeds (seeds: a list, or a count N = seeds 1..N; default MC_SEEDS). A stage
// without random spawn groups (or a fixed simOpts.enemies list) is deterministic: one run, n = 1, deterministic true.
function monteCarlo(stage, plan, simOpts, seeds) {
  simOpts = simOpts || EMPTY;
  const t0 = now(), random = !simOpts.enemies && hasRandomSpawns(stage, simOpts);
  let list = !random ? [simOpts.seed ?? 1] : Array.isArray(seeds) ? seeds : Array.from({ length: seeds > 0 ? seeds : MC_SEEDS }, (_, i) => i + 1);
  if (!list.length) list = [simOpts.seed ?? 1];
  const per = list.map(seed => {
    const r = sim.simulate(stage, plan, { ...simOpts, seed, trace: false });
    return { seed, win: r.win, lifeLost: r.lifeLost, hpFrac: r.hpTotal > 0 ? r.hpRemoved / r.hpTotal : 1, kills: r.kills, leaks: r.leaks, totalEnemies: r.totalEnemies, score: r.score };
  });
  const agg = k => { const v = per.map(x => x[k]); return { mean: v.reduce((s, x) => s + x, 0) / v.length, min: Math.min(...v), max: Math.max(...v) }; };
  return { n: per.length, deterministic: !random, note: random ? `${per.length} spawn seeds` : 'no random spawn groups on this stage (or a fixed enemy list): one run is exact',
    seeds: per.map(x => x.seed), lifeLost: agg('lifeLost'), hpFrac: agg('hpFrac'), winRate: per.filter(x => x.win).length / per.length, perSeed: per, timeMs: Math.round((now() - t0) * 10) / 10 };
}

// ---------- user-facing timeline ----------
// One line per event, sorted by time (ties: deploy, skill, loss, leak), then a summary. Leak lines need result.trace.
function formatTimeline(result) {
  const f1 = t => (Math.round(t * 10) / 10).toFixed(1), rows = [];
  result.deploys.forEach(d => rows.push({ t: d.t, k: 0, s: `deploy ${d.name} at (r${d.r},c${d.c}) facing ${d.dir}  [DP ${d.cost}]` }));
  result.skillUses.forEach(u => rows.push({ t: u.t, k: 1, s: `${u.name} skill ${u.skill ?? '?'} ${u.end > u.t ? `(until ${f1(u.end)}s)` : '(instant)'}` }));
  result.losses.forEach(l => rows.push({ t: l.t, k: 2, s: l.cause === 'retreat' ? `${l.name} retreats` : `${l.name} is down (died)` }));
  const leakT = result.trace ? result.trace.events.filter(e => e.type === 'leak') : [];
  leakT.forEach(e => rows.push({ t: e.t, k: 3, s: `leak: enemy #${e.id}` }));
  rows.forEach((x, i) => { x.i = i; });
  rows.sort((a, b) => a.t - b.t || a.k - b.k || a.i - b.i);
  const pct = result.hpTotal > 0 ? (100 * result.hpRemoved / result.hpTotal).toFixed(1) : '100.0';
  const lines = rows.map(x => `t=${f1(x.t)}s  ${x.s}`);
  lines.push(`result: ${result.win ? 'WIN' : result.timedOut ? 'TIME LIMIT' : 'LOSS'}  life lost ${result.lifeLost}${result.lifePoints != null ? ' (life points ' + result.lifePoints + ')' : ''}  kills ${result.kills}/${result.totalEnemies}  leaks ${result.leaks}  HP removed ${pct}%  duration ${f1(result.duration)}s`);
  lines.push(`losses: ${result.losses.length ? result.losses.map(l => `${l.name}@${f1(l.t)}s (${l.cause})`).join(', ') : 'none'}`);
  lines.push(`leaks: ${result.leaks}${leakT.length ? ' (first at ' + f1(leakT[0].t) + 's, last at ' + f1(leakT[leakT.length - 1].t) + 's)' : ''}`);
  return lines.join('\n');
}

module.exports = { evaluate, orderSearch, delaySearch, skillSearch, optimizeTimeline, refine, monteCarlo, formatTimeline, spearman,
  // extras
  newCache, planKey, heuristicOrders, placementMoves, concreteTimeline,
  tickOf, tickTime, hasRandomSpawns, kitInfo,
  MAX_SIMS, DELAY_LEAD, DELTAS, HOLD_LOOKAHEAD, POLICY_SHARE, POLICY_MIN_ENEMIES, SHARE, REFINE_TOP, REFINE_SET_SHARE, REFINE_SKILL_SIMS, MC_SEEDS };
