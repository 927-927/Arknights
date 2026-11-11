// Tests for combat/timeline.js: the real example roster on 彼处水如酒 (secrecy 15, floor 5) and tiny synthetic stages.
// Run: node combat/test_timeline.js   (one line per passed check, non-zero exit on the first failure)
'use strict';
const assert = require('node:assert');
const path = require('path');
const T = require('./timeline.js');
const sim = require('./sim.js');
const sm = require('./stage_model.js');
const O = require('./operators.js');

let passed = 0;
const ok = (name, fn) => { const info = fn(); console.log(`ok ${++passed} - ${name}${info ? '  [' + info + ']' : ''}`); };
const DT = sim.DT_DEFAULT;
const better = (a, b) => sim.compareResults(a, b) < 0;
const notWorse = (a, b, what) => assert.ok(sim.compareResults(a, b) <= 0, `${what}: ${a.score} is worse than ${b.score}`);
const budget = (out, max, what) => { assert.ok(out.stats.sims <= max, `${what}: ${out.stats.sims} sims > maxSims ${max}`); return out; };
const sc = r => (r ? `life ${r.lifeLost}, HP ${(100 * r.hpRemoved / r.hpTotal).toFixed(1)}%, died ${r.losses.filter(l => l.cause === 'died').length}` : 'null');
const permutations = n => { const out = [], a = [...Array(n).keys()];
  const rec = k => { if (k === n) { out.push(a.slice()); return; } for (let i = k; i < n; i++) { [a[k], a[i]] = [a[i], a[k]]; rec(k + 1); [a[k], a[i]] = [a[i], a[k]]; } };
  rec(0); return out.sort((x, y) => { for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }); };
const stripTime = s => { const { timeMs, phases, ...rest } = s; return { ...rest, phases: phases && phases.map(p => ({ ...p })) }; };

// ---------- fixtures: real ----------
const R = O.loadRoster(path.join(__dirname, 'roster.example.json'));
const by = Object.fromEntries(R.operators.map(o => [o.name, o]));
const BASE = { secrecy: R.secrecy, floor: R.floor, rules: R.rules };     // N15 floor 5, collectible rules (地形图, 舞鞋)
const STAGE = sm.loadStage('彼处水如酒');
// Map (node combat/stage_model.js 彼处水如酒), r from the top, c from the left:
//   r0  # # S # # # # # # # O O O       S spawn, E exit (2,4), T teleport, ^ high ground, _ deployable ground
//   r1  # . . # _ _ _ _ _ . . S O       row 1 lane: c11 -> c4 -> exit
//   r2  # . . # E # ^ ^ ^ # O O O
//   r3  # _ _ # . # T _ _ _ _ _ T       rows 3-4, c7-11: the 裂地盐鳞 loop (most HP-seconds)
//   r4  # _ . # . # T _ _ _ . _ T
//   r5  # _ ^ ^ . # ^ ^ ^ ^ # # #
//   r6  # _ # ^ . _ _ _ _ _ . . S       row 6 lane: c12 -> c4, then up column 4
//   r7  # T # # T # # # # # # # #
// Hand-written placement: 德克萨斯 (DP) and 星熊 hold the row-6 lane, the casters on the high ground (5,7)/(5,8)
// face north over the loop, 银灰 on the high ground above the loop (舞鞋 rule), 塞雷娅 holds row 1.
const P6 = [['德克萨斯', 6, 8, 'E'], ['星熊', 6, 5, 'E'], ['艾雅法拉', 5, 8, 'N'], ['逻各斯', 5, 7, 'N'], ['银灰', 2, 7, 'S'], ['塞雷娅', 1, 6, 'E']]
  .map(([n, r, c, dir]) => ({ op: by[n], r, c, dir }));
const P4 = P6.slice(0, 4);

