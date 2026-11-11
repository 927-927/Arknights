// Integration test: operators.js + skills.js + sim.js on real game data (roster.example.json, real stages).
// Run: node combat/test_integration.js   (one line per passed check, non-zero exit on the first failure)
'use strict';
const assert = require('node:assert');
const O = require('./operators.js');
const K = require('./skills.js');
const sim = require('./sim.js');
const sm = require('./stage_model.js');

let passed = 0;
const ok = (name, fn) => { const info = fn(); console.log(`ok ${++passed} - ${name}${info ? '  [' + info + ']' : ''}`); };
const DT = sim.DT_DEFAULT;
const relNear = (x, want, rel, what) => assert.ok(Math.abs(x - want) <= rel * Math.max(1, Math.abs(want)), `${what}: got ${x}, want ${want}`);

// every number anywhere in a value is finite (no NaN / Infinity), with the path of the first offender
function assertFinite(v, where = 'result') {
  if (typeof v === 'number') { assert.ok(Number.isFinite(v), `${where} is ${v}`); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => assertFinite(x, `${where}[${i}]`)); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertFinite(x, `${where}.${k}`);
}

// Conservation, accounting and trace consistency of one result (the stage-independent part of the checks).
function checkResult(res, enemies, lifePoints) {
  assertFinite(res);
  assert.strictEqual(res.kills + res.leaks + res.alive, res.totalEnemies, 'every enemy is killed, leaked or still alive');
  assert.strictEqual(res.totalEnemies, enemies.length);
  if (!res.timedOut) assert.strictEqual(res.alive, 0, 'a fight that did not time out has no enemy left');
  assert.ok(res.hpRemoved >= 0 && res.hpRemoved <= res.hpTotal * (1 + 1e-12), 'hpRemoved within [0, hpTotal]');
  relNear(res.perOp.reduce((s, p) => s + p.damage, 0), res.hpRemoved, 1e-9, 'sum of perOp damage = hpRemoved');
  relNear(res.hpTotal, enemies.reduce((s, e) => s + e.hp, 0), 1e-12, 'hpTotal = sum of enemy HP');
  // DP: never negative, and initial + generated + refunded - spent = what is left
  relNear(res.dp.initial + res.dp.generated + res.dp.refunded - res.dp.spent, res.dp.endUnspent, 1e-6, 'DP accounting');
  assert.ok(res.dp.endUnspent >= 0);
  if (res.trace) {
    for (const f of res.trace.frames) assert.ok(f.dp >= 0, `DP ${f.dp} < 0 at ${f.t}`);
    const ev = type => res.trace.events.filter(e => e.type === type);
    assert.strictEqual(ev('kill').length, res.kills);
    assert.strictEqual(ev('leak').length, res.leaks);
    const life = new Map(enemies.map(e => [e.id, e.life]));
    assert.strictEqual(ev('leak').reduce((s, e) => s + life.get(e.id), 0), res.lifeLost, 'lifeLost = life of the leaked enemies');
    assert.strictEqual(res.lifeLeft, Math.max(0, lifePoints - res.lifeLost));
    // events line up with result.deploys / skillUses / losses
    assert.deepStrictEqual(ev('deploy').map(e => [e.name, e.t]), res.deploys.map(d => [d.name, d.t]));
    assert.deepStrictEqual(ev('skill').map(e => [e.name, e.t]), res.skillUses.map(u => [u.name, u.t]));
    assert.deepStrictEqual(ev('opDown').map(e => [e.name, e.t, e.cause]), res.losses.map(l => [l.name, l.t, l.cause]));
    const ends = ev('skillEnd');
    for (const u of res.skillUses) {
      assert.ok(u.end >= u.t && u.end <= res.duration + 1e-9, `${u.name} use ${u.t}-${u.end}`);
      if (u.end === u.t) continue;                          // instant skill
      // a use ends with a skillEnd event, or with its operator leaving the field, or with the end of the fight
      const ended = ends.some(e => e.name === u.name && e.t === u.end) || res.losses.some(l => l.name === u.name && l.t === u.end) || u.end === res.duration;
      assert.ok(ended, `${u.name} use at ${u.t} ends at ${u.end} without a matching event`);
    }
    for (const e of ends) assert.ok(res.skillUses.some(u => u.name === e.name && u.end === e.t), `skillEnd of ${e.name} at ${e.t} has no use`);
    for (let k = 1; k < res.trace.events.length; k++) assert.ok(res.trace.events[k].t >= res.trace.events[k - 1].t, 'events in time order');
  }
  for (const d of res.deploys) assert.ok(d.t >= 0 && d.t <= res.duration + 1e-9);
}

