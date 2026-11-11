// Tests for combat/sim.js. Self-contained: synthetic stages, operators and enemies in the CONTRACT shapes, a local
// copy of the SP automaton (opts.skillApi) and a no-op modifier API (opts.modApi), so neither operators.js nor
// skills.js is loaded. Real-stage checks need only stage_model.js and the game data.
// Run: node combat/test_sim.js   (one line per passed check, non-zero exit on the first failure)
'use strict';
const assert = require('node:assert');
const sim = require('./sim.js');
const sm = require('./stage_model.js');

let passed = 0;
const ok = (name, fn) => { fn(); console.log(`ok ${++passed} - ${name}`); };
const near = (x, want, tol, what) => assert.ok(Math.abs(x - want) <= tol + 1e-9, `${what}: got ${x}, want ${want} +- ${tol}`);
const DT = sim.DT_DEFAULT;

// ---------- fixtures ----------
// SP automaton as CONTRACT 4 describes it (TIME: +1 SP per second while inactive), plus the skills.js extensions
// the simulator honours: spec.onDeploy (active from the deployment), spec.ammo (the use ends after that many attacks).
const skillApi = {
  skillInit: s => (s.onDeploy ? { sp: 0, active: true, remaining: s.duration, uses: 1 } : { sp: s.initSp || 0, active: false, remaining: 0, uses: 0 }),
  skillTick(s, st, dt) {
    if (st.active) {
      if (st.remaining < 0) return null;                    // until retreat (duration -1, or ammo left)
      st.remaining -= dt;
      if (st.remaining <= 1e-9) { st.active = false; st.remaining = 0; return 'ended'; }
      return null;
    }
    if (s.spType === 'TIME' && st.sp < s.spCost) st.sp = Math.min(s.spCost, st.sp + dt);
    return null;
  },
  skillOnAttack(s, st) {
    if (st.active) { if (st.ammo !== undefined && --st.ammo <= 0) st.remaining = 0; return; }
    if (s.spType === 'ATTACK') st.sp = Math.min(s.spCost, st.sp + 1);
  },
  skillOnHit(s, st) { if (!st.active && s.spType === 'HIT') st.sp = Math.min(s.spCost, st.sp + 1); },
  skillReady: (s, st) => !st.active && (s.trigger === 'MANUAL' || s.trigger === 'AUTO') && st.sp >= s.spCost - 1e-9,
  skillActivate(s, st) {
    st.sp = 0; st.uses++;
    if (s.ammo) { st.active = true; st.remaining = -1; st.ammo = s.ammo; } else if (s.duration !== 0) { st.active = true; st.remaining = s.duration; }
    return s.instant || {};
  },
};
const modApi = { stageMods: () => [], secrecyMods: () => [], applyMods: u => u };
const run = (stage, plan, opts) => sim.simulate(stage, plan, { skillApi, modApi, ...opts });

// '^' high ground (deployable), '_' ground (deployable), '.' ground (walkable only), '#' blocked
function mkStage(rows, extra) {
  const grid = rows.map(row => [...row].map(ch => ({ key: ch === '^' ? 'tile_wall' : ch === '#' ? 'tile_forbidden' : ch === '_' ? 'tile_road' : 'tile_floor',
    high: ch === '^', walkable: ch === '_' || ch === '.', deployable: ch === '^' || ch === '_', hole: false })));
  const H = rows.length;
  return { H, W: rows[0].length, grid, name: 'synthetic', id: 'syn', deployLimit: 6, initialCost: 99, toGrid: p => ({ r: H - 1 - p.row, c: p.col }), ...extra };
}
const CORRIDOR = ['^^^^^^', '______'];      // row 1 is the 1x6 corridor, row 0 the high ground beside it
// An enemy walking row r from column c0 to c1 at v tiles per second (so it enters tile c at (c - c0 - 0.5) / v).
function mkEnemy(o = {}) {
  const v = o.v ?? 0.5, r = o.r ?? 1, c0 = o.c0 ?? 0, c1 = o.c1 ?? 5, path = [];
  for (let c = c0; c <= c1; c++) path.push({ r, c, t: (c - c0) / v });
  return { id: o.id ?? 0, key: 'syn_enemy', name: 'dummy', type: 'NORMAL', motion: o.motion || 'WALK', hp: o.hp ?? 1000, atk: o.atk ?? 0, def: o.def ?? 0, res: o.res ?? 0,
    speed: 1, interval: o.interval ?? 1, life: o.life ?? 1, rangeRadius: o.rangeRadius ?? -1, applyWay: o.applyWay || 'MELEE', damageTaken: 1,
    wave: o.wave ?? 0, frag: 0, group: null, spawn: o.spawn ?? 0, path, ...(o.extra || {}) };
}
const ALL_ROW_BELOW = [0, 1, 2, 3, 4, 5].map(dc => ({ dr: 1, dc }));    // from (0,0) facing E: the whole corridor
const FRONT = [{ dr: 0, dc: 1 }];                                       // the tile in front
function mkOp(name, over) {
  return { id: 'char_' + name, name, position: 'RANGED', cost: 10, block: 0, hp: 1000, atk: 100, def: 0, res: 0, interval: 1, damageType: 'physical',
    targets: 1, canHitAir: true, range: ALL_ROW_BELOW, skillSpec: null, ...over };
}
const mkSpec = over => ({ id: 'skill_test', name: 'Test Skill', level: 1, trigger: 'MANUAL', spType: 'TIME', spCost: 10, initSp: 4, duration: 5, instant: null, dpOverDuration: 0, fidelity: 'exact', notes: [], ...over });
const events = (res, type) => res.trace.events.filter(e => e.type === type);

// ---------- (a) empty plan ----------
ok('(a) empty plan: every enemy leaks, kills 0, lifeLost = sum of life', () => {
  const st = mkStage(CORRIDOR), enemies = [mkEnemy({ id: 0, life: 1 }), mkEnemy({ id: 1, life: 2, spawn: 1 }), mkEnemy({ id: 2, life: 3, spawn: 2 })];
  const r = run(st, { deploys: [] }, { enemies });
  assert.strictEqual(r.leaks, 3); assert.strictEqual(r.kills, 0); assert.strictEqual(r.lifeLost, 6); assert.strictEqual(r.totalEnemies, 3);
  assert.strictEqual(r.alive, 0); assert.strictEqual(r.hpRemoved, 0); assert.strictEqual(r.hpTotal, 3000); assert.strictEqual(r.win, false);
  near(r.duration, 12, DT, 'last enemy spawns at 2 s and walks 5 tiles at 0.5 tiles/s');
  const r2 = run(st, undefined, { enemies, lifePoints: 10 });
  assert.strictEqual(r2.lifeLeft, 4); assert.strictEqual(r2.win, true);
});

// ---------- (b) kill time by hand ----------
ok('(b) ranged operator on one tile: kill time = time of entry + (hits - 1) * interval', () => {
  // enemy enters tile (1,3) at 2.5 tiles / 0.5 = 5.0 s; 150 ATK vs 50 DEF = 100 per hit, 300 HP -> 3 hits at 5.0, 5.5, 6.0
  const st = mkStage(CORRIDOR), op = mkOp('Sniper', { atk: 150, interval: 0.5, range: FRONT });
  const r = run(st, { deploys: [{ op, r: 0, c: 3, dir: 'S' }] }, { enemies: [mkEnemy({ hp: 300, def: 50 })], trace: true });
  assert.strictEqual(r.kills, 1); assert.strictEqual(r.leaks, 0); assert.strictEqual(r.win, true);
  near(events(r, 'kill')[0].t, 6.0, DT, 'kill time'); near(r.duration, 6.0, DT, 'duration');
  assert.strictEqual(r.hpRemoved, 300); assert.strictEqual(r.perOp[0].damage, 300); assert.strictEqual(r.perOp[0].kills, 1);
  for (const dt of [0.05, 1 / 30, 0.2]) near(run(st, { deploys: [{ op, r: 0, c: 3, dir: 'S' }] }, { enemies: [mkEnemy({ hp: 300, def: 50 })], dt }).duration, 6.0, dt, 'kill time at dt ' + dt);
});
ok('(b) interval that is not a multiple of dt keeps its average rate; arts and true damage formulas', () => {
  const st = mkStage(CORRIDOR), kill = (opOver, enOver) => {
    const r = run(st, { deploys: [{ op: mkOp('Caster', opOver), r: 0, c: 0, dir: 'E' }] }, { enemies: [mkEnemy(enOver)], trace: true });
    return events(r, 'kill')[0].t;
  };
  near(kill({ interval: 0.35 }, { hp: 1000 }), 9 * 0.35, DT, '10 hits of 100, first at t=0');              // 3.15 s
  near(kill({ damageType: 'arts', atk: 200 }, { hp: 1000, res: 50, def: 9999 }), 9, DT, 'arts ignores DEF: 200 * (1 - 50/100)');
  near(kill({ damageType: 'true', atk: 100 }, { hp: 1000, res: 90, def: 9999 }), 9, DT, 'true damage ignores DEF and RES');
  near(kill({ atk: 100 }, { hp: 50, def: 9999 }), 9, DT, 'physical floor: 5% of ATK = 5 per hit');
  near(kill({ atk: 100, hits: 2 }, { hp: 1000 }), 4, DT, 'hits: 2 doubles the damage per attack');
});