// ---------- fixtures: synthetic ----------
// '^' high ground (deployable), '_' ground (deployable, walkable), '.' walkable only
function mkStage(rows, extra) {
  const grid = rows.map(row => [...row].map(ch => ({ key: ch === '^' ? 'tile_wall' : ch === '_' ? 'tile_road' : 'tile_floor', high: ch === '^', walkable: ch !== '^', deployable: ch === '^' || ch === '_', hole: false })));
  return { H: rows.length, W: rows[0].length, grid, name: 'synthetic', id: 'syn', deployLimit: 4, initialCost: 99, costIncreaseTime: 1, maxCost: 99, toGrid: p => ({ r: rows.length - 1 - p.row, c: p.col }), ...extra };
}
// enemy walking row 1 from c0 to c1 at v tiles/s: on tile c from (c - c0 - 0.5)/v to (c - c0 + 0.5)/v after spawn
function mkEnemy(id, o = {}) {
  const v = o.v ?? 0.5, c0 = o.c0 ?? 0, c1 = o.c1 ?? 7, p = [];
  for (let c = c0; c <= c1; c++) p.push({ r: 1, c, t: (c - c0) / v });
  return { id, key: 'syn', name: o.type === 'ELITE' ? 'elite' : 'dummy', type: o.type || 'NORMAL', motion: 'WALK', hp: o.hp ?? 1000, atk: 0, def: 0, res: 0, speed: 1, interval: 1,
    life: 1, rangeRadius: -1, applyWay: 'NONE', attackMode: 'none', damageType: 'physical', hits: 1, damageTaken: 1, wave: 0, frag: 0, group: null, spawn: o.spawn ?? 0, path: p };
}
const prof = o => ({ hp: 1000, atk: 100, def: 0, res: 0, block: 0, interval: 1, damageType: 'physical', targets: 1, canHitAir: true, range: o.range, atkScale: 1, hits: 1, attacks: true, ...o });
// a RANGED operator; skill = {spCost, initSp, duration, scale} gives a MANUAL TIME skill whose active profile hits x scale
function mkOp(name, o = {}) {
  const base = prof({ range: o.range, atk: o.atk ?? 100 });
  const op = { id: 'char_' + name, name, position: 'RANGED', cost: o.cost ?? 10, block: 0, hp: 1000, atk: base.atk, def: 0, res: 0, interval: 1, damageType: 'physical', targets: 1, canHitAir: true, range: o.range, skillSpec: null };
  if (o.skill) {
    op.skillSpec = { id: 'sk_' + name, name: 'Burst', level: 1, trigger: 'MANUAL', spType: 'TIME', spCost: o.skill.spCost, initSp: o.skill.initSp, duration: o.skill.duration, instant: null, dpOverDuration: 0, fidelity: 'exact', notes: [] };
    op.profiles = { base, active: { ...base, atkScale: o.skill.scale } };
  }
  return op;
}
const below = (...dcs) => dcs.map(dc => ({ dr: 1, dc }));           // from row 0 facing E: corridor tiles c+dc

// Burst stage: one sniper over corridor tiles c3-c4. Three 300-HP normals (spawn 0/6/12) die to basic attacks; the
// 5000-HP ELITE (spawn 20, in range 25-29 s) leaks unless the 3 s skill (x40 per hit, 60 s recharge, ready at
// deployment) is running while it is in range. 'asap' fires at t = 0 on nothing.
const BURST = mkStage(['^^^^^^^^', '........']);
const burstOp = mkOp('B', { range: below(0, 1), skill: { spCost: 60, initSp: 60, duration: 3, scale: 40 } });
const BURST_OPTS = { enemies: [mkEnemy(0, { hp: 300, spawn: 0 }), mkEnemy(1, { hp: 300, spawn: 6 }), mkEnemy(2, { hp: 300, spawn: 12 }), mkEnemy(3, { hp: 5000, spawn: 20, type: 'ELITE' })] };
const BURST_PLAN = { deploys: [{ op: burstOp, r: 0, c: 3, dir: 'E' }], skills: { B: 'asap' } };
const ELITE_ONLY = { enemies: [mkEnemy(0, { hp: 5000, spawn: 20, type: 'ELITE' })] };

// Order stage: DP-limited (initial 10, +1/s, every operator costs 10, so deploys come at 0/10/20/30 s); a strong
// operator over the start of the corridor and three weak ones further on; six enemies walk in.
const ORDER = mkStage(['^^^^^^^^', '........'], { initialCost: 10 });
const ORDER_OPS = [mkOp('W1', { range: below(0, 1), atk: 60 }), mkOp('W2', { range: below(0, 1), atk: 60, cost: 12 }), mkOp('S', { range: below(0, 1), atk: 400, cost: 11 }), mkOp('W3', { range: below(0, 1), atk: 60, cost: 9 })];
const ORDER_PL = [{ op: ORDER_OPS[0], r: 0, c: 6, dir: 'E' }, { op: ORDER_OPS[1], r: 0, c: 4, dir: 'E' }, { op: ORDER_OPS[2], r: 0, c: 1, dir: 'E' }, { op: ORDER_OPS[3], r: 0, c: 3, dir: 'E' }];
const ORDER_OPTS = { enemies: [0, 4, 8, 12, 16, 20].map((s, i) => mkEnemy(i, { hp: 1200, spawn: s })) };