// ---------- fixtures ----------
const R = O.loadRoster(require('path').join(__dirname, 'roster.example.json'));
const by = Object.fromEntries(R.operators.map(o => [o.name, o]));
const BASE = { secrecy: R.secrecy, floor: R.floor, rules: R.rules };     // N15 floor 5, collectible rules (地形图, 舞鞋)
const CONTRACT_SKILLS = { 桃金娘: 1, 德克萨斯: 2, 塞雷娅: 2, 星熊: 2, 银灰: 3, 史尔特尔: 3, 能天使: 3, 蓝毒: 2, 艾雅法拉: 3, 逻各斯: 3, 夜莺: 3, 棘刺: 3 };
const live = op => { const s = K.compileSkill(op); return s.fidelity !== 'unsupported' && (s.trigger === 'MANUAL' || s.trigger === 'AUTO'); };

// 彼处水如酒 (ro6_n_5_5), map from `node combat/stage_model.js 彼处水如酒` (r from the top, c from the left):
//   r0  # # S # # # # # # # O O O       S spawn, E exit (2,4), T teleport, ^ high ground, _ deployable ground
//   r1  # . . # _ _ _ _ _ . . S O       row 1: 恐怖厨子, 噩兆飞鳞, 美声水手长 walk c11 -> c4 to the exit
//   r2  # . . # E # ^ ^ ^ # O O O
//   r3  # _ _ # . # T _ _ _ _ _ T       rows 3-4, c7-11: the 4 裂地盐鳞 (100k HP) circle here: most HP-seconds
//   r4  # _ . # . # T _ _ _ . _ T
//   r5  # _ ^ ^ . # ^ ^ ^ ^ # # #
//   r6  # _ # ^ . _ _ _ _ _ . . S       row 6: the 20 历险水手 walk c12 -> c4, then up column 4
//   r7  # T # # T # # # # # # # #
// Plan: 桃金娘 first for DP at the head of the 历险水手 lane, the two casters on the high ground between the loop
// and that lane, 星熊 holds the lane, 银灰 on high ground above the loop (MELEE on high ground: 漆黑的舞鞋 rule),
// 塞雷娅 holds row 1. 6 operators = characterLimit 6 - 1 (N10) + 1 (地形图).
const STAGE1 = sm.loadStage('彼处水如酒');
const PLAN1 = { deploys: [
  { op: by['桃金娘'], r: 6, c: 9, dir: 'E' },
  { op: by['艾雅法拉'], r: 5, c: 6, dir: 'E' },
  { op: by['星熊'], r: 6, c: 5, dir: 'E' },
  { op: by['逻各斯'], r: 5, c: 7, dir: 'N' },
  { op: by['银灰'], r: 2, c: 7, dir: 'S' },
  { op: by['塞雷娅'], r: 1, c: 6, dir: 'E' },
], skills: { 银灰: { minEnemiesInRange: 2 } } };

// A legal plan from the enemy HP-seconds per tile (nominal paths): each operator in turn takes the free legal
// tile and facing whose range covers the most HP-seconds it can hit (FLY counted only for canHitAir).
function autoPlan(st, names, opts) {
  const en = sim.sampleEnemies(st, opts), W = st.W, H = st.H, wG = new Float64Array(H * W), wA = new Float64Array(H * W);
  for (const e of en) for (let k = 1; k < e.path.length; k++) {
    const a = e.path[k - 1], b = e.path[k];
    if (a.hidden || a.r < 0 || a.c < 0 || a.r >= H || a.c >= W) continue;
    (e.motion === 'FLY' ? wA : wG)[a.r * W + a.c] += (b.t - a.t) * e.hp;
  }
  const occ = new Set(), deploys = [];
  for (const n of names) {
    const op = by[n];
    let best = null;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      if (!sim.canDeploy(st, op, r, c, occ, opts)) continue;
      for (const dir of ['E', 'S', 'W', 'N']) {
        let s = 0;
        for (const o of O.rotate(op.range, dir)) {
          const rr = r + o.dr, cc = c + o.dc;
          if (rr >= 0 && cc >= 0 && rr < H && cc < W) s += wG[rr * W + cc] + (op.canHitAir ? wA[rr * W + cc] : 0);
        }
        if (!best || s > best.s) best = { r, c, dir, s };
      }
    }
    assert.ok(best, `no legal tile for ${n} on ${st.name}`);
    occ.add(best.r * W + best.c);
    deploys.push({ op, r: best.r, c: best.c, dir: best.dir });
  }
  return { deploys };
}