// ---------- (c) blocking freezes free time ----------
ok('(c) a blocker that deals no damage holds the enemy until maxTime', () => {
  const st = mkStage(CORRIDOR), wall = mkOp('Wall', { position: 'MELEE', block: 1, damageType: 'none', range: [{ dr: 0, dc: 0 }] });
  const r = run(st, { deploys: [{ op: wall, r: 1, c: 3, dir: 'W' }] }, { enemies: [mkEnemy()], maxTime: 60 });
  assert.strictEqual(r.leaks, 0); assert.strictEqual(r.kills, 0); assert.strictEqual(r.alive, 1); assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.win, false, 'a stall is not a win'); assert.strictEqual(r.lifeLost, 0);
  near(r.duration, 60, DT, 'runs to maxTime'); near(r.perOp[0].blockedSeconds, 55, 2 * DT, 'blocked from 5 s (entering tile 3) to 60 s');
});
ok('(c) the enemy is released when its blocker dies and then walks the rest of its path', () => {
  // blocked at 5.0 s; 100 ATK per second against 500 HP / 0 DEF: hits at 5, 6, 7, 8, 9 -> blocker dies at 9; 5 s of path left
  const st = mkStage(CORRIDOR), wall = mkOp('Wall', { position: 'MELEE', block: 1, damageType: 'none', hp: 500, range: [{ dr: 0, dc: 0 }] });
  const r = run(st, { deploys: [{ op: wall, r: 1, c: 3, dir: 'W' }] }, { enemies: [mkEnemy({ atk: 100, interval: 1 })], trace: true });
  assert.deepStrictEqual(r.losses.map(l => [l.name, l.cause]), [['Wall', 'died']]);
  near(r.losses[0].t, 9, 2 * DT, 'blocker dies after 5 hits'); near(events(r, 'leak')[0].t, 14, 3 * DT, 'leak = death + remaining path');
  assert.strictEqual(r.perOp[0].damageTaken, 500); assert.strictEqual(r.perOp[0].died, true); assert.strictEqual(r.leaks, 1);
  near(r.perOp[0].blockedSeconds, 4, 3 * DT, 'held for 4 s');
  // physical enemy hit vs operator DEF, arts enemy hit vs operator RES
  const tank = mkOp('Tank', { position: 'MELEE', block: 1, damageType: 'none', hp: 1e6, def: 60, res: 50, range: [{ dr: 0, dc: 0 }] });
  const phys = run(st, { deploys: [{ op: tank, r: 1, c: 3, dir: 'W' }] }, { enemies: [mkEnemy({ atk: 100 })], maxTime: 15.05 });
  const arts = run(st, { deploys: [{ op: tank, r: 1, c: 3, dir: 'W' }] }, { enemies: [mkEnemy({ atk: 100, extra: { damageType: 'arts' } })], maxTime: 15.05 });
  const hits = phys.perOp[0].damageTaken / 40;
  assert.ok(hits === 10 || hits === 11, `about 10 hits of 100 - 60 in 10 s, got ${hits}`); assert.strictEqual(arts.perOp[0].damageTaken, hits * 50);
});

// ---------- (d) block count ----------
ok('(d) block 1 holds the first enemy and lets the second pass; block 2 holds both', () => {
  const st = mkStage(CORRIDOR), enemies = () => [mkEnemy({ id: 0 }), mkEnemy({ id: 1, spawn: 2 })];
  const wall = b => mkOp('Wall', { position: 'MELEE', block: b, damageType: 'none', range: [{ dr: 0, dc: 0 }] });
  const one = run(st, { deploys: [{ op: wall(1), r: 1, c: 3, dir: 'W' }] }, { enemies: enemies(), maxTime: 40, trace: true });
  assert.strictEqual(one.leaks, 1); assert.strictEqual(one.alive, 1);
  assert.strictEqual(events(one, 'leak')[0].id, 1); near(events(one, 'leak')[0].t, 12, 2 * DT, 'second enemy walks through unhindered');
  const two = run(st, { deploys: [{ op: wall(2), r: 1, c: 3, dir: 'W' }] }, { enemies: enemies(), maxTime: 40 });
  assert.strictEqual(two.leaks, 0); assert.strictEqual(two.alive, 2);
  const high = run(mkStage(['^^^^^^', '___^__']), { deploys: [{ op: mkOp('Perch', { block: 3, damageType: 'none' }), r: 1, c: 3, dir: 'W' }] }, { enemies: enemies(), maxTime: 40 });
  assert.strictEqual(high.leaks, 2, 'an operator on a high tile never blocks');
});

// ---------- (e) flying enemies ----------
ok('(e) FLY enemies are not blocked and are hit only by canHitAir', () => {
  const st = mkStage(CORRIDOR), fly = () => [mkEnemy({ motion: 'FLY', hp: 500 })];
  const wall = mkOp('Wall', { position: 'MELEE', block: 3, damageType: 'none', range: [{ dr: 0, dc: 0 }] });
  const a = run(st, { deploys: [{ op: wall, r: 1, c: 3, dir: 'W' }] }, { enemies: fly() });
  assert.strictEqual(a.leaks, 1); near(a.duration, 10, DT, 'flies straight through'); assert.strictEqual(a.perOp[0].blockedSeconds, 0);
  const b = run(st, { deploys: [{ op: mkOp('Ground', { canHitAir: false }), r: 0, c: 0, dir: 'E' }] }, { enemies: fly() });
  assert.strictEqual(b.hpRemoved, 0); assert.strictEqual(b.leaks, 1);
  const c = run(st, { deploys: [{ op: mkOp('AA', { canHitAir: true }), r: 0, c: 0, dir: 'E' }] }, { enemies: fly() });
  assert.strictEqual(c.kills, 1); assert.strictEqual(c.hpRemoved, 500);
});

// ---------- (f) DP and deployment ----------
ok('(f) DP gating: deploy times follow the cost arithmetic; not-before t is respected', () => {
  const st = mkStage(CORRIDOR, { initialCost: 10, costIncreaseTime: 1 }), idle = { damageType: 'none' };
  const plan = { deploys: [{ op: mkOp('A', { cost: 8, ...idle }), r: 0, c: 0, dir: 'E' }, { op: mkOp('B', { cost: 12, ...idle }), r: 0, c: 1, dir: 'E' }, { op: mkOp('C', { cost: 5, ...idle }), r: 0, c: 2, dir: 'E', t: 30 }] };
  const r = run(st, plan, { enemies: [mkEnemy({ v: 0.1 })] });                 // the fight lasts 50 s
  assert.deepStrictEqual(r.deploys.map(d => d.name), ['A', 'B', 'C']);
  assert.strictEqual(r.deploys[0].t, 0); near(r.deploys[1].t, 10, DT, 'B: 10 - 8 = 2 DP left, 12 needed, +1 DP/s'); assert.strictEqual(r.deploys[2].t, 30);
  assert.deepStrictEqual(r.deploys[1], { name: 'B', t: r.deploys[1].t, r: 0, c: 1, dir: 'E', cost: 12 });
  near(r.dp.generated, r.duration, 2 * DT, 'one DP per second'); assert.strictEqual(r.dp.spent, 25);
  near(r.dp.initial + r.dp.generated + r.dp.refunded - r.dp.spent, r.dp.endUnspent, 1e-6, 'DP ledger balances');
  const slow = run(mkStage(CORRIDOR, { initialCost: 0, costIncreaseTime: 2 }), { deploys: [plan.deploys[0]] }, { enemies: [mkEnemy({ v: 0.1 })] });
  near(slow.deploys[0].t, 16, DT, 'costIncreaseTime 2: 8 DP take 16 s');
  const capped = run(mkStage(CORRIDOR, { initialCost: 0, maxCost: 5 }), { deploys: [plan.deploys[0]] }, { enemies: [mkEnemy({ v: 0.1 })] });
  assert.strictEqual(capped.deploys.length, 0, 'DP capped at maxCost 5 never reaches cost 8'); assert.strictEqual(capped.dp.endUnspent, 5);
});
ok('(f) deploy limit, secrecy >= 10, slots freed by a retreat (refund floor(cost/2))', () => {
  const st = mkStage(CORRIDOR, { deployLimit: 2 }), idle = { damageType: 'none', cost: 9 };
  const deploys = ['A', 'B', 'C'].map((n, c) => ({ op: mkOp(n, idle), r: 0, c, dir: 'E' })), enemies = () => [mkEnemy({ v: 0.1 })];
  assert.strictEqual(sim.deployLimit(st, {}), 2); assert.strictEqual(sim.deployLimit(st, { secrecy: 9 }), 2); assert.strictEqual(sim.deployLimit(st, { secrecy: 10 }), 1);
  assert.strictEqual(sim.deployLimit(st, { secrecy: 15 }), 1);
  assert.deepStrictEqual(run(st, { deploys }, { enemies: enemies() }).deploys.map(d => d.name), ['A', 'B']);
  assert.deepStrictEqual(run(st, { deploys }, { enemies: enemies(), secrecy: 10 }).deploys.map(d => d.name), ['A']);
  const r = run(st, { deploys, retreats: [{ op: 'A', t: 5 }] }, { enemies: enemies(), trace: true });
  assert.deepStrictEqual(r.deploys.map(d => [d.name, d.t]), [['A', 0], ['B', 0], ['C', 5]]);
  assert.deepStrictEqual(r.losses, [{ name: 'A', t: 5, cause: 'retreat' }]); assert.strictEqual(r.dp.refunded, 4);
  assert.strictEqual(r.perOp[0].died, false); assert.strictEqual(events(r, 'opDown')[0].name, 'A');
});