// ---------- basics ----------
ok('ticks: tickOf/tickTime round-trip (dt 0.1 and 1/30), short decimals, the simulator reaches tickTime(k) at tick k', () => {
  for (const dt of [0.1, 1 / 30]) for (let k = 0; k <= 3000; k++) assert.strictEqual(T.tickOf(T.tickTime(k, dt), dt), k, `dt ${dt} k ${k}`);
  assert.strictEqual(T.tickTime(413, 0.1), 41.3);
  assert.strictEqual(T.tickOf(41.25, 0.1), 413); assert.strictEqual(T.tickOf(41.3, 0.1), 413); assert.strictEqual(T.tickOf(0, 0.1), 0); assert.strictEqual(T.tickOf(-3, 0.1), 0);
  // a deploy planned at 0.05 and at 0.1 happens at the same tick
  const a = sim.simulate(BURST, { deploys: [{ op: burstOp, r: 0, c: 3, dir: 'E', t: 0.05 }] }, BURST_OPTS), b = sim.simulate(BURST, { deploys: [{ op: burstOp, r: 0, c: 3, dir: 'E', t: 0.1 }] }, BURST_OPTS);
  assert.deepStrictEqual(a, b);
  return `413 x 0.1 -> ${T.tickTime(413, 0.1)}; deploy at 0.05 = deploy at 0.1 (t ${a.deploys[0].t})`;
});

ok('planKey/evaluate: equivalent plans share a key (asap = missing, [] = never, ticks, AUTO entries ignored); memoised with hits; null once cache.maxSims is spent', () => {
  const d = { op: burstOp, r: 0, c: 3, dir: 'E' }, key = p => T.planKey(p, BURST_OPTS);
  assert.strictEqual(key({ deploys: [d] }), key({ deploys: [{ ...d, t: 0 }], skills: { B: 'asap' } }));
  assert.strictEqual(key({ deploys: [d], skills: { B: [] } }), key({ deploys: [d], skills: { B: 'never' } }));
  assert.strictEqual(key({ deploys: [d], skills: { B: [25.01, 5] } }), key({ deploys: [d], skills: { B: [5, 25.1] } }));
  assert.strictEqual(key({ deploys: [d], skills: { B: {} } }), key({ deploys: [d] }));
  assert.notStrictEqual(key({ deploys: [d], skills: { B: [25] } }), key({ deploys: [d], skills: { B: [25.2] } }));
  assert.notStrictEqual(key({ deploys: [{ ...d, t: 1 }] }), key({ deploys: [d] }));
  // 能天使 S3 is AUTO: its plan entry does not reach the simulator, so it is not in the key
  const ang = { op: by['能天使'], r: 5, c: 8, dir: 'N' };
  assert.strictEqual(T.planKey({ deploys: [ang], skills: { 能天使: 'never' } }, BASE), T.planKey({ deploys: [ang] }, BASE));
  assert.notStrictEqual(T.planKey({ deploys: [{ op: by['逻各斯'], r: 5, c: 7, dir: 'N' }], skills: { 逻各斯: 'never' } }, BASE), T.planKey({ deploys: [{ op: by['逻各斯'], r: 5, c: 7, dir: 'N' }] }, BASE));
  const cache = T.newCache({ maxSims: 2 });
  const r1 = T.evaluate(BURST, { deploys: [d] }, BURST_OPTS, cache), r2 = T.evaluate(BURST, { deploys: [{ ...d, t: 0 }], skills: { B: 'asap' } }, BURST_OPTS, cache);
  assert.strictEqual(r1, r2); assert.strictEqual(cache.sims, 1); assert.strictEqual(cache.hits, 1);
  assert.deepStrictEqual(r1, sim.simulate(BURST, { deploys: [d] }, BURST_OPTS));
  assert.ok(T.evaluate(BURST, { deploys: [d], skills: { B: 'never' } }, BURST_OPTS, cache));
  assert.strictEqual(T.evaluate(BURST, { deploys: [d], skills: { B: [30] } }, BURST_OPTS, cache), null, 'budget spent');
  assert.throws(() => T.evaluate(ORDER, { deploys: [] }, ORDER_OPTS, cache), /one \(stage, simOpts\) pair/);
  return `sims ${cache.sims}, hits ${cache.hits}`;
});