// A synthetic stage ('^' high ground, '_' deployable ground) and a single enemy standing on one tile, for checks
// that need exact numbers out of the simulator with real operators.
function mkStage(rows) {
  const grid = rows.map(row => [...row].map(ch => ({ key: ch === '^' ? 'tile_wall' : 'tile_road', high: ch === '^', walkable: ch === '_', deployable: true, hole: false })));
  return { H: rows.length, W: rows[0].length, grid, name: 'synthetic', id: 'syn', deployLimit: 8, initialCost: 99, toGrid: p => ({ r: rows.length - 1 - p.row, c: p.col }) };
}
function standing(r, c, o = {}) {
  return { id: 0, key: 'syn', name: 'dummy', type: o.type || 'NORMAL', motion: 'WALK', hp: o.hp ?? 1e12, atk: o.atk ?? 0, def: o.def ?? 0, res: o.res ?? 0,
    speed: 1, interval: o.interval ?? 1000, life: 1, rangeRadius: o.rangeRadius ?? -1, applyWay: o.applyWay || 'MELEE', attackMode: o.attackMode || 'melee',
    damageType: o.damageType || 'physical', hits: 1, damageTaken: o.damageTaken ?? 1, wave: 0, frag: 0, group: null, spawn: o.spawn ?? 0, waveT: o.spawn ?? 0,
    path: [{ r, c, t: 0 }, { r, c, t: 1e7 }] };
}
const perOp = (res, name) => res.perOp.find(p => p.name === name);

// ---------- roster ----------
ok('loadRoster(roster.example.json): 12 operators, E2, the contract skills, all compiled from skill_table (none unsupported)', () => {
  assert.strictEqual(R.operators.length, 12);
  assert.strictEqual(R.secrecy, 15); assert.strictEqual(R.floor, 5);
  for (const op of R.operators) {
    assert.strictEqual(op.elite, 2, op.name);
    assert.strictEqual(op.skillIndex + 1, CONTRACT_SKILLS[op.name], op.name);
    assert.ok(op.skillId && O.table('skill_table')[op.skillId], `${op.name}: skillId in skill_table`);
    const s = K.compileSkill(op), lv = K.skillLevelData(op);
    assert.notStrictEqual(s.fidelity, 'unsupported', `${op.name}: ${s.notes.join('; ')}`);
    assert.strictEqual(s.spCost, lv.spData.spCost, op.name);
    assert.strictEqual(s.name, lv.name, op.name);
  }
  const row = op => { const s = K.compileSkill(op); return `${op.name} S${op.skillIndex + 1} ${s.trigger}/${s.spType} ${s.fidelity}`; };
  return R.operators.map(row).join(', ');
});

// ---------- 彼处水如酒, N15 floor 5 ----------
const E1 = sim.sampleEnemies(STAGE1, BASE);
const RES1 = sim.simulate(STAGE1, PLAN1, { ...BASE, trace: true });

ok('彼处水如酒 N15 floor 5, 6-operator plan: no throw, conservation, DP accounting, no NaN, trace consistent', () => {
  assert.strictEqual(sim.deployLimit(STAGE1, BASE), 6, 'characterLimit 6, -1 at N10, +1 地形图');
  checkResult(RES1, E1, sim.LIFE_POINTS_DEFAULT);
  assert.strictEqual(RES1.deploys.length, 6, 'all six deployed');
  assert.ok(RES1.kills > 0 && RES1.hpRemoved > 0);
  return `kills ${RES1.kills}/${RES1.totalEnemies}, leaks ${RES1.leaks}, HP removed ${(100 * RES1.hpRemoved / RES1.hpTotal).toFixed(1)}%, losses ${RES1.losses.map(l => l.name + '@' + l.t).join(' ') || 'none'}, deploys at ${RES1.deploys.map(d => d.t).join('/')} s`;
});