// ---------- (g) skills ----------
ok('(g) asap: first activation (spCost - initSp) seconds after the deploy, then every duration + spCost', () => {
  const st = mkStage(CORRIDOR), op = mkOp('S', { skillSpec: mkSpec() }), enemies = () => [mkEnemy({ v: 0.1, hp: 1e9 })];
  const r = run(st, { deploys: [{ op, r: 0, c: 0, dir: 'E' }] }, { enemies: enemies(), trace: true });
  near(r.skillUses[0].t, 6, DT, 'first use: 10 - 4 SP at 1 SP/s'); near(r.skillUses[0].end, 11, 2 * DT, 'lasts 5 s');
  near(r.skillUses[1].t, 21, 3 * DT, 'second use: 5 s active + 10 s of SP'); assert.strictEqual(r.skillUses[0].name, 'S'); assert.strictEqual(r.skillUses[0].skill, 'Test Skill');
  near(r.perOp[0].skillUptime, r.skillUses.reduce((s, u) => s + u.end - u.t, 0), 3 * DT, 'skillUptime = total length of the uses');
  assert.ok(r.skillUses.every(u => u.end > u.t && u.end <= r.duration), 'every use has an end inside the fight');
  assert.strictEqual(events(r, 'skill').length, r.skillUses.length); assert.ok(events(r, 'skillEnd').length >= r.skillUses.length - 1);
  const late = run(st, { deploys: [{ op, r: 0, c: 0, dir: 'E', t: 3 }] }, { enemies: enemies() });
  near(late.skillUses[0].t, 9, DT, 'deployed at 3 s -> first use at 9 s');
  assert.strictEqual(run(st, { deploys: [{ op, r: 0, c: 0, dir: 'E' }], skills: { S: 'asap' } }, { enemies: enemies() }).skillUses.length, r.skillUses.length, 'missing entry = asap');
});
ok('(g) explicit time list is honoured (each time once, in order); "never"; AUTO ignores the entry', () => {
  const st = mkStage(CORRIDOR), enemies = () => [mkEnemy({ v: 0.1, hp: 1e9 })], dep = op => [{ op, r: 0, c: 0, dir: 'E' }];
  const r = run(st, { deploys: dep(mkOp('S', { skillSpec: mkSpec() })), skills: { S: [20, 40] } }, { enemies: enemies() });
  assert.deepStrictEqual(r.skillUses.map(u => [u.t, u.end]), [[20, 25], [40, 45]]);
  const early = run(st, { deploys: dep(mkOp('S', { skillSpec: mkSpec() })), skills: { S: [2, 7] } }, { enemies: enemies() });
  near(early.skillUses[0].t, 6, DT, 'time 2 s is before the skill is ready: fires when ready'); near(early.skillUses[1].t, 21, 3 * DT, 'time 7 s likewise'); assert.strictEqual(early.skillUses.length, 2);
  assert.strictEqual(run(st, { deploys: dep(mkOp('S', { skillSpec: mkSpec() })), skills: { S: 'never' } }, { enemies: enemies() }).skillUses.length, 0);
  const auto = run(st, { deploys: dep(mkOp('S', { skillSpec: mkSpec({ trigger: 'AUTO' }) })), skills: { S: 'never' } }, { enemies: enemies() });
  near(auto.skillUses[0].t, 6, DT, 'AUTO fires when ready');
  assert.strictEqual(run(st, { deploys: dep(mkOp('S', { skillSpec: mkSpec({ fidelity: 'unsupported' }) })) }, { enemies: enemies() }).skillUses.length, 0, 'unsupported = no skill');
  assert.strictEqual(run(st, { deploys: dep(mkOp('S', { skillSpec: mkSpec({ trigger: 'PASSIVE' }) })) }, { enemies: enemies() }).skillUses.length, 0, 'PASSIVE is never activated');
});
ok('(g) policy object waits for minEnemiesInRange / minHpInRange / notBefore', () => {
  // the skill is ready from the start; range = tile (1,3) only, which the enemy occupies from 5.0 s to 7.0 s
  const st = mkStage(CORRIDOR), op = () => mkOp('S', { range: FRONT, damageType: 'none', skillSpec: mkSpec({ initSp: 10 }) });
  const go = (pol, enemies) => run(st, { deploys: [{ op: op(), r: 0, c: 3, dir: 'S' }], skills: { S: pol } }, { enemies }).skillUses;
  near(go({ minEnemiesInRange: 1 }, [mkEnemy()])[0].t, 5, DT, 'fires when the enemy enters the range');
  assert.strictEqual(go('asap', [mkEnemy()])[0].t, 0);
  assert.strictEqual(go({ minEnemiesInRange: 2 }, [mkEnemy()]).length, 0, 'two enemies never share the range');
  near(go({ minEnemiesInRange: 2 }, [mkEnemy({ id: 0 }), mkEnemy({ id: 1, spawn: 1 })])[0].t, 6, DT, 'second enemy enters 1 s later');
  assert.strictEqual(go({ minHpInRange: 1500 }, [mkEnemy()]).length, 0); near(go({ minHpInRange: 1500 }, [mkEnemy({ hp: 2000 })])[0].t, 5, DT, 'HP in range');
  assert.strictEqual(go({ notBefore: 2.5 }, [mkEnemy()])[0].t, 2.5);
  near(go({ notBefore: 6.5, minEnemiesInRange: 1 }, [mkEnemy()])[0].t, 6.5, DT, 'both conditions');
});
ok('(g) the active profile raises damage, switches range and block, and switches back', () => {
  const st = mkStage(CORRIDOR), spec = mkSpec({ initSp: 10 }), enemies = () => [mkEnemy({ hp: 1e9 })];
  const base = { hp: 1000, atk: 100, def: 0, res: 0, block: 0, interval: 1, damageType: 'physical', targets: 1, canHitAir: true, range: ALL_ROW_BELOW, atkScale: 1, hits: 1, attacks: true };
  const op = mkOp('S', { skillSpec: spec, profiles: { base, active: { ...base, atk: 150, atkScale: 2 } } });
  const never = run(st, { deploys: [{ op, r: 0, c: 0, dir: 'E' }], skills: { S: 'never' } }, { enemies: enemies() });
  const once = run(st, { deploys: [{ op, r: 0, c: 0, dir: 'E' }], skills: { S: [0] } }, { enemies: enemies() });
  assert.strictEqual(once.hpRemoved - never.hpRemoved, 5 * 200, 'hits at 0,1,2,3,4 s deal 300 instead of 100'); near(once.perOp[0].skillUptime, 5, 1e-6, 'uptime');
  // range: base sees nothing, active sees the corridor. block: 0 -> 1 while active (enemy held from 5 s to the end at 10 s).
  const blind = mkOp('R', { skillSpec: mkSpec({ initSp: 10, duration: 3 }), profiles: { base: { ...base, range: [] }, active: base } });
  assert.strictEqual(run(st, { deploys: [{ op: blind, r: 0, c: 0, dir: 'E' }], skills: { R: [0] } }, { enemies: enemies() }).hpRemoved, 300);
  const guard = mkOp('G', { position: 'MELEE', skillSpec: mkSpec({ initSp: 0, spCost: 5, duration: 5 }), profiles: { base: { ...base, attacks: false, block: 0 }, active: { ...base, attacks: false, block: 1 } } });
  const g = run(st, { deploys: [{ op: guard, r: 1, c: 3, dir: 'W' }] }, { enemies: [mkEnemy()], trace: true });
  near(g.perOp[0].blockedSeconds, 5, 3 * DT, 'blocks only while the skill is active (5 s - 10 s)'); near(events(g, 'leak')[0].t, 15, 3 * DT, 'released at skill end, 5 s of path left');
});
ok('(g) instant DP skill raises DP; dpOverDuration adds DP; instant damage; ATTACK-type SP', () => {
  const st = mkStage(CORRIDOR, { maxCost: 999 }), enemies = () => [mkEnemy({ v: 0.1, hp: 1e9 })], dep = op => [{ op, r: 0, c: 0, dir: 'E' }];
  const plain = run(st, { deploys: dep(mkOp('V', { damageType: 'none' })) }, { enemies: enemies() });
  const flag = run(st, { deploys: dep(mkOp('V', { damageType: 'none', skillSpec: mkSpec({ initSp: 0, duration: 0, instant: { dp: 12 } }) })) }, { enemies: enemies() });
  assert.strictEqual(flag.skillUses.length, 4, 'uses at about 10, 20, 30, 40 s'); near(flag.skillUses[0].t, 10, DT, 'first use'); assert.strictEqual(flag.skillUses[0].end, flag.skillUses[0].t, 'instant skill: end = start');
  near(flag.dp.generated - plain.dp.generated, 12 * 4, 1e-6, '12 DP per use'); near(flag.dp.endUnspent - plain.dp.endUnspent, 48, 1e-6, 'and it is still there');
  const over = run(st, { deploys: dep(mkOp('V', { damageType: 'none', skillSpec: mkSpec({ initSp: 10, duration: 8, dpOverDuration: 14 }) })), skills: { V: [0] } }, { enemies: enemies() });
  near(over.dp.generated - plain.dp.generated, 14, 1e-6, 'dpOverDuration spread over the 8 s');
  const half = run(st, { deploys: dep(mkOp('V', { damageType: 'none', skillSpec: mkSpec({ initSp: 10, duration: 8, dpOverDuration: 14 }) })), skills: { V: [0] }, retreats: [{ op: 'V', t: 4 }] }, { enemies: enemies() });
  near(half.dp.generated - plain.dp.generated, 7, 14 / 80 + 1e-6, 'retreated half way: half the DP'); assert.strictEqual(half.skillUses[0].end, 4);
  const nuke = run(st, { deploys: dep(mkOp('N', { damageType: 'none', atk: 100, skillSpec: mkSpec({ initSp: 10, duration: 0, instant: { damage: { scale: 3, damageType: 'true', targets: 2 } } }) })), skills: { N: [1] } },
    { enemies: [mkEnemy({ id: 0, hp: 1e6, def: 500 }), mkEnemy({ id: 1, hp: 1e6, def: 500 }), mkEnemy({ id: 2, hp: 1e6, def: 500 })] });
  assert.strictEqual(nuke.hpRemoved, 600, '2 targets x 100 ATK x 3, true damage');
  const atkSp = run(st, { deploys: dep(mkOp('K', { skillSpec: mkSpec({ spType: 'ATTACK', initSp: 0, spCost: 3 }) })) }, { enemies: enemies() });
  near(atkSp.skillUses[0].t, 2, DT, 'attacks at 0, 1, 2 s give 3 SP');
});