ok('spearman on known vectors (ties get average ranks; undefined -> null)', () => {
  const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-12, `${x} vs ${y}`);
  near(T.spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]), 1);
  near(T.spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1);
  near(T.spearman([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]), 0.8);                       // 1 - 6*4/(5*24)
  near(T.spearman([1, 2, 2, 3], [1, 2, 3, 4]), 4.5 / Math.sqrt(4.5 * 5));        // ranks 1, 2.5, 2.5, 4
  near(T.spearman([3, 1, 2], [-1e9, -3e9, -2e9]), 1);
  assert.strictEqual(T.spearman([1], [2]), null);
  assert.strictEqual(T.spearman([1, 1, 1], [1, 2, 3]), null);
  return 'rho 1, -1, 0.8, 0.9487, 1; null for n < 2 and constants';
});

// ---------- order ----------
function bruteOrders(stage, placements, opts, skills) {
  let best = null, bestOrder = null;
  for (const order of permutations(placements.length)) {
    const r = sim.simulate(stage, { deploys: order.map(i => ({ ...placements[i], t: 0 })), skills: { ...skills } }, opts);
    if (!best || better(r, best)) { best = r; bestOrder = order; }
  }
  return { best, bestOrder };
}
function checkOrders(stage, placements, opts, maxSims) {
  const ex = budget(T.orderSearch(stage, placements, opts, { maxSims }), maxSims, 'exhaustive');
  assert.strictEqual(ex.stats.mode, 'exhaustive');
  const bf = bruteOrders(stage, placements, opts, {});
  assert.strictEqual(sim.compareResults(ex.result, bf.best), 0, 'exhaustive orderSearch = brute force');
  assert.deepStrictEqual(ex.stats.order, bf.bestOrder, 'same (first) best order');
  const he = budget(T.orderSearch(stage, placements, opts, { maxSims, exhaustive: false }), maxSims, 'heuristic');
  assert.strictEqual(he.stats.mode, 'heuristic+hillclimb');
  const hs = T.heuristicOrders(stage, placements, opts);
  for (const h of hs) notWorse(he.result, sim.simulate(stage, { deploys: h.order.map(i => ({ ...placements[i], t: 0 })) }, opts), `heuristic order ${h.name}`);
  notWorse(ex.result, he.result, 'exhaustive vs heuristic');
  const worst = permutations(placements.length).map(o => sim.simulate(stage, { deploys: o.map(i => ({ ...placements[i], t: 0 })) }, opts)).sort(sim.compareResults).pop();
  return `${placements.length}! = ${permutations(placements.length).length} orders: best [${ex.stats.order}] ${sc(ex.result)} (${ex.stats.sims} sims), worst ${sc(worst)}; heuristic mode `
    + `[${he.stats.order}] ${sim.compareResults(he.result, ex.result) === 0 ? '= optimum' : 'below optimum'} in ${he.stats.sims} sims over ${hs.map(h => h.name).join('/')}`;
}
ok('orderSearch, synthetic DP-limited stage, 4 operators: exhaustive = brute force; heuristic+hill-climb mode >= every heuristic order', () => checkOrders(ORDER, ORDER_PL, ORDER_OPTS, 60));
ok('orderSearch, 彼处水如酒 N15 F5, 4 operators: exhaustive = brute force; heuristic+hill-climb mode >= every heuristic order', () => checkOrders(STAGE, P4, BASE, 60));

const ORD6 = budget(T.orderSearch(STAGE, P6, BASE, { maxSims: 80 }), 80, 'order 6');
ok('orderSearch, 彼处水如酒, 6 operators (720 orders > maxSims 80): heuristic mode, >= every heuristic order, budget respected', () => {
  assert.strictEqual(ORD6.stats.mode, 'heuristic+hillclimb');
  for (const h of T.heuristicOrders(STAGE, P6, BASE)) notWorse(ORD6.result, sim.simulate(STAGE, { deploys: h.order.map(i => ({ ...P6[i], t: 0 })) }, BASE), h.name);
  const input = sim.simulate(STAGE, { deploys: P6 }, BASE);
  return `input order ${sc(input)} (score ${input.score.toFixed(0)}) -> [${ORD6.stats.order.map(i => P6[i].op.name).join(' ')}] ${sc(ORD6.result)} (score ${ORD6.result.score.toFixed(0)}); `
    + `${ORD6.stats.sims} sims, ${ORD6.stats.hits} hits, ${ORD6.stats.improved} improvements, ${ORD6.stats.timeMs} ms; heuristics ${ORD6.stats.orders.map(o => o.name + ' ' + o.score.toFixed(0)).join(', ')}`;
});