ok('every deployed operator with a supported MANUAL/AUTO skill shows skillUses (星熊 S2 is PASSIVE: none)', () => {
  for (const d of PLAN1.deploys) {
    const n = RES1.skillUses.filter(u => u.name === d.op.name).length;
    if (live(d.op)) assert.ok(n > 0, `${d.op.name} never used its skill`);
    else assert.strictEqual(n, 0, d.op.name);
  }
  // every use of a TIME skill with a duration lasts its duration unless the fight or the operator ended first
  for (const u of RES1.skillUses) {
    const s = K.compileSkill(by[u.name]);
    if (s.duration > 0 && !s.stages && !s.ammo && u.end < RES1.duration && !RES1.losses.some(l => l.name === u.name && l.t === u.end)) assert.ok(Math.abs(u.end - u.t - s.duration) <= DT + 1e-9, `${u.name} ${u.t}-${u.end}`);
  }
  const count = {};
  for (const u of RES1.skillUses) count[u.name] = (count[u.name] || 0) + 1;
  return Object.entries(count).map(([k, v]) => `${k} x${v}`).join(', ');
});

ok('explicit skill times = result.skillUses of the policy run reproduce that run exactly (idempotent, within one tick)', () => {
  const times = {};
  for (const d of PLAN1.deploys) times[d.op.name] = RES1.skillUses.filter(u => u.name === d.op.name).map(u => u.t);
  const res = sim.simulate(STAGE1, { deploys: PLAN1.deploys, skills: times }, { ...BASE, trace: true });
  assert.strictEqual(res.skillUses.length, RES1.skillUses.length);
  res.skillUses.forEach((u, k) => { const v = RES1.skillUses[k]; assert.strictEqual(u.name, v.name); assert.ok(Math.abs(u.t - v.t) <= DT + 1e-9 && Math.abs(u.end - v.end) <= DT + 1e-9, `${u.name} ${u.t} vs ${v.t}`); });
  assert.deepStrictEqual(res, RES1, 'the whole result (trace included) is identical');
  return `${res.skillUses.length} uses, result deep-equal`;
});

ok('the simulator\'s inline hit damage equals operators.hitDamage on 100 random (atk, def, res, damageTaken, type) cases', () => {
  const st = mkStage(['^', '_']), rng = sim.mulberry32(20261111), types = ['physical', 'arts', 'true'];
  let floored = 0;
  for (let k = 0; k < 100; k++) {
    const atk = 1 + Math.floor(rng() * 3000), def = Math.floor(rng() * 3000), res = Math.floor(rng() * 101), taken = 0.5 + rng(), type = types[k % 3];
    const op = { id: 'char_syn', name: 'X', position: 'RANGED', cost: 0, block: 0, hp: 1e6, atk, def: 0, res: 0, interval: 10, damageType: type, targets: 1, canHitAir: true, range: [{ dr: 1, dc: 0 }], skillSpec: null };
    const r = sim.simulate(st, { deploys: [{ op, r: 0, c: 0, dir: 'E' }] }, { enemies: [standing(1, 0, { def, res, damageTaken: taken })], maxTime: DT });
    const want = O.hitDamage(atk, type, { def, res, damageTaken: taken });
    relNear(r.hpRemoved, want, 1e-12, `case ${k}: ${type} atk ${atk} def ${def} res ${res} x${taken.toFixed(3)}`);
    if (want <= atk * O.MIN_DAMAGE_RATIO * taken + 1e-9 && type !== 'true') floored++;
  }
  return `${floored} of them on the 5% floor`;
});

ok('skills change the outcome: the same plan with opts.noSkills deals strictly less damage and uses no skill', () => {
  const off = sim.simulate(STAGE1, PLAN1, { ...BASE, noSkills: true, trace: true });
  checkResult(off, E1, sim.LIFE_POINTS_DEFAULT);
  assert.strictEqual(off.skillUses.length, 0);
  assert.ok(off.perOp.every(p => p.skillUptime === 0));
  assert.ok(off.hpRemoved < RES1.hpRemoved, `${off.hpRemoved} vs ${RES1.hpRemoved}`);
  assert.ok(sim.compareResults(RES1, off) < 0, 'the run with skills scores better');
  // plan.skills 'never' for every MANUAL skill sits in between (AUTO skills ignore plan entries)
  const never = sim.simulate(STAGE1, { deploys: PLAN1.deploys, skills: Object.fromEntries(PLAN1.deploys.map(d => [d.op.name, 'never'])) }, BASE);
  assert.ok(never.skillUses.every(u => K.compileSkill(by[u.name]).trigger === 'AUTO'));
  return `HP removed ${Math.round(off.hpRemoved)} (no skills) < ${Math.round(never.hpRemoved)} (AUTO only) < ${Math.round(RES1.hpRemoved)} (skills), kills ${off.kills} / ${never.kills} / ${RES1.kills}`;
});