// ---------- (h) wave gating ----------
ok('(h) wave 2 does not spawn until wave 1 is cleared (dead or leaked)', () => {
  const st = mkStage(CORRIDOR), enemies = () => [mkEnemy({ id: 0, wave: 0, spawn: 0 }), mkEnemy({ id: 1, wave: 1, spawn: 2 })];   // nominal: 2 s after wave 1 starts
  const firstSeen = (r, id) => r.trace.frames.find(f => f.enemies.some(e => e[0] === id)).t;
  const leak = run(st, { deploys: [] }, { enemies: enemies(), trace: true });
  near(events(leak, 'wave')[1].t, 10, DT, 'wave 2 starts when the wave-1 enemy leaks at 10 s'); assert.deepStrictEqual(events(leak, 'wave').map(e => e.id), [0, 1]);
  near(firstSeen(leak, 1), 12, 0.5, 'its enemy spawns 2 s later'); near(leak.duration, 22, 2 * DT, 'and leaks 10 s after that');
  // killing the wave-1 enemy at 9 s (10 hits of 100 from t=0) brings wave 2 forward
  const kill = run(st, { deploys: [{ op: mkOp('K'), r: 0, c: 0, dir: 'E' }] }, { enemies: [mkEnemy({ id: 0, wave: 0 }), mkEnemy({ id: 1, wave: 1, spawn: 2, hp: 1e9 })], trace: true });
  near(events(kill, 'wave')[1].t, 9, 2 * DT, 'wave 2 starts at the kill'); near(firstSeen(kill, 1), 11, 0.5, 'spawn 2 s later');
  // dontBlockWave: the next wave does not wait for that enemy
  const free = run(st, { deploys: [] }, { enemies: [mkEnemy({ id: 0, wave: 0, extra: { dontBlockWave: true } }), mkEnemy({ id: 1, wave: 1, spawn: 2 })], trace: true });
  near(events(free, 'wave')[1].t, 0, DT, 'dontBlockWave'); near(free.duration, 12, 2 * DT, 'both walk at once');
  // maxTimeWaitingForNextWave 4 s, then postDelay 1 s, then the enemy's own 2 s
  const mc = { waves: [{ maxTimeWaitingForNextWave: 4, postDelay: 1 }, { maxTimeWaitingForNextWave: -1, postDelay: 0 }] };
  const wait = run(mkStage(CORRIDOR, { mc }), { deploys: [] }, { enemies: enemies(), trace: true });
  near(events(wait, 'wave')[1].t, 5, DT, 'max wait 4 s + postDelay 1 s'); near(firstSeen(wait, 1), 7, 0.5, 'spawn');
});

// ---------- (i) determinism and seeds ----------
const REAL = ['彼处水如酒', '虫虫游戏厅', '猎犬病原', '灌水贤者', '圆石技艺'];
const stages = new Map(REAL.map(n => [n, sm.loadStage(n)]));
ok('(i) determinism: two runs of the same plan are deep-equal (synthetic and 彼处水如酒, with trace)', () => {
  const st = mkStage(CORRIDOR), mk = () => ({ deploys: [{ op: mkOp('A', { skillSpec: mkSpec() }), r: 0, c: 0, dir: 'E' }, { op: mkOp('W', { position: 'MELEE', block: 1, range: FRONT, hp: 3000 }), r: 1, c: 4, dir: 'W' }] });
  const en = () => [0, 1, 2, 3].map(i => mkEnemy({ id: i, spawn: i * 1.5, hp: 2500, atk: 120 }));
  assert.deepStrictEqual(run(st, mk(), { enemies: en(), trace: true }), run(st, mk(), { enemies: en(), trace: true }));
  const real = stages.get('彼处水如酒');
  const a = run(real, { deploys: [] }, { trace: true, seed: 7 }), b = run(real, { deploys: [] }, { trace: true, seed: 7 });
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(sim.sampleEnemies(real, { modApi, seed: 7 }), sim.sampleEnemies(real, { modApi, seed: 7 }));
});
ok('(i) different seeds give different samples on 虫虫游戏厅 (random groups g1 with packs a/b/c), all totals in n_count', () => {
  const st = stages.get('虫虫游戏厅'), sigs = new Set(), totals = new Set();
  for (let seed = 1; seed <= 20; seed++) {
    const en = sim.sampleEnemies(st, { modApi, seed });
    sigs.add(en.map(e => e.key + '@' + e.spawn).join(','));
    totals.add(en.filter(e => !e.bonus && !e.notCount).length);
  }
  assert.ok(sigs.size > 1, 'seeds 1..20 must not all give the same sample');
  for (const t of totals) assert.ok(st.mc.n_count.includes(t), `sampled total ${t} must be one of tomimi's n_count ${JSON.stringify(st.mc.n_count)}`);
  assert.ok(totals.size > 1, 'more than one total seen');
});

// ---------- (j) real stages ----------
ok('(j) conservation and no NaN on 5 real stages with an empty plan: ' + REAL.join(', '), () => {
  for (const [name, st] of stages) {
    const enemies = sim.sampleEnemies(st, { modApi }), r = run(st, { deploys: [] }, { enemies });
    assert.ok(enemies.length > 0, name + ': has enemies');
    assert.strictEqual(r.kills + r.leaks + r.alive, r.totalEnemies, name + ': kills + leaks + alive = total');
    assert.strictEqual(r.totalEnemies, enemies.length); assert.strictEqual(r.kills, 0); assert.strictEqual(r.leaks, enemies.length, name + ': everything leaks');
    assert.strictEqual(r.timedOut, false, name + ': baseline ends before maxTime');
    assert.strictEqual(r.lifeLost, enemies.reduce((s, e) => s + e.life, 0), name + ': lifeLost = sum of life');
    assert.ok(r.hpRemoved <= r.hpTotal && r.hpRemoved === 0, name + ': hpRemoved <= hpTotal');
    for (const k of ['lifeLost', 'lifeLeft', 'leaks', 'kills', 'totalEnemies', 'hpRemoved', 'hpTotal', 'duration', 'score']) assert.ok(Number.isFinite(r[k]), `${name}: ${k} is finite`);
    for (const k of ['generated', 'spent', 'endUnspent']) assert.ok(Number.isFinite(r.dp[k]), `${name}: dp.${k} is finite`);
    for (const e of enemies) {
      for (const k of ['hp', 'atk', 'def', 'res', 'speed', 'interval', 'life', 'rangeRadius', 'damageTaken', 'spawn', 'wave', 'frag']) assert.ok(Number.isFinite(e[k]), `${name}: enemy ${e.key}.${k} is finite`);
      assert.ok(['NORMAL', 'ELITE', 'BOSS'].includes(e.type) && ['WALK', 'FLY'].includes(e.motion) && typeof e.name === 'string' && e.id === enemies.indexOf(e));
      assert.ok(e.path.length > 1 && e.path.every((p, k) => Number.isFinite(p.t) && Number.isInteger(p.r) && Number.isInteger(p.c) && (k === 0 || p.t >= e.path[k - 1].t)), `${name}: ${e.key} path is timed and monotone`);
      assert.ok(e.spawn >= 0 && r.duration >= e.spawn, name + ': spawns inside the fight');
    }
  }
});
ok('(j) 彼处水如酒: 40 counted enemies, 786k HP; fragmentTiming "fromStart" reproduces stage_model.enemyTimeline', () => {
  const st = stages.get('彼处水如酒'), en = sim.sampleEnemies(st, { modApi }).filter(e => !e.bonus);
  assert.strictEqual(en.length, 40); assert.strictEqual(en.reduce((s, e) => s + e.hp, 0), 786000);
  const v0 = sm.enemyTimeline(st, sim.TPS_DEFAULT).filter(e => e.weight === 1).map(e => e.key + '@' + e.spawn).sort();
  const mine = sim.sampleEnemies(st, { modApi, fragmentTiming: 'fromStart' }).filter(e => !e.bonus).map(e => e.key + '@' + e.spawn).sort();
  assert.deepStrictEqual(mine, v0);
  assert.throws(() => sim.sampleEnemies(st, { modApi, fragmentTiming: 'nope' }), /fragmentTiming/);
});