// ---------- delays ----------
ok('delaySearch (synthetic): with skill "asap", deploying just before the elite reaches the range beats deploying at once', () => {
  const plan = { deploys: [{ op: burstOp, r: 0, c: 3, dir: 'E' }], skills: { B: 'asap' } }, before = sim.simulate(BURST, plan, ELITE_ONLY);
  const out = budget(T.delaySearch(BURST, plan, ELITE_ONLY, { maxSims: 20 }), 20, 'delay');
  assert.ok(before.lifeLost === 1 && out.result.lifeLost === 0, `${sc(before)} -> ${sc(out.result)}`);
  assert.ok(better(out.result, before));
  const t = out.plan.deploys[0].t;
  assert.ok(t > 0 && t < 25, `deploy at ${t}`);
  assert.deepStrictEqual(sim.simulate(BURST, out.plan, ELITE_ONLY), out.result);
  return `deploy t 0 -> ${t} s (elite reaches the range at 25 s, lead ${T.DELAY_LEAD} s): ${sc(before)} -> ${sc(out.result)}, ${out.stats.sims} sims`;
});

const SK6 = budget(T.skillSearch(STAGE, ORD6.plan, BASE, { maxSims: 90 }), 90, 'skill 6');
const DL6 = budget(T.delaySearch(STAGE, SK6.plan, BASE, { maxSims: 40 }), 40, 'delay 6');
ok('skillSearch and delaySearch on 彼处水如酒 never return a worse result than their input; skillSearch returns explicit times', () => {
  notWorse(SK6.result, ORD6.result, 'skillSearch');
  notWorse(DL6.result, SK6.result, 'delaySearch');
  for (const d of SK6.plan.deploys) if (T.kitInfo(d.op, BASE).spec && T.kitInfo(d.op, BASE).spec.trigger === 'MANUAL') assert.ok(Array.isArray(SK6.plan.skills[d.op.name]), `${d.op.name}: explicit times`);
  assert.deepStrictEqual(sim.simulate(STAGE, SK6.plan, BASE), SK6.result);
  assert.deepStrictEqual(sim.simulate(STAGE, DL6.plan, BASE), DL6.result);
  // also from a deliberately poor input: every MANUAL skill 'never'
  const never = { deploys: ORD6.plan.deploys, skills: { 逻各斯: 'never', 艾雅法拉: 'never', 银灰: 'never', 德克萨斯: 'never' } }, rn = sim.simulate(STAGE, never, BASE);
  const sn = budget(T.skillSearch(STAGE, never, BASE, { maxSims: 40 }), 40, 'skill never');
  notWorse(sn.result, rn, 'skillSearch from never');
  return `skill: ${sc(ORD6.result)} (${ORD6.result.score.toFixed(0)}) -> ${sc(SK6.result)} (${SK6.result.score.toFixed(0)}), ${SK6.stats.sims} sims, ${SK6.stats.improved} improvements, `
    + `${SK6.stats.policyRounds} policy rounds, ${SK6.stats.passes} explicit passes; delay: -> ${DL6.result.score.toFixed(0)}, ${DL6.stats.sims} sims, ${DL6.stats.improved} improvements; `
    + `from 'never': ${rn.score.toFixed(0)} -> ${sn.result.score.toFixed(0)} in ${sn.stats.sims} sims`;
});