ok('secrecy 15 floor 5 enemies are stronger than secrecy 0 (same spawns, more HP and ATK), and the same plan removes a smaller share', () => {
  const e0 = sim.sampleEnemies(STAGE1, { ...BASE, secrecy: 0, floor: 1 });
  assert.strictEqual(e0.length, E1.length);
  let hpUp = 0;
  E1.forEach((e, i) => {
    const z = e0[i];
    assert.strictEqual(e.key, z.key); assert.strictEqual(e.spawn, z.spawn);
    assert.ok(e.hp > z.hp, `${e.name}: HP ${e.hp} vs ${z.hp}`);
    assert.ok(e.atk >= z.atk && (z.atk === 0 || e.atk > z.atk), `${e.name}: ATK ${e.atk} vs ${z.atk}`);
    assert.strictEqual(e.def, z.def);
    hpUp += e.hp / z.hp;
  });
  const r0 = sim.simulate(STAGE1, PLAN1, { ...BASE, secrecy: 0, floor: 1 });
  assert.ok(RES1.hpTotal > r0.hpTotal);
  assert.ok(RES1.hpRemoved / RES1.hpTotal < r0.hpRemoved / r0.hpTotal);
  assert.ok(sim.compareResults(r0, RES1) < 0, 'secrecy 0 scores better');
  return `HP x${(hpUp / E1.length).toFixed(2)} on average (2.1 = 1 + 0.8 + 0.3: N15 additive per floor + N5); secrecy 0: kills ${r0.kills}, HP removed ${(100 * r0.hpRemoved / r0.hpTotal).toFixed(1)}%`;
});

// ---------- team effects with real operators (exact numbers on a synthetic stage) ----------
ok('teamMods: 逻各斯 hits with ATK +14% (艾雅法拉 炎息) only while 艾雅法拉 is on the field', () => {
  const st = mkStage(['^^^', '___']), logos = by['逻各斯'], eyja = by['艾雅法拉'], enemies = [standing(1, 1)];
  const one = deploys => sim.simulate(st, { deploys }, { enemies, maxTime: DT, noSkills: true });
  const alone = perOp(one([{ op: logos, r: 0, c: 0, dir: 'S' }]), '逻各斯').damage;
  const both = perOp(one([{ op: eyja, r: 0, c: 2, dir: 'S' }, { op: logos, r: 0, c: 0, dir: 'S' }]), '逻各斯').damage;
  const spec = K.compileSkill(logos), pb = K.profiles(logos, spec).base, pt = K.profiles(logos, spec, { extraMods: [{ stat: 'atk', op: 'pct', value: 0.14 }] }).base;
  relNear(alone, pb.atk * pb.atkScale * pb.hits, 1e-12, 'alone');
  relNear(both, pt.atk * pt.atkScale * pt.hits, 1e-12, 'with 艾雅法拉');
  assert.ok(both > alone);
  // the variant cache outlives a plan: two different bearers at the same plan index must not share an entry
  const bearer = (name, v) => ({ id: 'char_' + name, name, position: 'RANGED', cost: 0, block: 0, hp: 1, atk: 0, def: 0, res: 0, interval: 1, damageType: 'none', targets: 1, canHitAir: false, range: [],
    skillSpec: { id: null, trigger: 'PASSIVE', spType: 'NONE', spCost: 0, initSp: 0, duration: 0, instant: null, dpOverDuration: 0, fidelity: 'unsupported', notes: [], teamMods: [{ stat: 'atk', op: 'pct', value: v, when: { profession: 'CASTER' } }] } });
  for (const v of [0.5, 0.1]) {
    const d = perOp(one([{ op: bearer('B' + v, v), r: 0, c: 2, dir: 'S' }, { op: logos, r: 0, c: 0, dir: 'S' }]), '逻各斯').damage;
    const pv = K.profiles(logos, spec, { extraMods: [{ stat: 'atk', op: 'pct', value: v }] }).base;
    relNear(d, pv.atk * pv.atkScale * pv.hits, 1e-12, `synthetic bearer +${v * 100}%`);
  }
  return `${alone.toFixed(1)} -> ${both.toFixed(1)} per attack (arts vs RES 0)`;
});