ok('(j) all 77 stages, normal and elite, seeds 1-3: empty plan conserves enemies and ends; sampled totals are in the n_count / e_count lists of tomimi', () => {
  const index = require('fs').readFileSync(require('path').join(__dirname, '..', 'research', 'sources', 'tomimi', 'index.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t'));
  const DUEL = ['ro6_duel_1', 'ro6_duel_2'], off = [];      // 搏杀 / 共斗: duel stages, their totals follow a rule the data does not show
  assert.strictEqual(index.length, 77);
  for (const [i, slug] of index) {
    const st = sm.loadStage(i);
    for (const elite of [false, true]) for (const seed of [1, 2, 3]) {
      const en = sim.sampleEnemies(st, { modApi, elite, seed }), r = run(st, { deploys: [] }, { enemies: en });
      assert.ok(r.leaks === en.length && r.kills === 0 && r.alive === 0 && !r.timedOut && Number.isFinite(r.duration) && Number.isFinite(r.score), `${slug}: baseline`);
      const want = elite ? st.mc.e_count : st.mc.n_count, total = en.filter(e => !e.bonus && !e.notCount).length;
      if (want && !want.includes(total)) off.push(st.id);
    }
  }
  assert.deepStrictEqual([...new Set(off)].sort(), [...new Set(off)].filter(id => DUEL.includes(id)).sort(), 'only the duel stages may miss: ' + [...new Set(off)]);
});

// ---------- (k) trace ----------
ok('(k) trace shape: frames every 0.5 s and events in the contract shape; no trace without opts.trace', () => {
  const st = mkStage(CORRIDOR);
  const plan = { deploys: [{ op: mkOp('A', { skillSpec: mkSpec({ initSp: 10, duration: 2 }) }), r: 0, c: 0, dir: 'E' }, { op: mkOp('W', { position: 'MELEE', block: 1, damageType: 'none', hp: 300, range: FRONT }), r: 1, c: 4, dir: 'W' }] };
  const en = () => [mkEnemy({ id: 0, hp: 600, atk: 100 }), mkEnemy({ id: 1, hp: 1e9, atk: 100, spawn: 1 })];
  const r = run(st, plan, { enemies: en(), trace: true }), tr = r.trace;
  assert.strictEqual(run(st, plan, { enemies: en() }).trace, undefined);
  assert.deepStrictEqual(Object.keys(tr).sort(), ['events', 'frames', 'sampleDt']); assert.strictEqual(tr.sampleDt, 0.5);
  tr.frames.forEach((f, k) => {
    assert.deepStrictEqual(Object.keys(f).sort(), ['dp', 'enemies', 'ops', 't']);
    if (k < tr.frames.length - 1) assert.strictEqual(f.t, k * 0.5, 'frames are 0.5 s apart'); else assert.strictEqual(f.t, r.duration, 'closing frame');
    for (const e of f.enemies) { assert.strictEqual(e.length, 4); assert.ok(e[1] === 1 && e[2] >= 0 && e[2] <= 5 && e[3] > 0 && e[3] <= 1, 'enemy [id, r, c, hpFrac]'); }
    for (const o of f.ops) { assert.strictEqual(o.length, 4); assert.ok(typeof o[0] === 'string' && o[1] >= 0 && o[1] <= 1 && typeof o[2] === 'boolean' && o[3] >= 0 && o[3] <= 1, 'op [name, hpFrac, skillActive, spFrac]'); }
  });
  assert.ok(tr.frames.some(f => f.enemies.some(e => !Number.isInteger(e[2]))), 'enemy positions are fractional');
  assert.ok(tr.frames.some(f => f.ops.some(o => o[2] === true)) && tr.frames.some(f => f.ops.some(o => o[0] === 'A' && o[2] === false && o[3] > 0 && o[3] < 1)), 'skill state and SP are visible');
  const types = new Set(tr.events.map(e => e.type));
  for (const t of ['deploy', 'skill', 'skillEnd', 'kill', 'leak', 'opDown', 'wave']) assert.ok(types.has(t), 'event type ' + t);
  for (const e of tr.events) {
    assert.ok(Number.isFinite(e.t) && e.t >= 0 && e.t <= r.duration + 1e-9 && ['deploy', 'skill', 'skillEnd', 'kill', 'leak', 'opDown', 'wave'].includes(e.type));
    if (['deploy', 'skill', 'skillEnd', 'opDown'].includes(e.type)) assert.ok(['A', 'W'].includes(e.name)); else assert.ok(Number.isInteger(e.id));
  }
  assert.deepStrictEqual(tr.events.map(e => e.t), tr.events.map(e => e.t).slice().sort((a, b) => a - b), 'events are in time order');
  assert.deepStrictEqual(Object.keys(r).sort(), ['alive', 'deploys', 'dp', 'duration', 'hpRemoved', 'hpTotal', 'kills', 'leaks', 'lifeLeft', 'lifeLost', 'lifePoints', 'losses', 'perOp', 'score', 'skillUses', 'timedOut', 'totalEnemies', 'trace', 'win']);
  assert.deepStrictEqual(Object.keys(r.perOp[0]), ['name', 'damage', 'healing', 'kills', 'blockedSeconds', 'damageTaken', 'skillUptime', 'died']);
  assert.strictEqual(r.score, sim.scoreOf(r));
  const { trace, ...withTrace } = r;
  assert.deepStrictEqual(withTrace, run(st, plan, { enemies: en() }), 'tracing does not change the result');
});