// ---------- skills ----------
ok('skillSearch (synthetic burst): holds the burst for the late elite: later first activation than asap, strictly better; both stages alone find it', () => {
  const asap = sim.simulate(BURST, BURST_PLAN, BURST_OPTS);
  assert.strictEqual(asap.lifeLost, 1, 'asap: the elite leaks');
  assert.strictEqual(asap.skillUses[0].t, 0, 'asap fires at the deployment');
  const out = budget(T.skillSearch(BURST, BURST_PLAN, BURST_OPTS, { maxSims: 60 }), 60, 'skill');
  assert.ok(better(out.result, asap) && out.result.lifeLost === 0, sc(out.result));
  const times = out.plan.skills.B;
  assert.ok(Array.isArray(times) && times.length >= 1 && times[0] > asap.skillUses[0].t, `times ${times}`);
  assert.deepStrictEqual(sim.simulate(BURST, out.plan, BURST_OPTS), out.result, 'explicit times reproduce the result');
  const pol = budget(T.skillSearch(BURST, BURST_PLAN, BURST_OPTS, { maxSims: 30, explicit: false }), 30, 'policies only');
  const exp = budget(T.skillSearch(BURST, BURST_PLAN, BURST_OPTS, { maxSims: 30, policy: false }), 30, 'explicit only');
  assert.ok(pol.result.lifeLost === 0 && exp.result.lifeLost === 0, `policy ${sc(pol.result)}, explicit ${sc(exp.result)}`);
  return `asap fires at 0 s: ${sc(asap)}; skillSearch: first use at ${times[0]} s -> ${sc(out.result)} (${out.stats.sims} sims); policy stage alone: ${JSON.stringify(pol.plan.skills.B)}; `
    + `explicit stage alone (hold move): ${JSON.stringify(exp.plan.skills.B)} in ${exp.stats.sims} sims`;
});

// ---------- the whole timeline ----------
const MAX_TL = 260;
const TL = budget(T.optimizeTimeline(STAGE, P6, BASE, { maxSims: MAX_TL }), MAX_TL, 'optimizeTimeline');
ok('optimizeTimeline on 彼处水如酒 (6 operators): never worse than the input timeline; the explicit final plan reproduces the reported result exactly', () => {
  const start = sim.simulate(STAGE, { deploys: P6 }, BASE);
  notWorse(TL.result, start, 'optimizeTimeline');
  assert.strictEqual(TL.stats.startScore, start.score);
  assert.ok(TL.stats.canonical, 'canonical concrete timeline');
  // concrete: every deploy has a time, every MANUAL skill a list of times; replaying it gives the very same result
  for (const d of TL.plan.deploys) assert.ok(typeof d.t === 'number');
  for (const d of TL.plan.deploys) if (T.kitInfo(d.op, BASE).spec.trigger === 'MANUAL') assert.ok(Array.isArray(TL.plan.skills[d.op.name]), d.op.name);
  assert.deepStrictEqual(sim.simulate(STAGE, TL.plan, BASE), TL.result);
  assert.deepStrictEqual(TL.result.deploys.map(d => d.t), TL.plan.deploys.filter(d => TL.result.deploys.some(x => x.name === d.op.name)).map(d => d.t), 'deploy t = actual deploy times');
  for (const [name, times] of Object.entries(TL.plan.skills)) if (Array.isArray(times)) assert.deepStrictEqual(TL.result.skillUses.filter(u => u.name === name).map(u => u.t), times, `${name}: times = actual uses`);
  return `before ${sc(start)} (score ${start.score.toFixed(0)}) -> after ${sc(TL.result)} (score ${TL.result.score.toFixed(0)}); ${TL.stats.sims} sims (max ${MAX_TL}), ${TL.stats.hits} hits, `
    + `${TL.stats.rounds} rounds, ${TL.stats.timeMs} ms, exhausted ${TL.stats.exhausted}; phases ${TL.stats.phases.map(p => `${p.phase} ${p.sims}/${p.improved}`).join(', ')}`;
});

ok('determinism: the same call twice gives the same plan, result and stats (real stage and synthetic)', () => {
  const again = T.optimizeTimeline(STAGE, P6, BASE, { maxSims: MAX_TL });
  assert.strictEqual(T.planKey(again.plan, BASE), T.planKey(TL.plan, BASE));
  assert.deepStrictEqual(again.plan.skills, TL.plan.skills);
  assert.deepStrictEqual(again.result, TL.result);
  assert.deepStrictEqual(stripTime(again.stats), stripTime(TL.stats));
  const a = T.optimizeTimeline(ORDER, ORDER_PL, ORDER_OPTS, { maxSims: 80 }), b = T.optimizeTimeline(ORDER, ORDER_PL, ORDER_OPTS, { maxSims: 80 });
  assert.deepStrictEqual(b.result, a.result); assert.strictEqual(T.planKey(a.plan, ORDER_OPTS), T.planKey(b.plan, ORDER_OPTS));
  const r1 = T.refine(BURST, [[{ op: burstOp, r: 0, c: 3, dir: 'E' }]], BURST_OPTS, { maxSims: 40 }), r2 = T.refine(BURST, [[{ op: burstOp, r: 0, c: 3, dir: 'E' }]], BURST_OPTS, { maxSims: 40 });
  assert.deepStrictEqual(r2.result, r1.result); assert.strictEqual(T.planKey(r1.plan, BURST_OPTS), T.planKey(r2.plan, BURST_OPTS));
  return `real: ${again.stats.sims} sims both times; synthetic order stage ${sc(a.result)}; refine ${sc(r1.result)}`;
});