ok('stacking + teamMods: 塞雷娅 at 40 s on the field has 2 stacks (ATK +10%, DEF +8%) plus DEF +6% from 星熊', () => {
  const st = mkStage(['___']), sar = by['塞雷娅'], hsg = by['星熊'], spec = K.compileSkill(sar);
  const res = sim.simulate(st, { deploys: [{ op: sar, r: 0, c: 0, dir: 'E' }, { op: hsg, r: 0, c: 2, dir: 'E' }] },
    { enemies: [standing(0, 0, { spawn: 40, atk: 3000 })], maxTime: 40.15, noSkills: true });
  const p2 = K.profiles(sar, spec, { stacks: 2, extraMods: [{ stat: 'def', op: 'pct', value: 0.06 }] }).base;
  relNear(perOp(res, '塞雷娅').damage, p2.atk * p2.atkScale * p2.hits, 1e-12, 'one attack at 2 stacks');
  relNear(perOp(res, '塞雷娅').damageTaken, 3000 - p2.def, 1e-12, 'one physical hit of 3000 ATK vs DEF with 2 stacks and 星熊');
  const p0 = K.profiles(sar, spec).base;
  return `ATK ${p0.atk.toFixed(1)} -> ${p2.atk.toFixed(1)}, DEF ${p0.def.toFixed(1)} -> ${p2.def.toFixed(1)}`;
});

ok('aura: an ally inside 夜莺\'s range takes arts damage with RES +15 (白恶魔的庇护)', () => {
  const st = mkStage(['^__', '___']), nig = by['夜莺'], sar = by['塞雷娅'];
  const hit = deploys => perOp(sim.simulate(st, { deploys }, { enemies: [standing(1, 0, { atk: 3000, damageType: 'arts' })], maxTime: 0.15, noSkills: true }), '塞雷娅').damageTaken;
  const without = hit([{ op: sar, r: 1, c: 0, dir: 'E' }]);
  const withAura = hit([{ op: nig, r: 0, c: 0, dir: 'E' }, { op: sar, r: 1, c: 0, dir: 'E' }]);
  const spec = K.compileSkill(sar), aura = K.profiles(nig).base.aura.mods;
  const pa = K.profiles(sar, spec, { extraMods: aura }).base, p0 = K.profiles(sar, spec).base;
  relNear(without, O.hitDamage(3000, 'arts', { res: p0.res }), 1e-12, 'without 夜莺');
  relNear(withAura, O.hitDamage(3000, 'arts', { res: pa.res }), 1e-12, 'inside her range');
  assert.ok(withAura < without);
  return `RES ${p0.res} -> ${pa.res}: ${without.toFixed(1)} -> ${withAura.toFixed(1)} per hit`;
});

ok('squad.initialDp: 德克萨斯 in the plan (or in opts.squad) adds 2 initial DP', () => {
  const st = mkStage(['___']), tex = by['德克萨斯'], enemies = [standing(0, 2)];
  const a = sim.simulate(st, { deploys: [{ op: tex, r: 0, c: 0, dir: 'E' }] }, { enemies, maxTime: DT, noSkills: true });
  const b = sim.simulate(st, { deploys: [] }, { enemies, maxTime: DT, squad: [tex, by['星熊']] });
  const c = sim.simulate(st, { deploys: [] }, { enemies, maxTime: DT });
  assert.strictEqual(c.dp.initial, 99 - 0);
  assert.strictEqual(sim.simulate({ ...st, initialCost: 10 }, { deploys: [] }, { enemies, maxTime: DT, squad: [tex] }).dp.initial, 12);
  assert.strictEqual(a.dp.initial, Math.min(99, 99 + 2)); assert.strictEqual(b.dp.initial, 99);   // capped at maxCost 99
  return 'initial cost 10 -> 12';
});