// ---------- (l) deployment rules ----------
ok('(l) canDeploy: MELEE on deployable ground, RANGED on deployable high ground, free and not forbidden', () => {
  const st = mkStage(['^^#.', '__._'], { forbidden: [{ r: 1, c: 3 }] }), melee = { name: 'M', position: 'MELEE' }, ranged = { name: 'R', position: 'RANGED' };
  assert.strictEqual(sim.canDeploy(st, melee, 1, 0), true); assert.strictEqual(sim.canDeploy(st, melee, 0, 0), false, 'melee on high');
  assert.strictEqual(sim.canDeploy(st, ranged, 0, 1), true); assert.strictEqual(sim.canDeploy(st, ranged, 1, 1), false, 'ranged on ground');
  assert.strictEqual(sim.canDeploy(st, melee, 1, 2), false, 'walkable but not deployable'); assert.strictEqual(sim.canDeploy(st, ranged, 0, 2), false, 'blocked tile');
  assert.strictEqual(sim.canDeploy(st, melee, 1, 3), false, 'forbidden tile'); assert.strictEqual(sim.canDeploy(st, melee, 2, 0), false, 'outside the map'); assert.strictEqual(sim.canDeploy(st, melee, 1, -1), false);
  assert.strictEqual(sim.canDeploy(st, melee, 1, 0, new Set([4])), false, 'occupied (Set of tile ids)'); assert.strictEqual(sim.canDeploy(st, melee, 1, 1, new Set([4])), true);
  assert.strictEqual(sim.canDeploy(st, melee, 1, 0, [4]), false, 'occupied (array of tile ids)'); assert.strictEqual(sim.canDeploy(st, melee, 1, 0, [{ r: 1, c: 0 }]), false, 'occupied ({r,c})');
  const bits = new Uint8Array(8); bits[4] = 1;
  assert.strictEqual(sim.canDeploy(st, melee, 1, 0, bits), false, 'occupied (bitmap)'); assert.strictEqual(sim.canDeploy(st, { name: 'X' }, 1, 0), false, 'no position');
  // real stage: the 3 tiles left of the cannon are forbidden in elite mode only (elite_runes / global_forbid_location)
  const real = stages.get('彼处水如酒');
  for (const r of [3, 4, 5]) { assert.strictEqual(sim.canDeploy(real, melee, r, 1), true); assert.strictEqual(sim.canDeploy(real, melee, r, 1, null, { elite: true }), false); }
  assert.strictEqual(sim.canDeploy(real, melee, 6, 1, null, { elite: true }), true); assert.strictEqual(sim.deployLimit(real, {}), 6); assert.strictEqual(sim.deployLimit(real, { secrecy: 15 }), 5);
});
ok('(l) an illegal plan throws a clear Error before the simulation starts', () => {
  const st = mkStage(CORRIDOR), en = () => [mkEnemy()], A = mkOp('A'), B = mkOp('B'), M = mkOp('M', { position: 'MELEE' });
  const bad = (plan, re, opts) => assert.throws(() => run(st, plan, { enemies: en(), ...opts }), re);
  bad({ deploys: [{ op: A, r: 1, c: 0, dir: 'E' }] }, /illegal deploy #0 \(A at r1 c0\): RANGED operators need a high-ground tile/);
  bad({ deploys: [{ op: M, r: 0, c: 0, dir: 'E' }] }, /MELEE operators need a ground tile/);
  bad({ deploys: [{ op: A, r: 0, c: 9, dir: 'E' }] }, /outside the map/);
  bad({ deploys: [{ op: A, r: 0, c: 0, dir: 'X' }] }, /dir must be E, S, W or N/);
  bad({ deploys: [{ op: A, r: 0, c: 0, dir: 'E' }, { op: B, r: 0, c: 0, dir: 'E' }] }, /illegal deploy #1 .*tile occupied by deploy #0 \(A\)/);
  bad({ deploys: [{ op: A, r: 0, c: 0, dir: 'E' }, { op: A, r: 0, c: 1, dir: 'E' }] }, /operator reused/);
  bad({ deploys: [{ r: 0, c: 0, dir: 'E' }] }, /no operator object/);
  bad({ deploys: [{ op: A, r: 0, c: 0, dir: 'E' }], retreats: [{ op: 'Z', t: 1 }] }, /illegal retreat: Z/);
  bad({ deploys: [{ op: A, r: 0, c: 0, dir: 'E' }], skills: { A: 'sometimes' } }, /illegal skill entry for A/);
  assert.throws(() => run(mkStage(CORRIDOR, { forbidden: [0] }), { deploys: [{ op: A, r: 0, c: 0, dir: 'E' }] }, { enemies: en() }), /forbidden/);
  // the same tile twice is legal once the first occupant has a planned retreat: the second deploy waits for it
  const swap = run(st, { deploys: [{ op: A, r: 0, c: 0, dir: 'E' }, { op: B, r: 0, c: 0, dir: 'E' }], retreats: [{ op: 'A', t: 3 }] }, { enemies: [mkEnemy({ v: 0.1, hp: 1e9 })] });
  assert.deepStrictEqual(swap.deploys.map(d => [d.name, d.t]), [['A', 0], ['B', 3]]);
  assert.throws(() => sim.simulate(st, { deploys: [] }, { enemies: [{ name: 'broken', hp: 0, path: [] }] }), /needs hp > 0 and a path/);
});

// ---------- (m) score ----------
ok('(m) scoreOf orders results exactly as compareResults does (lifeLost, HP fraction, deaths, duration)', () => {
  const mk = (lifeLost, hpRemoved, died, duration, retreats = 0) => ({ lifeLost, hpRemoved, hpTotal: 1000, duration,
    losses: [...Array(died).fill({ name: 'x', t: 1, cause: 'died' }), ...Array(retreats).fill({ name: 'y', t: 1, cause: 'retreat' })] });
  const best = mk(0, 1000, 0, 100), list = [mk(0, 1000, 0, 100.1), mk(0, 1000, 1, 50), mk(0, 1000, 3, 10), mk(0, 999, 0, 10), mk(0, 500, 0, 10), mk(0, 0, 0, 10),
    mk(1, 1000, 0, 10), mk(1, 400, 2, 300), mk(2, 1000, 0, 1), mk(30, 1000, 0, 1), mk(30, 0, 9, 2000)];
  let prev = best;
  for (const r of list) {       // the list is written from best to worst: each entry loses to the one before it
    assert.ok(sim.compareResults(prev, r) < 0 && sim.compareResults(r, prev) > 0, 'compareResults order'); assert.ok(sim.scoreOf(prev) > sim.scoreOf(r), 'scoreOf order');
    prev = r;
  }
  const all = [best, ...list];
  for (const a of all) for (const b of all) assert.strictEqual(Math.sign(sim.compareResults(a, b)), Math.sign(sim.scoreOf(b) - sim.scoreOf(a)), 'same sign for every pair');
  assert.deepStrictEqual(all.slice().reverse().sort(sim.compareResults), all, 'sort(compareResults) puts the best first');
  assert.strictEqual(sim.compareResults(mk(0, 1000, 0, 100, 3), best), 0, 'planned retreats are not losses'); assert.strictEqual(sim.scoreOf(mk(0, 1000, 0, 100, 3)), sim.scoreOf(best));
  assert.strictEqual(sim.TPS_DEFAULT, 0.5);
});

// ---------- (h) wave scripts that outlast their spawns ----------
ok('(h) a wave lasts as long as its script: a trailing non-SPAWN action and an enemy-less wave delay the next wave', () => {
  // wave 0: one 源石虫 (speed 1 -> 0.5 tiles/s, leaks at 10 s) and a trap activation at 30 s; wave 1: EMPTY at 5 s;
  // wave 2: preDelay 2 s, one 源石虫. Expected: wave 1 at 30 s, wave 2 at 35 s, its enemy at 37 s, leak at 47 s.
  const spawn = pre => ({ actionType: 'SPAWN', key: 'enemy_1007_slime', count: 1, preDelay: pre, interval: 0, routeIndex: 0 });
  const mc = { routes: [{ startPosition: { row: 0, col: 0 }, endPosition: { row: 0, col: 5 }, checkpoints: [], motionMode: 'WALK' }], enemies: [],
    waves: [{ preDelay: 0, postDelay: 0, maxTimeWaitingForNextWave: -1, fragments: [{ preDelay: 0, actions: [spawn(0), { actionType: 'ACTIVATE_PREDEFINED', key: 'trap_x', count: 1, preDelay: 30, interval: 0 }] }] },
      { preDelay: 0, postDelay: 0, maxTimeWaitingForNextWave: -1, fragments: [{ preDelay: 0, actions: [{ actionType: 'EMPTY', count: 1, preDelay: 5, interval: 0 }] }] },
      { preDelay: 2, postDelay: 0, maxTimeWaitingForNextWave: -1, fragments: [{ preDelay: 0, actions: [spawn(0)] }] }] };
  const st = mkStage(CORRIDOR, { mc }), en = sim.sampleEnemies(st, { modApi });
  assert.deepStrictEqual(en.meta.waveSpans, [30, 5, 2]); assert.deepStrictEqual(en.map(e => [e.wave, e.spawn, e.waveSpan]), [[0, 0, 30], [2, 37, 2]]);
  const r = run(st, { deploys: [] }, { trace: true });
  assert.deepStrictEqual(events(r, 'wave').map(e => [e.id, e.t]), [[0, 0], [1, 30], [2, 35]]); near(r.duration, 47, 2 * DT, 'last leak');
  near(run(st, { deploys: [] }, { enemies: [...en] }).duration, 42, 2 * DT, 'a copied list keeps waveSpan per enemy but loses the enemy-less wave');
});

// ---------- (n) skills.js extensions: stages, ammo, onDeploy, instant range/hits/selfHeal ----------
const BASE = { hp: 1000, atk: 100, def: 0, res: 0, block: 0, interval: 1, damageType: 'physical', targets: 1, canHitAir: true, range: ALL_ROW_BELOW, atkScale: 1, hits: 1, attacks: true };
const withProfiles = (name, spec, base, active, more) => mkOp(name, { skillSpec: spec, profiles: { base, active, ...more } });
const one = (op, plan, enemies, opts) => run(mkStage(CORRIDOR), { deploys: [{ op, r: 0, c: 0, dir: 'E' }], ...plan }, { enemies, ...opts });
ok('(n) profiles.stages: the n-th use runs stages[min(n, length) - 1]', () => {
  const spec = mkSpec({ spCost: 1, initSp: 1, duration: 2 }), idle = { ...BASE, attacks: false };
  const s0 = { ...BASE, atk: 200 }, s1 = { ...BASE, atk: 400 }, en = () => [mkEnemy({ hp: 1e9 })];
  const staged = one(withProfiles('T', spec, idle, s0, { stages: [s0, s1] }), { skills: { T: [0, 3] } }, en());
  assert.deepStrictEqual(staged.skillUses.map(u => [u.t, u.end]), [[0, 2], [3, 5]]);
  assert.strictEqual(staged.hpRemoved, 2 * 200 + 2 * 400, 'use 1: two attacks of 200, use 2: two of 400');
  assert.strictEqual(one(withProfiles('T', spec, idle, s0), { skills: { T: [0, 3] } }, en()).hpRemoved, 4 * 200, 'without stages: profiles.active');
});
ok('(n) spec.ammo: the use ends after that many attacks; spec.onDeploy: active from the deployment, never re-fired', () => {
  const idle = { ...BASE, attacks: false }, en = () => [mkEnemy({ hp: 1e9 })];
  const ammo = one(withProfiles('A', mkSpec({ initSp: 10, duration: -1, ammo: 3 }), idle, BASE), {}, en());
  assert.strictEqual(ammo.hpRemoved, 300, 'three attacks'); near(ammo.skillUses[0].end, 2.1, DT, 'ends after the third attack (at 2 s)');
  const spec = mkSpec({ trigger: 'PASSIVE', spType: 'NONE', spCost: 0, initSp: 0, duration: 5, onDeploy: true });
  const r = run(mkStage(CORRIDOR), { deploys: [{ op: withProfiles('P', spec, BASE, { ...BASE, atk: 300 }), r: 0, c: 0, dir: 'E', t: 2 }] }, { enemies: en() });
  assert.deepStrictEqual(r.skillUses.map(u => [u.t, u.end]), [[2, 7]]);
  assert.strictEqual(r.hpRemoved, 5 * 300 + 3 * 100, 'attacks at 2-6 s active, 7-9 s base'); near(r.perOp[0].skillUptime, 5, 1e-6, 'uptime');
});
ok('(n) instant extensions: damage.hits and damage.range (rotated), heal.range, selfHeal {hpRatio}', () => {
  const blind = { ...BASE, range: [] }, en = () => [0, 1, 2].map(id => mkEnemy({ id, hp: 1e6 }));
  const nuke = range => one(withProfiles('N', mkSpec({ initSp: 10, duration: 0, instant: { damage: { scale: 1, hits: 2, damageType: 'true', targets: 9, range } } }), blind, blind), { skills: { N: [1] } }, en());
  assert.strictEqual(nuke(ALL_ROW_BELOW).hpRemoved, 3 * 2 * 100, '3 targets x 2 hits x 100'); assert.strictEqual(nuke(undefined).hpRemoved, 0, 'no damage.range: the (empty) active range');
  // facing S from (0,3): {dr:0,dc:1} becomes the corridor tile (1,3)
  const front = run(mkStage(CORRIDOR), { deploys: [{ op: withProfiles('N', mkSpec({ initSp: 10, duration: 0, instant: { damage: { scale: 1, damageType: 'true', targets: 9, range: FRONT } } }), blind, blind), r: 0, c: 3, dir: 'S' }], skills: { N: [5.5] } }, { enemies: en() });
  assert.strictEqual(front.hpRemoved, 300, 'all three stand on (1,3) at 5.5 s');
  // the blocker is hit at 5, 6, 7, 8 s (400 of 500 HP), heals itself to full at 8.5 s and dies after 5 more hits
  const wall = mkOp('W', { position: 'MELEE', block: 1, damageType: 'none', hp: 500, range: [{ dr: 0, dc: 0 }], skillSpec: mkSpec({ initSp: 10, duration: 0, instant: { selfHeal: { hpRatio: 1 } } }) });
  const r = run(mkStage(CORRIDOR), { deploys: [{ op: wall, r: 1, c: 3, dir: 'W' }], skills: { W: [8.5] } }, { enemies: [mkEnemy({ atk: 100, interval: 1 })] });
  assert.strictEqual(r.perOp[0].healing, 400); near(r.losses[0].t, 13, 2 * DT, 'dies 4 s later than without the heal');
  // heal.range: a medic whose own range is empty heals the injured operator through the instant's range
  const shooter = [mkEnemy({ atk: 100, hp: 1e9, applyWay: 'RANGED', rangeRadius: 1.5 })];
  const medic = range => mkOp('M', { damageType: 'heal', range: [], skillSpec: mkSpec({ initSp: 0, spCost: 1, duration: 0, instant: { heal: { scale: 2, targets: 1, range } } }) });
  const plan = range => ({ deploys: [{ op: mkOp('Hurt', { damageType: 'none', hp: 5000 }), r: 0, c: 2, dir: 'E' }, { op: medic(range), r: 0, c: 0, dir: 'E' }] });
  assert.ok(run(mkStage(CORRIDOR), plan([{ dr: 0, dc: 2 }]), { enemies: shooter }).perOp[1].healing > 0); assert.strictEqual(run(mkStage(CORRIDOR), plan(undefined), { enemies: shooter }).perOp[1].healing, 0);
});

// ---------- (n) optional profile fields (skills.js header) ----------
ok('(n) hitsByTarget, atkScaleByType, bonusHit, resIgnore', () => {
  const p = over => withProfiles('X', null, { ...BASE, ...over }, { ...BASE, ...over });
  const twoEnemies = () => [mkEnemy({ id: 0, hp: 1e9 }), mkEnemy({ id: 1, hp: 1e9, spawn: 1 })];
  // attacks at 0..10 s: at 0 s only enemy 0, at 1-9 s both, at 10 s only enemy 1 (enemy 0 left at 10 s)
  assert.strictEqual(one(p({ targets: 2 }), {}, twoEnemies()).hpRemoved, 2000);
  assert.strictEqual(one(p({ targets: 2, hitsByTarget: [3, 1] }), {}, twoEnemies()).hpRemoved, 300 + 9 * 400 + 300, 'first target 3 hits, second 1');
  const typed = type => one(p({ atkScaleByType: { ELITE: 2, BOSS: 3 } }), {}, [mkEnemy({ hp: 1e9, extra: { type } })]).hpRemoved;
  assert.deepStrictEqual(['NORMAL', 'ELITE', 'BOSS'].map(typed), [1000, 2000, 3000]);
  assert.strictEqual(one(p({ bonusHit: { scale: 0.5, damageType: 'arts' } }), {}, [mkEnemy({ hp: 1e9, def: 50, res: 50 })]).hpRemoved, 10 * (50 + 25), '100-50 physical + 50 x 50% arts');
  assert.strictEqual(one(p({ damageType: 'arts', resIgnore: 20 }), {}, [mkEnemy({ hp: 1e9, res: 50 })]).hpRemoved, 10 * 70, 'RES 50 - 20');
});
ok('(n) damageNegateProb (expected value), thorns (also kills), hpRegenPerSec', () => {
  const st = mkStage(CORRIDOR), tank = over => mkOp('T', { position: 'MELEE', block: 1, damageType: 'none', hp: 1e6, def: 60, range: [{ dr: 0, dc: 0 }], ...over });
  const go = (over, en, opts) => run(st, { deploys: [{ op: tank(over), r: 1, c: 3, dir: 'W' }] }, { enemies: en, maxTime: 15.05, ...opts });
  const plain = go({}, [mkEnemy({ atk: 100 })]), hits = plain.perOp[0].damageTaken / 40;
  assert.strictEqual(go({ damageNegateProb: 0.5 }, [mkEnemy({ atk: 100 })]).perOp[0].damageTaken, hits * 20);
  const th = go({ atk: 100, thorns: { scale: 0.5, damageType: 'physical' } }, [mkEnemy({ atk: 100, hp: 1e9 })]);
  assert.strictEqual(th.hpRemoved, hits * 50, '50 back per enemy attack'); assert.strictEqual(th.perOp[0].damage, th.hpRemoved);
  const kill = go({ atk: 100, thorns: { scale: 0.5, damageType: 'physical' } }, [mkEnemy({ atk: 100, hp: 120 }), mkEnemy({ id: 1, atk: 100, hp: 120, spawn: 0.5 })], { maxTime: 60 });
  assert.strictEqual(kill.kills, 2, 'thorns kill both attackers'); assert.strictEqual(kill.kills + kill.leaks + kill.alive, 2);
  const wall = over => mkOp('W', { position: 'MELEE', block: 1, damageType: 'none', hp: 500, range: [{ dr: 0, dc: 0 }], ...over });
  const regen = run(st, { deploys: [{ op: wall({ hpRegenPerSec: 10 }), r: 1, c: 3, dir: 'W' }] }, { enemies: [mkEnemy({ atk: 100 })] });
  near(regen.losses[0].t, 10, 2 * DT, '+10 HP/s: 400, 310, 220, 130, 40, dead at the sixth hit');
});
ok('(n) prefersAir targets FLY enemies first', () => {
  const p = air => withProfiles('X', null, { ...BASE, prefersAir: air }, { ...BASE, prefersAir: air });
  const en = () => [mkEnemy({ id: 0, hp: 1e9 }), mkEnemy({ id: 1, hp: 300, motion: 'FLY', spawn: 2 })];
  const r = one(p(true), {}, en(), { trace: true });
  assert.strictEqual(r.kills, 1); near(events(r, 'kill')[0].t, 4, DT, 'hit at 2, 3, 4 s');
  assert.strictEqual(one(p(false), {}, en()).kills, 0, 'otherwise the ground enemy closer to the exit is shot');
});
ok('(n) hpDrain rises linearly to ratioPerSec x max HP; deathDelay keeps the operator at 1 HP for its seconds', () => {
  const drain = { ratioPerSec: 0.1, rampSeconds: 10 }, idle = { ...BASE, attacks: false }, en = () => [mkEnemy({ v: 0.1, hp: 1e9 })];
  // drained: 5 t^2 for t <= 10 (500 HP), then 100 HP/s: 1000 HP gone at 15 s
  const r = one(withProfiles('S', mkSpec({ initSp: 10, duration: -1 }), idle, { ...idle, hpDrain: drain }), { skills: { S: [0] } }, en());
  near(r.losses[0].t, 15, 2 * DT, 'drained to 0'); assert.strictEqual(r.perOp[0].damageTaken, 0, 'drain is not enemy damage'); assert.strictEqual(r.losses[0].cause, 'died');
  const d = one(withProfiles('S', mkSpec({ initSp: 10, duration: -1 }), idle, { ...idle, hpDrain: drain, deathDelay: 4 }), { skills: { S: [0] } }, en(), { trace: true });
  near(d.losses[0].t, 19, 2 * DT, '4 s at 1 HP'); assert.strictEqual(d.skillUses[0].end, d.losses[0].t);
  assert.ok(d.trace.frames.some(f => f.t > 16 && f.t < 18.5 && f.ops.length === 1 && f.ops[0][1] === 0.001), 'shown at 1/1000 HP meanwhile');
  const flat = one(withProfiles('S', null, { ...idle, hpDrainPerSec: 100 }, { ...idle, hpDrainPerSec: 100 }), {}, en());
  near(flat.losses[0].t, 10, 2 * DT, 'hpDrainPerSec: 1000 HP at 100 HP/s');
});
ok('(n) dot: poison after every hit (arts vs RES), dpsVsRanged, kills count', () => {
  const p = over => withProfiles('X', null, { ...BASE, damageType: 'true', interval: 100, ...over }, { ...BASE, damageType: 'true', interval: 100, ...over });
  const dot = { dps: 50, duration: 3, damageType: 'arts' };
  near(one(p({ dot }), {}, [mkEnemy({ hp: 1e9, res: 50 })]).hpRemoved, 100 + 3 * 25, 1e-6, 'one hit of 100, then 25/s for 3 s');
  near(one(p({ dot: { ...dot, dpsVsRanged: 100 } }), {}, [mkEnemy({ hp: 1e9, res: 50, atk: 1, applyWay: 'RANGED', rangeRadius: 0.5 })]).hpRemoved, 100 + 3 * 50, 1e-6, 'dpsVsRanged on a ranged enemy');
  const k = one(p({ dot }), {}, [mkEnemy({ hp: 150, res: 50 }), mkEnemy({ id: 1, hp: 1e9, spawn: 3 })], { trace: true });
  assert.strictEqual(k.kills, 1); near(events(k, 'kill')[0].t, 2, DT, '50 HP left after the hit, 25/s'); assert.strictEqual(k.perOp[0].kills, 1);
  assert.strictEqual(k.kills + k.leaks + k.alive, 2);
});
ok('(n) collectible rules (deployLimit, meleeOnHighGround) and op.anyTile', () => {
  const st = mkStage(CORRIDOR, { deployLimit: 2 }), melee = { name: 'M', position: 'MELEE' };
  assert.strictEqual(sim.deployLimit(st, { rules: [{ rule: 'deployLimit', add: 1 }] }), 3);
  assert.strictEqual(sim.deployLimit(st, { secrecy: 15, rules: [{ rule: 'deployLimit', add: 1 }, { rule: 'deployLimit', add: -1, source: 'secrecy N10: deploy limit -1' }] }), 2, 'the secrecy rule is not counted twice');
  assert.strictEqual(sim.canDeploy(st, melee, 0, 0), false); assert.strictEqual(sim.canDeploy(st, melee, 0, 0, null, { rules: [{ rule: 'meleeOnHighGround' }] }), true);
  assert.strictEqual(sim.canDeploy(st, { ...melee, anyTile: true }, 0, 0), true); assert.strictEqual(sim.canDeploy(st, { ...melee, anyTile: true }, 1, 0), true);
  const hook = mkOp('H', { position: 'MELEE', anyTile: true, block: 2, damageType: 'none' });
  assert.strictEqual(run(st, { deploys: [{ op: hook, r: 0, c: 3, dir: 'S' }] }, { enemies: [mkEnemy()] }).leaks, 1, 'on high ground it blocks nothing');
  const three = ['A', 'B', 'C'].map((n, c) => ({ op: mkOp(n, { damageType: 'none' }), r: 0, c, dir: 'E' }));
  assert.strictEqual(run(st, { deploys: three }, { enemies: [mkEnemy()], rules: [{ rule: 'deployLimit', add: 1 }] }).deploys.length, 3);
});

// ---------- extras: healing, ranged enemies, hidden path legs, performance ----------
ok('healer heals the most injured operator in range; a ranged enemy shoots without stopping', () => {
  // the enemy (range 1.5, 100 ATK every 1 s) passes two high-ground operators; it targets the one deployed last
  const st = mkStage(CORRIDOR), idle = { damageType: 'none', hp: 2000 }, shooter = () => [mkEnemy({ atk: 100, hp: 1e9, applyWay: 'RANGED', rangeRadius: 1.5 })];
  const plan = heal => ({ deploys: [{ op: mkOp('First', idle), r: 0, c: 2, dir: 'S' }, { op: mkOp('Last', idle), r: 0, c: 3, dir: 'S' }]
    .concat(heal ? [{ op: mkOp('Medic', { damageType: 'heal', atk: 50, interval: 1, range: [{ dr: 0, dc: 1 }, { dr: 0, dc: 2 }] }), r: 0, c: 5, dir: 'W' }] : []) });
  const r = run(st, plan(false), { enemies: shooter() });
  near(r.duration, 10, DT, 'it never stops'); assert.strictEqual(r.perOp[0].damageTaken + r.perOp[1].damageTaken > 0, true);
  assert.ok(r.perOp[1].damageTaken > r.perOp[0].damageTaken, 'the most recently deployed operator in range is shot first');
  const h = run(st, plan(true), { enemies: shooter() });         // medic at (0,5) facing W reaches (0,4) and (0,3): only "Last"
  assert.ok(h.perOp[2].healing > 0 && h.perOp[2].healing <= h.perOp[1].damageTaken, 'heals what was lost, never more'); assert.strictEqual(h.perOp[2].damage, 0);
});
ok('hidden path legs (DISAPPEAR..APPEAR) are untargetable and unblockable', () => {
  // walks tiles 0-2 (0-4 s), is hidden for 6 s, reappears on tile 4 and leaves over tile 5 at 12 s
  const path = [{ r: 1, c: 0, t: 0 }, { r: 1, c: 1, t: 2 }, { r: 1, c: 2, t: 4, hidden: true }, { r: 1, c: 2, t: 10, hidden: true }, { r: 1, c: 4, t: 10 }, { r: 1, c: 5, t: 12 }];
  const st = mkStage(CORRIDOR), en = () => [mkEnemy({ hp: 1e9, extra: { path } })];
  const r = run(st, { deploys: [{ op: mkOp('A'), r: 0, c: 0, dir: 'E' }] }, { enemies: en(), trace: true });
  assert.strictEqual(r.hpRemoved, 600, 'hit at 0-3 s and at 10, 11 s only'); assert.ok(r.trace.frames.filter(f => f.t > 4.2 && f.t < 9.8).every(f => f.enemies.length === 0), 'not drawn while hidden');
  const wall = mkOp('Wall', { position: 'MELEE', block: 1, damageType: 'none', range: [{ dr: 0, dc: 0 }] });
  assert.strictEqual(run(st, { deploys: [{ op: wall, r: 1, c: 3, dir: 'W' }] }, { enemies: en() }).leaks, 1, 'teleports past the blocker on tile 3');
});
ok('performance: 彼处水如酒 with 6 operators, no trace, well under 50 ms per simulate()', () => {
  const st = stages.get('彼处水如酒'), enemies = sim.sampleEnemies(st, { modApi }), deploys = [];
  const melee = r => mkOp('M' + r, { position: 'MELEE', cost: 12, block: 2, hp: 3000, atk: 600, def: 400, interval: 1.2, range: [{ dr: 0, dc: 0 }, { dr: 0, dc: 1 }], skillSpec: mkSpec() });
  const ranged = r => mkOp('R' + r, { cost: 14, atk: 500, interval: 1, targets: 2, range: [-1, 0, 1].flatMap(dr => [0, 1, 2, 3].map(dc => ({ dr, dc }))), skillSpec: mkSpec({ spCost: 20, duration: 10 }) });
  // 3 melee operators on the busiest deployable path tiles, 3 ranged ones on the high tiles closest to them
  const busy = new Map();
  for (const e of enemies) for (const p of e.path) if (!p.hidden) busy.set(p.r * st.W + p.c, (busy.get(p.r * st.W + p.c) || 0) + 1);
  const tiles = [];
  for (let r = 0; r < st.H; r++) for (let c = 0; c < st.W; c++) tiles.push({ r, c, n: busy.get(r * st.W + c) || 0 });
  const ground = tiles.filter(t => sim.canDeploy(st, melee(0), t.r, t.c)).sort((a, b) => b.n - a.n).slice(0, 3);
  const dist = t => Math.min(...ground.map(g => Math.abs(g.r - t.r) + Math.abs(g.c - t.c)));
  const high = tiles.filter(t => sim.canDeploy(st, ranged(0), t.r, t.c)).sort((a, b) => dist(a) - dist(b)).slice(0, 3);
  ground.forEach((t, k) => deploys.push({ op: melee(k), r: t.r, c: t.c, dir: 'E' }));
  high.forEach((t, k) => deploys.push({ op: ranged(k), r: t.r, c: t.c, dir: 'S' }));
  assert.strictEqual(deploys.length, 6);
  const plan = { deploys }, times = [];
  let res;
  for (let k = 0; k < 30; k++) { const t0 = process.hrtime.bigint(); res = run(st, plan, { enemies }); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  times.sort((a, b) => a - b);
  const median = times[15];
  console.log(`   (${res.deploys.length} deployed, ${res.kills} kills, ${res.leaks} leaks, fight ${res.duration} s; median ${median.toFixed(2)} ms, max ${times[29].toFixed(2)} ms over 30 runs)`);
  assert.strictEqual(res.kills + res.leaks + res.alive, res.totalEnemies); assert.ok(res.hpRemoved <= res.hpTotal + 1e-6);
  assert.ok(median < 50, `median ${median} ms must be under 50 ms`);
});

console.log(`\n${passed} checks passed`);