ok('budget: every search stops cleanly at a tiny maxSims, reports exhausted, and still returns its best plan', () => {
  const out = [];
  for (const max of [1, 3, 7]) {
    const tl = budget(T.optimizeTimeline(STAGE, P6, BASE, { maxSims: max }), max, `optimizeTimeline ${max}`);
    assert.ok(tl.stats.exhausted, `exhausted at ${max}`);
    assert.ok(tl.result && tl.plan, 'a plan and its result');
    assert.deepStrictEqual(sim.simulate(STAGE, tl.plan, BASE), tl.result);
    out.push(`${max}: ${tl.stats.sims} sims`);
  }
  const o = budget(T.orderSearch(STAGE, P6, BASE, { maxSims: 4 }), 4, 'order');
  const s = budget(T.skillSearch(STAGE, { deploys: P6 }, BASE, { maxSims: 5 }), 5, 'skill');
  const d = budget(T.delaySearch(STAGE, { deploys: P6 }, BASE, { maxSims: 2 }), 2, 'delay');
  assert.ok(o.stats.exhausted && s.stats.exhausted && d.stats.exhausted);
  assert.strictEqual(T.orderSearch(STAGE, P6, BASE, { maxSims: 0 }).result, null, 'maxSims 0: nothing simulated');
  // a shared cache makes repeated work free: the same search again costs no simulator call
  const cache = T.newCache(), s1 = T.skillSearch(BURST, BURST_PLAN, BURST_OPTS, { cache, maxSims: 60 }), s2 = T.skillSearch(BURST, BURST_PLAN, BURST_OPTS, { cache, maxSims: 60 });
  assert.strictEqual(s2.stats.sims, 0); assert.ok(s2.stats.hits > 0); assert.deepStrictEqual(s2.result, s1.result);
  return `optimizeTimeline ${out.join(', ')}; order ${o.stats.sims}/4, skill ${s.stats.sims}/5, delay ${d.stats.sims}/2; repeated search with a shared cache: 0 sims, ${s2.stats.hits} hits`;
});

// ---------- refine ----------
ok('refine: top placement sets played out by the simulator, ranked by compareResults, local moves on the best, Spearman vs the input order', () => {
  // three surrogate proposals (input order = surrogate order): the hand-written set, 艾雅法拉 facing east, and
  // 塞雷娅 replaced by 夜莺 on the high ground (2,6)
  const alt1 = P6.map(p => (p.op.name === '艾雅法拉' ? { ...p, dir: 'E' } : p));
  const alt2 = P6.filter(p => p.op.name !== '塞雷娅').concat([{ op: by['夜莺'], r: 2, c: 6, dir: 'S' }]);
  for (const s of [alt1, alt2]) { const occ = new Set(); for (const p of s) { assert.strictEqual(sim.deployError(STAGE, p.op, p.r, p.c, occ, BASE), null, p.op.name); occ.add(p.r * STAGE.W + p.c); } }
  const max = 320, out = budget(T.refine(STAGE, [P6, alt1, alt2], BASE, { maxSims: max, swapPool: [by['桃金娘'], by['能天使'], by['夜莺']] }), max, 'refine');
  assert.strictEqual(out.ranked.length, 3);
  for (let k = 1; k < out.ranked.length; k++) assert.ok(sim.compareResults(out.ranked[k - 1].result, out.ranked[k].result) <= 0, 'ranked best first');
  assert.strictEqual(out.result, out.ranked[0].result);
  assert.ok(out.spearman === null || (out.spearman >= -1 - 1e-12 && out.spearman <= 1 + 1e-12));
  assert.deepStrictEqual(sim.simulate(STAGE, out.plan, BASE), out.result, 'the refined plan reproduces');
  const occ = new Set();
  for (const d of out.plan.deploys) { assert.strictEqual(sim.deployError(STAGE, d.op, d.r, d.c, occ, BASE), null); occ.add(d.r * STAGE.W + d.c); }
  return `ranked ${out.ranked.map(x => `#${x.surrogateRank} ${x.result.score.toFixed(0)}`).join(' > ')}; spearman ${out.spearman === null ? 'null' : out.spearman.toFixed(3)}; `
    + `moves ${out.stats.moves.map(m => `${m.move} ${m.op}->${m.to}`).join(', ') || 'none'}; ${out.stats.sims} sims (max ${max}), ${out.stats.timeMs} ms; best ${sc(out.result)}`;
});