ok('defIgnoreRamp: 能天使 (module Y) ignores 10 more DEF with each hit; idleRegen: 棘刺 regenerates 3.5%/s after 2 s idle', () => {
  const st = mkStage(['^__']), ang = by['能天使'], pb = K.profiles(ang).base, atk = pb.atk * pb.atkScale;
  const r = sim.simulate(st, { deploys: [{ op: ang, r: 0, c: 0, dir: 'E' }] }, { enemies: [standing(0, 1, { def: 500 })], maxTime: pb.interval + 2 * DT, noSkills: true });
  relNear(perOp(r, '能天使').damage, (atk - 500) + (atk - 490), 1e-12, 'two hits: DEF 500, then 490');
  // 棘刺 is shot once at t = 0 by a ranged enemy outside his range and never attacks: regen from t = 2 s
  const st2 = mkStage(['_____']), tho = by['棘刺'], tb = K.profiles(tho).base;
  const rt = sim.simulate(st2, { deploys: [{ op: tho, r: 0, c: 4, dir: 'E' }] }, { enemies: [standing(0, 0, { atk: 2000, attackMode: 'ranged', rangeRadius: 9, applyWay: 'RANGED' })], maxTime: 4.05, noSkills: true, trace: true });
  const hpAt = t => rt.trace.frames.find(f => Math.abs(f.t - t) < 1e-9).ops[0][1] * tb.hp;
  const d = O.hitDamage(2000, 'physical', { def: tb.def });
  assert.ok(Math.abs(hpAt(1) - (tb.hp - d)) <= 0.5 * 1e-3 * tb.hp + 1e-9, `hp at 1 s ${hpAt(1)}`);
  assert.ok(Math.abs(hpAt(2) - (tb.hp - d)) <= 0.5 * 1e-3 * tb.hp + 1e-9, 'no regen before 2 s');
  assert.ok(Math.abs(hpAt(4) - (tb.hp - d + 2 * 0.035 * tb.hp)) <= 0.5 * 1e-3 * tb.hp + 1e-9, `hp at 4 s ${hpAt(4)}`);
  return `能天使 ${(atk - 500).toFixed(1)} + ${(atk - 490).toFixed(1)}; 棘刺 ${Math.round(tb.hp - d)} -> ${Math.round(hpAt(4))} HP at 4 s`;
});

// ---------- two more stages ----------
// 虫虫游戏厅 (ISW-NO_虫虫游戏厅): random spawn group g1 with packs a/b/c, 71/77/83 enemies depending on the seed.
// 物欲遮天 (ISW-NO_物欲遮天): 28 of its 33 enemies FLY.
const STAGES = [];
STAGES.push({ name: '彼处水如酒', st: STAGE1, plan: PLAN1 });
const SQUAD2 = ['德克萨斯', '能天使', '星熊', '艾雅法拉', '银灰', '夜莺'];
for (const name of ['虫虫游戏厅', '物欲遮天']) { const st = sm.loadStage(name); STAGES.push({ name, st, plan: autoPlan(st, SQUAD2, BASE) }); }

ok('虫虫游戏厅 (random spawn groups): seeds 1-3, legal auto plan: no throw, conservation, no NaN, trace consistent', () => {
  const { st, plan } = STAGES[1], totals = new Set();
  for (const seed of [1, 2, 3]) {
    const opts = { ...BASE, seed }, en = sim.sampleEnemies(st, opts);
    assert.ok(en.some(e => e.group), 'enemies from random spawn groups');
    const res = sim.simulate(st, plan, { ...opts, trace: true });
    checkResult(res, en, sim.LIFE_POINTS_DEFAULT);
    totals.add(res.totalEnemies);
    assert.deepStrictEqual(sim.simulate(st, plan, opts), (({ trace, ...x }) => x)(res), 'deterministic per seed, trace changes nothing');
  }
  assert.ok(totals.size > 1, 'different seeds pick different options');
  return `plan ${plan.deploys.map(d => `${d.op.name}(${d.r},${d.c})${d.dir}`).join(' ')}; enemy totals ${[...totals].join('/')}`;
});

ok('物欲遮天 (FLY enemies): legal auto plan: no throw, conservation, no NaN, trace consistent; FLY enemies are killed', () => {
  const { st, plan } = STAGES[2], en = sim.sampleEnemies(st, BASE), fly = new Set(en.filter(e => e.motion === 'FLY').map(e => e.id));
  assert.ok(fly.size > 0);
  const res = sim.simulate(st, plan, { ...BASE, trace: true });
  checkResult(res, en, sim.LIFE_POINTS_DEFAULT);
  const flyKills = res.trace.events.filter(e => e.type === 'kill' && fly.has(e.id)).length;
  assert.ok(flyKills > 0, 'at least one FLY enemy killed');
  // only canHitAir operators can kill FLY enemies
  for (const e of res.trace.events) if (e.type === 'kill' && fly.has(e.id)) assert.ok(by[e.name].canHitAir || K.profiles(by[e.name]).active.canHitAir, `${e.name} killed a FLY enemy`);
  return `${fly.size} FLY of ${en.length}; kills ${res.kills} (${flyKills} FLY), leaks ${res.leaks}; plan ${plan.deploys.map(d => `${d.op.name}(${d.r},${d.c})${d.dir}`).join(' ')}`;
});

