// node combat/test_operators.js : one line per passed check, non-zero exit on the first failure.
'use strict';
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const O = require('./operators.js');
const sm = require('./stage_model.js');
const { decodeFile } = require('../research/scripts/tomimi_decode.js');

let n = 0;
const ok = (name, fn) => { fn(); console.log(`ok ${++n} - ${name}`); };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} expected ${b}, got ${a}`);
const CT = O.table('character_table');
const RAW = CT.char_172_svrash; // 银灰: the hand-checked operator
const E2 = RAW.phases[2].attributesKeyFrames;
const bare = { elite: 2, trust: 0, potential: 1 };

// ---------- lookup ----------
ok('lookup by Chinese name, char id and English appellation (case-insensitive) agree', () => {
  for (const key of ['银灰', 'char_172_svrash', 'SilverAsh', 'silverash']) assert.strictEqual(O.loadOperator(key).id, 'char_172_svrash');
  assert.strictEqual(O.resolveId('暮落'), 'char_4025_aprot2'); // duplicated name: the obtainable copy wins
});
ok('unknown names and non-"char_" entries (tokens, traps) are rejected', () => {
  assert.throws(() => O.loadOperator('不存在的干员'), /operator not found/);
  const opNames = new Set(Object.keys(CT).filter(k => k.startsWith('char_')).map(k => CT[k].name));
  const tokenKey = Object.keys(CT).find(k => !k.startsWith('char_') && CT[k].name && !opNames.has(CT[k].name));
  assert.ok(tokenKey, 'a token exists in the table');
  assert.throws(() => O.loadOperator(tokenKey), /operator not found/);
  assert.throws(() => O.loadOperator(CT[tokenKey].name), /operator not found/);
});
ok('defaults: max elite, max level of the elite, potential 1, trust 100, last skill, skillLevel 7', () => {
  const op = O.loadOperator('银灰');
  assert.deepStrictEqual([op.elite, op.level, op.potential, op.trust, op.skillIndex, op.skillLevel, op.skillId], [2, 90, 1, 100, 2, 7, 'skchr_svrash_3']);
  assert.strictEqual(O.loadOperator('银灰', { elite: 0 }).level, RAW.phases[0].maxLevel);
  assert.strictEqual(O.loadOperator('银灰', { elite: 0 }).skillIndex, 0); // only S1 is unlocked at E0
  assert.strictEqual(O.loadOperator('银灰', { skill: 1 }).skillId, 'skchr_svrash_1');
});
ok('invalid options throw (level, elite, potential, locked skill, mastery below E2)', () => {
  assert.throws(() => O.loadOperator('银灰', { elite: 2, level: 91 }), /level/);
  assert.throws(() => O.loadOperator('银灰', { elite: 3 }), /elite/);
  assert.throws(() => O.loadOperator('银灰', { potential: 7 }), /potential/);
  assert.throws(() => O.loadOperator('银灰', { elite: 0, skill: 3 }), /not unlocked/);
  assert.throws(() => O.loadOperator('银灰', { elite: 1, skillLevel: 8 }), /mastery/);
});

// ---------- stats ----------
ok('level 1 and max level equal the key frames exactly (银灰 E2, trust 0, potential 1)', () => {
  for (const [frame, level] of [[E2[0], 1], [E2[1], 90]]) {
    const op = O.loadOperator('银灰', { ...bare, level });
    assert.strictEqual(frame.level, level);
    assert.deepStrictEqual([op.hp, op.atk, op.def, op.res, op.cost, op.block, op.redeploy, op.attackSpeed, op.baseAttackTime],
      [frame.data.maxHp, frame.data.atk, frame.data.def, frame.data.magicResistance, frame.data.cost, frame.data.blockCnt, frame.data.respawnTime, frame.data.attackSpeed, frame.data.baseAttackTime]);
  }
  const top = O.loadOperator('银灰', { ...bare, level: 90 });
  assert.deepStrictEqual([top.hp, top.atk, top.def], [2560, 713, 397]); // the literal frame values
});
ok('mid level equals the hand interpolation (银灰 E2 level 45: 2022+538*44/89, 577+136*44/89, 329+68*44/89)', () => {
  const op = O.loadOperator('银灰', { ...bare, level: 45 });
  assert.deepStrictEqual([op.hp, op.atk, op.def], [2288, 644, 363]); // 2287.98, 644.24, 362.62 rounded
  const lerp = k => Math.round(E2[0].data[k] + (E2[1].data[k] - E2[0].data[k]) * (45 - 1) / (90 - 1));
  assert.deepStrictEqual([op.hp, op.atk, op.def], [lerp('maxHp'), lerp('atk'), lerp('def')]);
});
ok('every operator, every elite: level 1 and max level reproduce both key frames', () => {
  let count = 0;
  for (const id of Object.keys(CT).filter(k => k.startsWith('char_'))) {
    CT[id].phases.forEach((ph, elite) => {
      const f = ph.attributesKeyFrames;
      for (const [frame, level] of [[f[0], 1], [f[f.length - 1], ph.maxLevel]]) {
        const op = O.loadOperator(id, { elite, level, trust: 0, potential: 1, skillLevel: 1 });
        assert.deepStrictEqual([op.hp, op.atk, op.def], [frame.data.maxHp, frame.data.atk, frame.data.def], id + ' E' + elite + ' L' + level);
        count++;
      }
    });
  }
  assert.ok(count > 2000);
});
ok('trust: favor frames are levels 0 and 50; bonus linear up to 100% trust, flat after (银灰: +50 ATK, +50 DEF at 100%)', () => {
  const fav = RAW.favorKeyFrames;
  assert.deepStrictEqual(fav.map(f => f.level), [0, 50]);
  assert.deepStrictEqual([fav[1].data.maxHp, fav[1].data.atk, fav[1].data.def], [0, 50, 50]);
  const at = trust => { const op = O.loadOperator('银灰', { elite: 2, level: 90, potential: 1, trust }); return [op.hp, op.atk, op.def]; };
  assert.deepStrictEqual(at(0), [2560, 713, 397]);
  assert.deepStrictEqual(at(50), [2560, 713 + 25, 397 + 25]);
  assert.deepStrictEqual(at(100), [2560, 763, 447]);
  assert.deepStrictEqual(at(200), [2560, 763, 447]);
  assert.deepStrictEqual(at(75), [2560, 713 + 37, 397 + 37]); // favor level floor(75/2) = 37
});
ok('potential p applies potentialRanks[0..p-2] (银灰: cost -1, redeploy -4, ATK +26, talent, cost -1)', () => {
  const kinds = RAW.potentialRanks.map(r => r.buff ? r.buff.attributes.attributeModifiers.map(m => m.attributeType + m.value).join() : r.type);
  assert.deepStrictEqual(kinds, ['COST-1', 'RESPAWN_TIME-4', 'ATK26', 'CUSTOM', 'COST-1']);
  const at = potential => { const op = O.loadOperator('银灰', { elite: 2, level: 90, trust: 0, potential }); return [op.cost, op.redeploy, op.atk]; };
  assert.deepStrictEqual(at(1), [20, 70, 713]);
  assert.deepStrictEqual(at(2), [19, 70, 713]);
  assert.deepStrictEqual(at(3), [19, 66, 713]);
  assert.deepStrictEqual(at(4), [19, 66, 739]);
  assert.deepStrictEqual(at(5), [19, 66, 739]);
  assert.deepStrictEqual(at(6), [18, 66, 739]);
});
ok('interval = baseAttackTime * 100 / attackSpeed; ATTACK_SPEED potentials shorten it', () => {
  const op = O.loadOperator('银灰');
  assert.strictEqual(op.interval, 1.3);
  const id = Object.keys(CT).find(k => k.startsWith('char_') && CT[k].potentialRanks.some(r => r.buff && r.buff.attributes.attributeModifiers.some(m => m.attributeType === 'ATTACK_SPEED')));
  const lo = O.loadOperator(id, { potential: 1 }), hi = O.loadOperator(id, { potential: 6 });
  assert.ok(hi.attackSpeed > lo.attackSpeed && hi.interval < lo.interval);
  near(hi.interval, hi.baseAttackTime * 100 / hi.attackSpeed);
});
ok('modules: flat stage bonuses from battle_equip_table (银灰 X stage 3: +330 HP, +70 ATK)', () => {
  const be = O.table('battle_equip_table', true);
  if (!be) { console.log('   (module tables not downloaded: skipped)'); return; }
  const bb = Object.fromEntries(be.uniequip_002_svrash.phases[2].attributeBlackboard.map(b => [b.key, b.value]));
  assert.deepStrictEqual(bb, { max_hp: 330, atk: 70 });
  const base = O.loadOperator('银灰', { level: 90 });
  for (const module of ['X3', { type: 'X', stage: 3 }, { id: 'uniequip_002_svrash', stage: 3 }, { name: '雪境羽兽护理套组', stage: 3 }, { type: 'lor-x', stage: 3 }]) {
    const op = O.loadOperator('银灰', { level: 90, module });
    assert.deepStrictEqual([op.hp - base.hp, op.atk - base.atk, op.def - base.def, op.module.id, op.module.stage], [330, 70, 0, 'uniequip_002_svrash', 3]);
  }
  assert.strictEqual(O.loadOperator('银灰', { module: 'X' }).module.stage, O.MODULE_STAGE_DEFAULT);
  assert.strictEqual(base.module, null);
  assert.throws(() => O.loadOperator('银灰', { module: 'Y' }), /module Y not found/);
  assert.throws(() => O.loadOperator('银灰', { elite: 1, module: 'X' }), /needs PHASE_2/);
});

// ---------- range and rotate ----------
const key = o => o.dr + ',' + o.dc;
ok('range faces east: 银灰 E2 "3-12" reaches 3 tiles forward, nothing behind', () => {
  const op = O.loadOperator('银灰');
  assert.strictEqual(op.rangeId, '3-12');
  assert.deepStrictEqual(op.range.map(key).sort(), ['-1,0', '-1,1', '0,0', '0,1', '0,2', '0,3', '1,0', '1,1']);
  assert.deepStrictEqual([Math.max(...op.range.map(o => o.dc)), Math.min(...op.range.map(o => o.dc))], [3, 0]);
});
ok('all range_table ranges are mirror-symmetric in row, so dr = -row is safe', () => {
  const rt = O.table('range_table');
  for (const id of Object.keys(rt)) { const set = new Set(O.rangeOf(id).map(key)); for (const o of O.rangeOf(id)) assert.ok(set.has(key({ dr: -o.dr, dc: o.dc })), id); }
  assert.ok(Object.keys(rt).length >= 75);
});
ok('rotate: the three contract examples, E = identity, an asymmetric offset', () => {
  const fwd = [{ dr: 0, dc: 1 }];
  assert.deepStrictEqual(O.rotate(fwd, 'E'), [{ dr: 0, dc: 1 }]);
  assert.deepStrictEqual(O.rotate(fwd, 'S'), [{ dr: 1, dc: 0 }]);
  assert.deepStrictEqual(O.rotate(fwd, 'W'), [{ dr: 0, dc: -1 }]);
  assert.deepStrictEqual(O.rotate(fwd, 'N'), [{ dr: -1, dc: 0 }]);
  const odd = [{ dr: -1, dc: 2 }];
  assert.deepStrictEqual([O.rotate(odd, 'S'), O.rotate(odd, 'W'), O.rotate(odd, 'N')], [[{ dr: 2, dc: 1 }], [{ dr: 1, dc: -2 }], [{ dr: -2, dc: -1 }]]);
  assert.throws(() => O.rotate(fwd, 'X'), /unknown direction/);
});
ok('rotate: 4 quarter turns = identity, W = S twice, N = S three times, cached, input untouched', () => {
  const range = [{ dr: 0, dc: 0 }, { dr: -1, dc: 2 }, { dr: 1, dc: 1 }, { dr: 0, dc: 3 }], copy = JSON.parse(JSON.stringify(range));
  const s1 = O.rotate(range, 'S'), s2 = O.rotate(s1, 'S'), s3 = O.rotate(s2, 'S'), s4 = O.rotate(s3, 'S');
  assert.deepStrictEqual(s4, range);
  assert.deepStrictEqual(s2, O.rotate(range, 'W'));
  assert.deepStrictEqual(s3, O.rotate(range, 'N'));
  assert.strictEqual(O.rotate(range, 'S'), s1);
  assert.deepStrictEqual(range, copy);
  const op = O.loadOperator('银灰');
  assert.deepStrictEqual(O.rotate(O.rotate(O.rotate(O.rotate(op.range, 'S'), 'S'), 'S'), 'S'), op.range);
  assert.ok(O.rotate(op.range, 'N').some(o => o.dr === -3 && o.dc === 0)); // 3 forward, facing north = 3 rows up
});

// ---------- applyMods ----------
const unit = { name: 'u', position: 'MELEE', profession: 'WARRIOR', hp: 1000, atk: 100, def: 50, attackSpeed: 100, baseAttackTime: 1, interval: 1 };
ok('applyMods: pct of one stat are summed (x1.5), mul are independent (x1.56)', () => {
  near(O.applyMods(unit, [{ stat: 'atk', op: 'pct', value: 0.2 }, { stat: 'atk', op: 'pct', value: 0.3 }]).atk, 150);
  near(O.applyMods(unit, [{ stat: 'atk', op: 'mul', value: 1.2 }, { stat: 'atk', op: 'mul', value: 1.3 }]).atk, 156);
});
ok('applyMods: order pct -> add -> mul -> set, whatever the list order', () => {
  const mods = [{ stat: 'atk', op: 'mul', value: 2 }, { stat: 'atk', op: 'add', value: 10 }, { stat: 'atk', op: 'pct', value: 0.5 }];
  near(O.applyMods(unit, mods).atk, (100 * 1.5 + 10) * 2);
  near(O.applyMods(unit, mods.slice().reverse()).atk, 320);
  assert.strictEqual(O.applyMods(unit, [{ stat: 'atk', op: 'set', value: 7 }, ...mods]).atk, 7);
  assert.throws(() => O.applyMods(unit, [{ stat: 'atk', op: 'pow', value: 2 }]), /unknown modifier op/);
});
ok('applyMods: returns a new unit, never mutates the unit or the mods', () => {
  const u = { ...unit, range: [{ dr: 0, dc: 1 }] }, before = JSON.stringify(u);
  const mods = [{ stat: 'hp', op: 'pct', value: 0.35 }, { stat: 'def', op: 'add', value: 5 }], modsBefore = JSON.stringify(mods);
  const out = O.applyMods(u, mods);
  assert.notStrictEqual(out, u);
  assert.strictEqual(JSON.stringify(u), before);
  assert.strictEqual(JSON.stringify(mods), modsBefore);
  near(out.hp, 1350); assert.strictEqual(out.def, 55);
  assert.notStrictEqual(O.applyMods(u, []), u);
  assert.deepStrictEqual(O.applyMods(u, []), u);
});
ok('applyMods: when-conditions (value, any-of list, ctx, missing field, all)', () => {
  const m = when => [{ stat: 'atk', op: 'add', value: 1, when }];
  assert.strictEqual(O.applyMods(unit, m({ position: 'MELEE' })).atk, 101);
  assert.strictEqual(O.applyMods(unit, m({ position: 'RANGED' })).atk, 100);
  assert.strictEqual(O.applyMods(unit, m({ profession: ['SNIPER', 'WARRIOR'] })).atk, 101);
  assert.strictEqual(O.applyMods(unit, m({ profession: ['SNIPER', 'CASTER'] })).atk, 100);
  assert.strictEqual(O.applyMods(unit, m({ position: 'MELEE', profession: 'SNIPER' })).atk, 100); // every key must hold
  assert.strictEqual(O.applyMods(unit, m({ type: 'BOSS' })).atk, 100);                            // operators have no type
  assert.strictEqual(O.applyMods({ ...unit, type: 'BOSS' }, m({ type: ['ELITE', 'BOSS'] })).atk, 101);
  assert.strictEqual(O.applyMods(unit, m({ skillActive: true })).atk, 100);
  assert.strictEqual(O.applyMods(unit, m({ skillActive: true }), { skillActive: true }).atk, 101);
  assert.strictEqual(O.applyMods(unit, m({ all: true })).atk, 101);
  assert.strictEqual(O.applyMods(unit, m(undefined)).atk, 101);
});
ok('applyMods: interval recomputed; enemies with only `interval`; damageTaken defaults to 1; rules skipped', () => {
  near(O.applyMods(unit, [{ stat: 'attackSpeed', op: 'add', value: 70 }]).interval, 1 / 1.7);
  near(O.applyMods(unit, [{ stat: 'baseAttackTime', op: 'add', value: 0.5 }]).interval, 1.5);
  near(O.applyMods(unit, [{ stat: 'attackSpeed', op: 'set', value: 5000 }]).interval, 100 / O.ATTACK_SPEED_MAX);
  const enemy = { key: 'e', type: 'BOSS', hp: 1000, atk: 100, interval: 3 };
  near(O.applyMods(enemy, [{ stat: 'attackSpeed', op: 'mul', value: 1.5 }]).interval, 2);
  assert.strictEqual(O.applyMods(enemy, [{ stat: 'hp', op: 'mul', value: 2 }]).interval, 3);
  near(O.applyMods(enemy, [{ stat: 'damageTaken', op: 'mul', value: 0.8 }]).damageTaken, 0.8);
  assert.deepStrictEqual(O.applyMods(enemy, [{ rule: 'deployLimit', add: 1 }, { stat: 'speed', op: 'pct', value: 0.5 }]), enemy); // no speed field: ignored
  assert.strictEqual(O.applyMods(enemy, [{ stat: 'speed', op: 'set', value: 2 }]).speed, 2);
  assert.strictEqual(O.applyMods(enemy, [{ stat: 'max_hp', op: 'add', value: 1 }]).hp, 1001); // game-data alias
});

// ---------- secrecy ----------
ok('secrecyMods N15 floor 5 (additive, floor 1 = zero steps): +80% ATK/HP, N5, N8, N10, N11', () => {
  const mods = O.secrecyMods(15, 5).map(({ source, ...m }) => m);
  assert.deepStrictEqual(mods, [
    { stat: 'atk', op: 'pct', value: 0.8 },
    { stat: 'hp', op: 'pct', value: 0.8 },
    { stat: 'hp', op: 'pct', value: 0.3 },
    { stat: 'atk', op: 'pct', value: 0.15, when: { type: ['ELITE', 'BOSS'] } },
    { rule: 'deployLimit', add: -1 },
    { stat: 'damageTaken', op: 'mul', value: 0.8, when: { type: 'BOSS' } },
  ]);
  assert.ok(O.secrecyMods(15, 5).every(m => typeof m.source === 'string'));
  const e = type => O.applyMods({ type, hp: 1000, atk: 100, def: 200 }, O.secrecyMods(15, 5));
  near(e('NORMAL').hp, 2100); near(e('NORMAL').atk, 180); assert.strictEqual(e('NORMAL').damageTaken, undefined);
  near(e('ELITE').atk, 195); near(e('BOSS').atk, 195); near(e('BOSS').hp, 2100); near(e('BOSS').damageTaken, 0.8);
  assert.strictEqual(e('BOSS').def, 200);
});
ok('secrecyMods: options and other levels (compound, floorOneSteps, floorOp, thresholds, rate table)', () => {
  const val = (mods, stat) => mods.find(m => m.stat === stat && !m.when && /floor/.test(m.source));
  near(val(O.secrecyMods(15, 5, { perFloor: 'compound' }), 'hp').value, Math.pow(1.2, 4) - 1); // 1.0736
  near(val(O.secrecyMods(15, 5, { floorOneSteps: 1 }), 'atk').value, 1.0);
  assert.deepStrictEqual({ ...val(O.secrecyMods(15, 5, { floorOp: 'mul' }), 'hp'), source: 0 }, { stat: 'hp', op: 'mul', value: 1.8, source: 0 });
  near(O.applyMods({ type: 'NORMAL', hp: 1000 }, O.secrecyMods(15, 5, { floorOp: 'mul' })).hp, 1000 * 1.3 * 1.8);
  assert.strictEqual(val(O.secrecyMods(15, 1), 'hp'), undefined);              // floor 1: no per-floor bonus
  assert.deepStrictEqual(O.secrecyMods(4, 5), []);                             // below N5: nothing
  assert.deepStrictEqual(O.secrecyMods(7, 3).map(m => [m.stat, m.value]), [['atk', 0.06], ['hp', 0.06], ['hp', 0.3]]); // rate of N7 only
  near(val(O.secrecyMods(16, 5), 'atk').value, 1.0);
  assert.deepStrictEqual(O.SECRECY_RATE_PCT, [0, 0, 0, 0, 0, 1, 2, 3, 5, 6, 7, 8, 10, 12, 16, 20, 25]);
  assert.throws(() => O.secrecyMods(17, 1)); assert.throws(() => O.secrecyMods(15, 0)); assert.throws(() => O.secrecyMods(15, 5, { perFloor: 'x' }));
});

// ---------- damage ----------
ok('hitDamage: physical, 5% floor, arts, arts floor, true, damageTaken, heal/none', () => {
  assert.strictEqual(O.hitDamage(500, 'physical', { def: 300 }), 200);
  assert.strictEqual(O.hitDamage(100, 'physical', { def: 1000 }), 5);
  assert.strictEqual(O.hitDamage(500, 'arts', { def: 9999, res: 20 }), 400);
  assert.strictEqual(O.hitDamage(500, 'arts', { res: 100 }), 25);
  assert.strictEqual(O.hitDamage(500, 'true', { def: 9999, res: 100 }), 500);
  assert.strictEqual(O.hitDamage(500, 'physical', { def: 300, damageTaken: 0.8 }), 160);
  assert.strictEqual(O.hitDamage(100, 'physical', { def: 1000, damageTaken: 0.8 }), 4);
  assert.strictEqual(O.hitDamage(500, 'true', { damageTaken: 0.8 }), 400);
  assert.strictEqual(O.hitDamage(500, 'heal', { def: 0 }), 0);
  assert.strictEqual(O.hitDamage(500, 'none', { def: 0 }), 0);
  assert.strictEqual(O.hitDamage(500, 'physical', { def: -100 }), 500); // DEF below 0 counts as 0
});
ok('dpsAgainst: operator or profile, atkScale and hits, heal and non-attackers give 0', () => {
  const enemy = { def: 100, res: 50 };
  assert.strictEqual(O.dpsAgainst({ atk: 500, interval: 1.25, damageType: 'physical' }, enemy), 320);
  assert.strictEqual(O.dpsAgainst({ atk: 500, interval: 1.25, damageType: 'physical', atkScale: 2, hits: 2 }, enemy), 1440);
  assert.strictEqual(O.dpsAgainst({ atk: 500, interval: 1.25, damageType: 'arts' }, enemy), 200);
  assert.strictEqual(O.dpsAgainst({ atk: 500, interval: 1.25, damageType: 'heal' }, enemy), 0);
  assert.strictEqual(O.dpsAgainst({ atk: 500, interval: 1.25, damageType: 'physical', attacks: false }, enemy), 0);
  const op = O.loadOperator('银灰', { level: 90 });
  near(O.dpsAgainst(op, { def: 263 }), (763 - 263) / 1.3);
});

// ---------- stage mods ----------
const index = fs.readFileSync(path.join(__dirname, '..', 'research', 'sources', 'tomimi', 'index.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t'));
ok('stageMods 彼处水如酒: normal = nothing; elite = ATK/DEF/HP x1.2 on all + 3 forbidden ground tiles left of the cannon', () => {
  const st = sm.loadStage('彼处水如酒');
  assert.deepStrictEqual(O.stageMods(st.mc, { elite: false }), { mods: [], forbid: [], unhandled: [], hiddenGroups: { enable: [], disable: [] }, replace: [] });
  assert.deepStrictEqual(O.stageMods(st.mc), O.stageMods(st.mc, { elite: false }));
  const el = O.stageMods(st.mc, { elite: true });
  assert.deepStrictEqual(el.mods.map(({ source, ...m }) => m), ['atk', 'def', 'hp'].map(stat => ({ stat, op: 'mul', value: 1.2, when: { all: true } })));
  assert.deepStrictEqual(el.forbid, [{ r: 3, c: 1 }, { r: 4, c: 1 }, { r: 5, c: 1 }]); // "4,1","3,1","2,1" = row-from-bottom,col on an 8-row map
  assert.deepStrictEqual(el.unhandled, []);
  for (const f of el.forbid) assert.ok(st.grid[f.r][f.c].deployable && !st.grid[f.r][f.c].high, 'forbidden tile is a ground deploy tile');
  const cannon = st.mc.traps.find(t => t.key === 'trap_196_cnnon'), cg = st.toGrid(cannon.pos);
  assert.ok(el.forbid.some(f => f.r === cg.r && f.c === cg.c - 1), 'one forbidden tile is directly left of the 盐坨子炮');
  assert.deepStrictEqual(O.stageMods(st, { elite: true }), el); // a loadStage() object works too
  const e = O.applyMods({ key: 'enemy_x', type: 'NORMAL', hp: 1000, atk: 100, def: 100 }, el.mods);
  near(e.hp, 1200); near(e.atk, 120); near(e.def, 120);
  near(O.applyMods({ type: 'NORMAL', hp: 1000 }, el.mods.concat(O.secrecyMods(15, 5))).hp, 1000 * 2.1 * 1.2); // pct first, then mul
});
ok('stageMods: hidden groups, enemy replacement, key-targeted mods, stealth rule (猎犬病原 / 灌水贤者 / 辟路行进 / 暴力押运)', () => {
  const mc = name => sm.loadStage(name).mc;
  const dogN = O.stageMods(mc('猎犬病原')), dogE = O.stageMods(mc('猎犬病原'), { elite: true });
  assert.deepStrictEqual([dogN.hiddenGroups.enable, dogE.hiddenGroups.enable], [['normal'], ['raid']]); // normal mode group is NOT active in elite
  assert.deepStrictEqual(dogE.mods.filter(m => m.stat).map(m => [m.stat, m.op, m.value]), [['atk', 'mul', 1.2], ['hp', 'mul', 1.4]]);
  assert.deepStrictEqual(O.stageMods(mc('猎犬病原'), { elite: true, normalInElite: true }).hiddenGroups.enable, ['normal', 'raid']);
  assert.deepStrictEqual(O.stageMods(mc('灌水贤者'), { elite: true }).replace, [{ from: 'enemy_1024_mortar', to: 'enemy_1024_mortar_2' }]);
  const road = O.stageMods(mc('辟路行进'), { elite: true }).mods;
  near(O.applyMods({ key: 'enemy_1076_bsthmr', atk: 100 }, road).atk, 100 * 1.2 * 1.5);
  near(O.applyMods({ key: 'enemy_other', atk: 100 }, road).atk, 120);
  assert.deepStrictEqual(O.stageMods(mc('暴力押运'), { elite: true }).mods.filter(m => m.rule).map(m => [m.rule, m.when]), [['enemyStealth', { key: ['enemy_1330_cbrush'] }]]);
  assert.deepStrictEqual(O.stageMods(mc('侵占家园'), { elite: true }).hiddenGroups, { enable: ['hard'], disable: ['normal'] });
});
ok('stageMods over all 77 stages, both modes: every forbidden tile is a deploy tile; only the 3 known special effects are unhandled', () => {
  const special = new Set();
  let forbid = 0, stat = 0;
  for (const [i] of index) {
    const mc = decodeFile(path.join(__dirname, '..', 'research', 'sources', 'tomimi', i + '.json')).mapConfig, H = mc.mapData.map.length;
    for (const elite of [false, true]) {
      const r = O.stageMods(mc, { elite });
      for (const u of r.unhandled) { assert.ok(u.special, 'unexpected unhandled entry in ' + mc.id + ': ' + JSON.stringify(u)); special.add(u.special); }
      for (const m of r.mods) if (m.stat) { stat++; assert.ok(['mul', 'add'].includes(m.op) && typeof m.value === 'number' && m.when); }
      for (const f of r.forbid) { forbid++; assert.ok(f.r >= 0 && f.r < H && mc.mapData.tiles[mc.mapData.map[f.r][f.c]][4], mc.id + ' forbid ' + JSON.stringify(f)); }
    }
  }
  assert.strictEqual(index.length, 77);
  assert.deepStrictEqual([...special].sort(), ['adsham_buff', 'mods_1', 'mods_2']);
  assert.strictEqual(forbid, 10); // 1 + 2 + 3 + 4 tiles on four stages, elite mode only
  assert.ok(stat > 120);
});

// ---------- classification ----------
ok('classification: damage type, targets, canHitAir for the 12 roster operators', () => {
  const want = {
    桃金娘: ['physical', 1, false], 德克萨斯: ['physical', 1, false], 塞雷娅: ['physical', 1, false], 星熊: ['physical', 1, false],
    银灰: ['physical', 1, true], 史尔特尔: ['arts', 1, false], 能天使: ['physical', 1, true], 蓝毒: ['physical', 1, true],
    艾雅法拉: ['arts', 1, true], 逻各斯: ['arts', 1, true], 夜莺: ['heal', 3, true], 棘刺: ['physical', 1, true],
  };
  for (const [name, w] of Object.entries(want)) { const op = O.loadOperator(name); assert.deepStrictEqual([op.damageType, op.targets, op.canHitAir], w, name); }
});
ok('classification: branch exceptions outside the roster (text-derived)', () => {
  const L = (name, o) => O.loadOperator(name, o);
  assert.deepStrictEqual([L('惊蛰').targets, L('惊蛰', { elite: 0 }).targets, L('惊蛰').aoe, L('惊蛰').damageType], [4, 3, 'chain', 'arts']); // chain: trait blackboard
  const blaze = L('煌'); assert.deepStrictEqual([blaze.targets, blaze.aoe], [blaze.block, 'blocked']);                                    // 同时攻击阻挡的所有敌人
  assert.deepStrictEqual([L('赫拉格').damageType, L('泥岩').damageType, L('石棉').damageType], ['physical', 'physical', 'physical']);     // musha / unyield / artsprotector
  assert.deepStrictEqual([L('空').damageType, L('空').attacks], ['none', false]);                                                        // bard: no attack
  assert.deepStrictEqual([L('炎熔').damageType, L('炎熔').targets, L('炎熔').aoe], ['arts', 1, 'splash']);                               // splash radius not modelled
  assert.strictEqual(L('刻刀').hits, 2);                                                                                                 // sword: two hits
  assert.deepStrictEqual([L('杜宾').canHitAir, L('雷蛇').canHitAir, L('阿消').anyTile], [false, true, true]);                             // instructor / shotprotector / pusher
  assert.strictEqual(L('送葬人').targets, O.TARGETS_ALL);
  assert.deepStrictEqual([L('调香师').damageType, L('调香师').targets], ['heal', 3]);
});

// ---------- roster ----------
ok('loadRoster loads all 12 example operators with the collectible mods applied', () => {
  const file = path.join(__dirname, 'roster.example.json');
  const t0 = Date.now(), r = O.loadRoster(file), ms = Date.now() - t0;
  assert.deepStrictEqual(r.operators.map(o => o.name), ['桃金娘', '德克萨斯', '塞雷娅', '星熊', '银灰', '史尔特尔', '能天使', '蓝毒', '艾雅法拉', '逻各斯', '夜莺', '棘刺']);
  assert.deepStrictEqual(r.operators.map(o => o.skillIndex + 1), [1, 2, 2, 2, 3, 3, 3, 2, 3, 3, 3, 3]); // CONTRACT 9
  assert.ok(r.operators.every(o => o.elite === 2 && o.trust === 100 && o.skillId && o.skillLevel >= 7 && o.skillLevel <= 10 && o.range.length > 0));
  assert.ok(r.operators.every(o => o.level >= (o.rarity === 6 ? 60 : 50) && o.level <= (o.rarity === 6 ? 80 : 70)));
  assert.deepStrictEqual([r.raw.example, r.secrecy, r.floor], [true, 15, 5]);
  assert.ok(r.raw.collectibles.length >= 4 && r.raw.collectibles.length <= 6);
  assert.ok(r.mods.some(m => m.when) && r.mods.every(m => m.stat && m.source));
  assert.deepStrictEqual(r.rules.map(x => x.rule), ['deployLimit', 'meleeOnHighGround']);
  assert.deepStrictEqual(r.dynamicMods, []);
  r.raw.operators.forEach((entry, i) => {
    const base = O.loadOperator(entry.name, entry), op = r.operators[i];
    near(op.atk, base.atk * 1.25, entry.name + ' atk');                 // 贵族刺剑 (melee) or 银餐叉 (ranged)
    near(op.hp, base.hp * 1.35, entry.name + ' hp');                    // 急救药箱
    near(op.def, base.def * 1.04, entry.name + ' def');                 // 地形图
    assert.strictEqual(op.attackSpeed, base.attackSpeed + (base.profession === 'SNIPER' ? 70 : 0)); // 残弩-神速
    near(op.interval, op.baseAttackTime * 100 / op.attackSpeed);
    assert.strictEqual(op.cost, base.cost);
  });
  const sa = r.operators[4]; // 银灰 E2 L80, module X3: by hand from the frames
  const lerp = k => Math.round(E2[0].data[k] + (E2[1].data[k] - E2[0].data[k]) * 79 / 89);
  near(sa.atk, (lerp('atk') + 50 + (sa.module && sa.module.bonus ? 70 : 0)) * 1.25);
  console.log(`   (roster loaded in ${ms} ms)`);
});
ok('tables are cached: 500 further loadOperator calls stay fast', () => {
  const t0 = Date.now();
  for (let i = 0; i < 500; i++) O.loadOperator('能天使', { level: 1 + (i % 90) });
  const ms = Date.now() - t0;
  assert.ok(ms < 500, 'took ' + ms + ' ms');
});

console.log(`\n${n} checks passed`);