// ---------- Monte Carlo ----------
ok('monteCarlo: 彼处水如酒 has random spawn groups (n = seeds, enemy totals differ); a fixed synthetic enemy list is deterministic (n = 1)', () => {
  const mc = T.monteCarlo(STAGE, TL.plan, BASE, 10);
  assert.strictEqual(mc.n, 10); assert.strictEqual(mc.deterministic, false);
  for (const k of ['lifeLost', 'hpFrac']) assert.ok(mc[k].min <= mc[k].mean + 1e-12 && mc[k].mean <= mc[k].max + 1e-12, k);
  assert.ok(mc.winRate >= 0 && mc.winRate <= 1);
  assert.ok(new Set(mc.perSeed.map(x => x.totalEnemies)).size > 1, 'seed 9 picks the 15% bonus enemy of group c1');
  const seed1 = mc.perSeed.find(x => x.seed === 1);
  assert.strictEqual(seed1.lifeLost, TL.result.lifeLost, 'seed 1 = the optimised run');
  const det = T.monteCarlo(BURST, BURST_PLAN, BURST_OPTS, 10);
  assert.strictEqual(det.n, 1); assert.ok(det.deterministic && /one run/.test(det.note));
  return `seeds 1-10: life lost mean ${mc.lifeLost.mean.toFixed(2)} [${mc.lifeLost.min}, ${mc.lifeLost.max}], HP removed mean ${(100 * mc.hpFrac.mean).toFixed(1)}% [${(100 * mc.hpFrac.min).toFixed(1)}, ${(100 * mc.hpFrac.max).toFixed(1)}], `
    + `enemies ${[...new Set(mc.perSeed.map(x => x.totalEnemies))].join('/')}, win rate ${mc.winRate}; synthetic: n ${det.n}`;
});

// ---------- formatTimeline ----------
ok('formatTimeline: one line per deploy / skill use / loss (/ leak with a trace), sorted by time, then the summary', () => {
  const traced = sim.simulate(STAGE, TL.plan, { ...BASE, trace: true });
  assert.deepStrictEqual((({ trace, ...x }) => x)(traced), TL.result, 'a traced run has the same result (timeline.js memo relies on it)');
  const text = T.formatTimeline(traced), lines = text.split('\n'), timed = lines.filter(l => l.startsWith('t='));
  const ts = timed.map(l => Number(/^t=([\d.]+)s  /.exec(l)[1]));
  for (let k = 1; k < ts.length; k++) assert.ok(ts[k] >= ts[k - 1], `line ${k}: ${timed[k]}`);
  assert.strictEqual(timed.filter(l => / deploy /.test(l)).length, traced.deploys.length);
  assert.strictEqual(timed.filter(l => / skill /.test(l)).length, traced.skillUses.length);
  assert.strictEqual(timed.filter(l => /is down|retreats/.test(l)).length, traced.losses.length);
  assert.strictEqual(timed.filter(l => /leak:/.test(l)).length, traced.leaks);
  assert.strictEqual(timed.length, traced.deploys.length + traced.skillUses.length + traced.losses.length + traced.leaks);
  const d0 = traced.deploys[0];
  assert.ok(lines.includes(`t=${d0.t.toFixed(1)}s  deploy ${d0.name} at (r${d0.r},c${d0.c}) facing ${d0.dir}  [DP ${d0.cost}]`));
  assert.ok(/^result: /.test(lines[lines.length - 3]) && /^losses: /.test(lines[lines.length - 2]) && /^leaks: /.test(lines[lines.length - 1]));
  const burst = T.formatTimeline(T.skillSearch(BURST, BURST_PLAN, BURST_OPTS, { maxSims: 60 }).result);
  assert.ok(/B skill Burst \(until/.test(burst));
  console.log(timed.filter(l => !/药物配置|leak:/.test(l)).concat(lines.slice(-3)).map(l => '    ' + l).join('\n'));
  return `${timed.length} timed lines (printed above without 塞雷娅's AUTO heals and the leak lines)`;
});

console.log(`\n${passed} checks passed`);