// ---------- optimize.js on a real instance (a test fixture, not candidates.js) ----------
ok('optimize.js on 彼处水如酒: real candidates (top 3 tiles per operator), solve === bruteForce, the chosen placement simulates legally', () => {
  const Z = require('./optimize.js'), st = STAGE1, W = st.W, names = ['桃金娘', '星熊', '塞雷娅', '银灰', '史尔特尔', '能天使', '艾雅法拉', '逻各斯'];
  const hp = Float64Array.from(E1, e => e.hp), cands = [];
  names.forEach((n, oi) => {
    const op = by[n], prof = K.profiles(op).base, opts = [];
    for (let r = 0; r < st.H; r++) for (let c = 0; c < W; c++) {
      if (!sim.canDeploy(st, op, r, c, null, BASE)) continue;
      for (const dir of ['E', 'S', 'W', 'N']) {
        const mask = new Set(O.rotate(prof.range, dir).map(o => (r + o.dr) * W + (c + o.dc)).filter(t => t >= 0 && t < st.H * W));
        // pot = base-profile DPS against the enemy x seconds it spends in range walking unblocked
        const pot = new Float64Array(E1.length);
        E1.forEach((e, i) => {
          if (e.motion === 'FLY' && !prof.canHitAir) return;
          let s = 0;
          for (let k = 1; k < e.path.length; k++) if (!e.path[k - 1].hidden && mask.has(e.path[k - 1].r * W + e.path[k - 1].c)) s += e.path[k].t - e.path[k - 1].t;
          pot[i] = O.dpsAgainst(prof, e) * s;
        });
        opts.push({ op: oi, tile: r * W + c, dir, cost: op.cost, pot, sum: pot.reduce((a, b) => a + b, 0) });
      }
    }
    opts.sort((a, b) => b.sum - a.sum);
    for (const x of opts.slice(0, 3)) cands.push({ id: cands.length, op: x.op, tile: x.tile, dir: x.dir, cost: x.cost, pot: x.pot });
  });
  const inst = { limit: sim.deployLimit(st, BASE), hp, cands };
  const best = Z.solve(inst), brute = Z.bruteForce(inst), gr = Z.greedy(inst);
  relNear(best.value, brute.value, 1e-9, 'B&B value = brute force');
  assert.ok(best.proven && Z.feasible(inst, best.set) && gr.value <= best.value + 1e-6);
  const plan = { deploys: best.set.map(id => cands[id]).sort((a, b) => a.cost - b.cost).map(x => ({ op: by[names[x.op]], r: Math.floor(x.tile / W), c: x.tile % W, dir: x.dir })) };
  const res = sim.simulate(st, plan, { ...BASE, trace: true });
  checkResult(res, E1, sim.LIFE_POINTS_DEFAULT);
  return `${cands.length} candidates, limit ${inst.limit}: optimum covers ${(100 * best.value / hp.reduce((a, b) => a + b, 0)).toFixed(1)}% of enemy HP with ${best.set.length} placements (static model: no DP, no blocking), B&B ${best.stats.explored} nodes vs brute force ${brute.stats.explored}, greedy ${(gr.value / best.value).toFixed(4)} of optimum; `
    + `chosen ${plan.deploys.map(d => `${d.op.name}(${d.r},${d.c})${d.dir}`).join(' ')} -> kills ${res.kills}, HP removed ${(100 * res.hpRemoved / res.hpTotal).toFixed(1)}%`;
});

// ---------- timing ----------
ok('simulate() without trace: median of 50 runs per stage (data and skills warmed up first)', () => {
  const out = [];
  for (const { name, st, plan } of STAGES) {
    sim.simulate(st, plan, BASE);
    const ms = [];
    for (let k = 0; k < 50; k++) { const t0 = process.hrtime.bigint(); sim.simulate(st, plan, BASE); ms.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    ms.sort((a, b) => a - b);
    out.push(`${name} median ${ms[25].toFixed(2)} ms (p90 ${ms[45].toFixed(2)}, max ${ms[49].toFixed(2)})`);
    assert.ok(ms[25] < 200, `${name}: ${ms[25]} ms`);
  }
  return out.join('; ');
});

console.log(`\n${passed} checks passed`);
