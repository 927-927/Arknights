// combat/operators.js: operator objects (stats, range, attack classification), the modifier algebra shared by
// operators and enemies, secrecy (保密等级) and stage modifiers, and the damage formulas. See CONTRACT.md 1-3.
// Data: ArknightsGameData character_table / range_table (+ uniequip_table / battle_equip_table for modules).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GD = path.join(ROOT, 'research', 'sources', 'gamedata');

// ---------- lazy tables (15 MB of JSON: parsed once, on first use) ----------
const TABLES = {};
function table(name, optional) {
  if (!(name in TABLES)) {
    const f = path.join(GD, name + '.json');
    TABLES[name] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  if (!TABLES[name] && !optional) throw new Error('missing game data: ' + name + '.json in ' + GD);
  return TABLES[name];
}

// Lookup by Chinese name, char id or English appellation (case-insensitive). Only "char_" keys are operators
// (tokens and traps live in the same table). Nine names are duplicated by non-obtainable NPC copies
// (暮落, Sharp, ...): the obtainable one wins.
let INDEX = null;
function resolveId(name) {
  const ct = table('character_table');
  if (!INDEX) {
    INDEX = new Map();
    const ids = Object.keys(ct).filter(k => k.startsWith('char_')).sort((a, b) => !!ct[a].isNotObtainable - !!ct[b].isNotObtainable);
    for (const id of ids) for (const key of [id, ct[id].name, (ct[id].appellation || '').toLowerCase()]) if (key && !INDEX.has(key)) INDEX.set(key, id);
  }
  const s = String(name).trim();
  const id = INDEX.get(s) || INDEX.get(s.toLowerCase());
  if (!id) throw new Error('operator not found: ' + name);
  return id;
}

// ---------- ranges ----------
// range_table grids are {row, col} facing east: col is forward (银灰 E2 "3-12" reaches col 3).
// ASSUMPTION: dr = -row (the game's y axis points up the screen, so row +1 is one tile up = grid row r-1).
// The data cannot confirm the sign: all 75 ranges in range_table are mirror-symmetric in row (checked in
// test_operators.js), so the choice changes no result today.
const RANGES = new Map();
const freezeRange = list => Object.freeze(list.map(o => Object.freeze(o)));
function rangeOf(rangeId) {
  if (!RANGES.has(rangeId)) {
    const e = table('range_table')[rangeId];
    if (!e) throw new Error('unknown rangeId: ' + rangeId);
    RANGES.set(rangeId, freezeRange(e.grids.map(g => ({ dr: 0 - g.row, dc: g.col }))));
  }
  return RANGES.get(rangeId);
}

// CONTRACT 1: clockwise on screen, (dr, dc) -> (dc, -dr) per step E->S->W->N. Results are cached per range
// array and frozen (ranges are values: build a new list instead of editing one).
const DIR_STEPS = { E: 0, S: 1, W: 2, N: 3 };
const ROTATED = new WeakMap();
function rotate(range, dir) {
  const steps = DIR_STEPS[dir];
  if (steps === undefined) throw new Error('unknown direction: ' + dir);
  let c = ROTATED.get(range);
  if (!c) ROTATED.set(range, c = {});
  if (!c[dir]) {
    let out = range.map(o => ({ dr: o.dr, dc: o.dc }));
    for (let k = 0; k < steps; k++) out = out.map(o => ({ dr: o.dc, dc: 0 - o.dr })); // 0 - x: never -0
    c[dir] = freezeRange(out);
  }
  return c[dir];
}

// ---------- operator stats ----------
const ATTR = { hp: 'maxHp', atk: 'atk', def: 'def', res: 'magicResistance', cost: 'cost', block: 'blockCnt', attackSpeed: 'attackSpeed', baseAttackTime: 'baseAttackTime', redeploy: 'respawnTime' };
// ASSUMPTION: interpolated HP/ATK/DEF are rounded to the nearest integer (what the operator panel shows and what
// the community DPS calculators do). Only maxHp/atk/def differ between the two key frames of a phase (checked).
const ROUNDED = new Set(['hp', 'atk', 'def']);
// favorKeyFrames have levels 0 and 50 for all 468 operators; favor level 50 = 100% trust, later trust adds nothing.
// ASSUMPTION: favor level = floor(trust% / TRUST_PER_FAVOR_LEVEL) (favor levels are whole numbers), and each
// trust bonus is rounded like the level stats.
const TRUST_CAP = 100, TRUST_PER_FAVOR_LEVEL = 2;
// potentialRanks[].buff.attributes.attributeModifiers: these 7 types, formulaItem always ADDITION (surveyed).
const POTENTIAL_ATTR = { COST: 'cost', RESPAWN_TIME: 'redeploy', ATK: 'atk', MAX_HP: 'hp', DEF: 'def', ATTACK_SPEED: 'attackSpeed', MAGIC_RESISTANCE: 'res' };
// battle_equip_table phases[].attributeBlackboard keys (all flat additions; surveyed).
const MODULE_ATTR = { max_hp: 'hp', atk: 'atk', def: 'def', attack_speed: 'attackSpeed', magic_resistance: 'res', cost: 'cost', respawn_time: 'redeploy', block_cnt: 'block' };
// ASSUMPTION: a module named without a stage is at stage 1 (the lowest bonuses).
const MODULE_STAGE_DEFAULT = 1;
// `targets` value for "everything in range" traits; finite so operator objects stay JSON-safe.
const TARGETS_ALL = 99;
// ASSUMPTION: a splash attack (群体 / 小范围: damage in a radius around the target) counts as 1 target, a lower
// bound, because the splash radius is not modelled. The operator carries aoe: 'splash' so callers can do better.
const SPLASH_TARGETS = 1;

const phaseNum = p => Number(String(p).replace('PHASE_', ''));
const unlocked = (cond, elite, level) => !cond || phaseNum(cond.phase) < elite || (phaseNum(cond.phase) === elite && (cond.level || 1) <= level);
const stripTags = s => String(s || '').replace(/<[^>]*>/g, '');
const lerpFrames = (frames, key, f) => { const a = frames[0].data[key], b = frames[frames.length - 1].data[key]; return a + (b - a) * f; };

// module: 'X' | 'Y3' | 'lor-x' | uniEquipId | module name | {type|id|name, stage}. Applied here: the flat attribute
// bonuses of the stage, the trait sentence the module overrides (it drives the basic-attack classification, e.g.
// 夜莺 Y "同时恢复四个友方单位的生命" -> targets 4) and the range of a "攻击范围扩大" module. Every other trait addition
// and talent change is left to skills.js (talentsOf / traitOf), which models or notes it.
// ASSUMPTION: a module whose trait addition is exactly "攻击范围扩大" gets the rangeId of its talent candidate with
// displayRangeId: true. The field is undocumented; in battle_equip_table the 11 modules with that addition are
// exactly the 11 with such a candidate (rin-x, spc-x, soc-y; checked in test_operators.js).
const MODULE_RANGE_TEXT = '攻击范围扩大';
function resolveModule(c, id, spec, elite, level, potential) {
  if (spec == null || spec === false || spec === '') return null;
  const ue = table('uniequip_table', true), be = table('battle_equip_table', true);
  if (!ue || !be) return { ignored: true, reason: 'uniequip_table.json / battle_equip_table.json not downloaded' };
  let want = String(typeof spec === 'object' ? spec.id || spec.type || spec.name : spec).trim(), stage = typeof spec === 'object' ? spec.stage : undefined;
  const short = /^([A-Za-z])([1-3])$/.exec(want);
  if (short) { want = short[1]; stage = stage ?? Number(short[2]); }
  stage = stage ?? MODULE_STAGE_DEFAULT;
  const equips = (ue.charEquip[id] || []).map(e => ue.equipDict[e]).filter(e => be[e.uniEquipId]); // drops the stat-less 证章
  const e = equips.find(x => x.uniEquipId === want || x.uniEquipName === want || x.typeIcon.toLowerCase() === want.toLowerCase() || x.typeName2 === want.toUpperCase());
  if (!e) throw new Error(`${c.name}: module ${want} not found (has: ${equips.map(x => x.typeIcon).join(', ') || 'none'})`);
  if (!unlocked({ phase: e.unlockEvolvePhase, level: e.unlockLevel }, elite, level)) throw new Error(`${c.name}: module ${e.typeIcon} needs ${e.unlockEvolvePhase} level ${e.unlockLevel}`);
  const ph = be[e.uniEquipId].phases.find(p => p.equipLevel === stage);
  if (!ph) throw new Error(`${c.name}: module ${e.typeIcon} has no stage ${stage}`);
  const bonus = {};
  for (const b of ph.attributeBlackboard || []) {
    if (!MODULE_ATTR[b.key]) throw new Error(`${c.name}: unknown module attribute ${b.key}`);
    bonus[MODULE_ATTR[b.key]] = (bonus[MODULE_ATTR[b.key]] || 0) + b.value;
  }
  // candidates in force: unlocked at this elite/level and potential (same rule as the character trait below)
  const inForce = b => ((b && b.candidates) || []).filter(t => unlocked(t.unlockCondition, elite, level) && (t.requiredPotentialRank || 0) <= potential - 1);
  let trait = null, rangeId = null;
  const additions = [];
  for (const p of ph.parts || []) {
    if (p.isToken) continue;             // parts for the operator's summon / token (迷迭香 isw-a), not for her
    const t = inForce(p.overrideTraitDataBundle).at(-1);
    if (t && t.overrideDescripton) trait = { text: stripTags(t.overrideDescripton), blackboard: t.blackboard || [] };
    if (t && t.additionalDescription) additions.push(stripTags(t.additionalDescription));
  }
  if (additions.includes(MODULE_RANGE_TEXT)) {
    for (const p of ph.parts || []) { const t = !p.isToken && inForce(p.addOrOverrideTalentDataBundle).find(x => x.displayRangeId && x.rangeId); if (t) rangeId = t.rangeId; }
    if (!rangeId) throw new Error(`${c.name}: module ${e.typeIcon} says ${MODULE_RANGE_TEXT} but carries no range`);
  }
  return { id: e.uniEquipId, name: e.uniEquipName, type: e.typeIcon, stage, bonus, trait, rangeId };
}

// Basic-attack classification from the branch trait sentence (character_table description, or the trait
// candidate's overrideDescripton unlocked at this elite), with sub-profession exceptions where the sentence misleads.
const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 };
function classify(c, desc, traitBB, block) {
  const sub = c.subProfessionId;
  // 法术伤害 -> arts; a MEDIC whose trait restores HP -> heal; else physical. No branch trait makes the basic
  // attack true damage. 治疗 alone is not enough: guardian ("技能可以治疗友方单位"), musha/reaper/unyield
  // ("不成为…治疗目标" / "无法被友方角色治疗") mention it and attack physically, hence the MEDIC guard.
  let damageType = /法术伤害/.test(desc) ? 'arts' : c.profession === 'MEDIC' && /恢复|治疗/.test(desc) ? 'heal' : 'physical';
  // artsprotector: "技能开启时普通攻击会造成法术伤害" = arts only while the skill is on; the basic attack is physical.
  if (sub === 'artsprotector') damageType = 'physical';
  // bard ("不攻击，持续恢复…"), phalanx ("通常时不攻击"), librator ("通常不攻击"), THRM-EX ("不进行攻击"): no basic
  // attack outside skills. The bard's healing aura is not an attack and is not modelled here.
  const attacks = !/^(通常时?)?不(进行)?攻击/.test(desc);
  if (!attacks) damageType = 'none';

  // Simultaneous targets where the sentence states a number or a countable rule; splash radius is NOT modelled.
  let targets = 1, aoe = null, m;
  if ((m = /同时(?:攻击|恢复)([一两二三四五\d])个/.exec(desc))) targets = CN_NUM[m[1]] || Number(m[1]);         // ringhealer: 3
  else if ((m = /在(\d+|\{[^}]*\})个(?:敌人|友方单位)间跳跃/.exec(desc))) {                                    // chain caster / chain healer
    const bb = (traitBB || []).find(b => /max_target$/.test(b.key));
    targets = /^\d+$/.test(m[1]) ? Number(m[1]) : bb ? bb.value : 1;
    aoe = 'chain';                                                  // per-jump falloff (15% / 25%) not modelled
  } else if (/同时攻击阻挡的所有敌人/.test(desc)) { targets = block; aoe = 'blocked'; }                         // centurion, crusher, pusher
  else if (/攻击范围内的?所有敌人/.test(desc)) { targets = TARGETS_ALL; aoe = 'range'; }                        // reaperrange, stalker
  else if (/群体|小范围/.test(desc)) { targets = SPLASH_TARGETS; aoe = 'splash'; }
  const hits = /连续造成两次伤害/.test(desc) ? 2 : 1;               // sword branch: two hits per basic attack

  // ASSUMPTION: an operator may target FLY enemies iff it stands on a RANGED tile (unless its trait says ground
  // only: 地面敌人 without 空中敌人, the bombarders), or it is a melee branch whose trait grants a ranged attack
  // (远程攻击: lord, agent, shotprotector). Healers get true from the same rule; they never target enemies anyway.
  // skybreaker (埃癸斯: "起飞后只攻击空中敌人；技能开启时降落…攻击地面敌人时…") is true: air-only while flying is not modelled.
  const canHitAir = c.position === 'RANGED' ? !/地面敌人/.test(desc) || /空中敌人/.test(desc) : /远程攻击/.test(desc);
  return { damageType, attacks, targets, aoe, hits, canHitAir, anyTile: /可以放置于远程位/.test(desc) };
}

// CONTRACT 2. Panel stats only (plus the module trait sentence and range, see resolveModule): talents and the other
// module trait/talent changes are left to skills.js (raw.talents/trait, module).
function loadOperator(name, o = {}) {
  const id = resolveId(name), c = table('character_table')[id];
  const fail = msg => { throw new Error(`${c.name}: ${msg}`); };
  const elite = o.elite ?? c.phases.length - 1;
  if (!Number.isInteger(elite) || elite < 0 || elite >= c.phases.length) fail(`elite ${elite} not available (0..${c.phases.length - 1})`);
  const ph = c.phases[elite], frames = ph.attributesKeyFrames;
  const level = o.level ?? ph.maxLevel;
  if (!Number.isInteger(level) || level < 1 || level > ph.maxLevel) fail(`level ${level} outside 1..${ph.maxLevel} at elite ${elite}`);
  const potential = o.potential ?? 1, maxPot = (c.potentialRanks || []).length + 1;
  if (!Number.isInteger(potential) || potential < 1 || potential > maxPot) fail(`potential ${potential} outside 1..${maxPot}`);
  const trust = o.trust ?? 100;
  if (!(trust >= 0 && trust <= 200)) fail(`trust ${trust} outside 0..200`);

  // level: linear between the two key frames of the phase
  const lo = frames[0].level, hi = frames[frames.length - 1].level, f = hi > lo ? (level - lo) / (hi - lo) : 0;
  const s = {};
  for (const [k, a] of Object.entries(ATTR)) { const v = lerpFrames(frames, a, f); s[k] = ROUNDED.has(k) ? Math.round(v) : v; }
  // trust: linear in favor level up to the last favor key frame (see TRUST_PER_FAVOR_LEVEL)
  const fav = c.favorKeyFrames || [];
  if (fav.length) {
    const top = fav[fav.length - 1].level, favLv = Math.min(top, Math.floor(Math.min(trust, TRUST_CAP) / TRUST_PER_FAVOR_LEVEL));
    for (const [k, a] of Object.entries(ATTR)) s[k] += Math.round(lerpFrames(fav, a, top > 0 ? favLv / top : 0));
  }
  // potential p applies potentialRanks[0 .. p-2] (flat additions; CUSTOM ranks = talent upgrades, left to skills.js)
  for (const rank of (c.potentialRanks || []).slice(0, potential - 1)) {
    for (const m of (rank.buff && rank.buff.attributes.attributeModifiers) || []) {
      if (!POTENTIAL_ATTR[m.attributeType] || m.formulaItem !== 'ADDITION') fail(`unknown potential modifier ${m.attributeType}/${m.formulaItem}`);
      s[POTENTIAL_ATTR[m.attributeType]] += m.value;
    }
  }
  const module = resolveModule(c, id, o.module, elite, level, potential);
  if (module && module.bonus) for (const [k, v] of Object.entries(module.bonus)) s[k] += v;

  // skill: 1-based in options, default = last skill unlocked at this elite
  const open = c.skills.map((sk, i) => unlocked(sk.unlockCond, elite, level) ? i : -1).filter(i => i >= 0);
  let skillIndex = open.length ? open[open.length - 1] : -1;
  if (o.skill != null) {
    if (!Number.isInteger(o.skill) || o.skill < 1 || o.skill > c.skills.length) fail(`skill ${o.skill} outside 1..${c.skills.length}`);
    if (!open.includes(o.skill - 1)) fail(`skill ${o.skill} is not unlocked at elite ${elite}`);
    skillIndex = o.skill - 1;
  }
  const skillLevel = o.skillLevel ?? 7;
  if (!Number.isInteger(skillLevel) || skillLevel < 1 || skillLevel > 10) fail(`skillLevel ${skillLevel} outside 1..10`);
  if (skillLevel > 7 && elite < 2) fail(`skillLevel ${skillLevel} (mastery) needs elite 2`);

  // trait candidate in force (some branches update the sentence or its numbers at E1/E2); a module override wins
  const cands = ((c.trait && c.trait.candidates) || []).filter(t => unlocked(t.unlockCondition, elite, level) && (t.requiredPotentialRank || 0) <= potential - 1);
  const trait = cands[cands.length - 1], modTrait = module && module.trait;
  const desc = modTrait ? modTrait.text : stripTags((trait && trait.overrideDescripton) || c.description);
  const cls = classify(c, desc, modTrait ? modTrait.blackboard : trait && trait.blackboard, s.block);
  const rangeId = (module && module.rangeId) || ph.rangeId;

  return {
    id, name: c.name, appellation: c.appellation, rarity: Number(String(c.rarity).replace('TIER_', '')),
    profession: c.profession, subProfession: c.subProfessionId, position: c.position,
    elite, level, potential, trust,
    cost: s.cost, redeploy: s.redeploy, block: s.block, hp: s.hp, atk: s.atk, def: s.def, res: s.res,
    attackSpeed: s.attackSpeed, baseAttackTime: s.baseAttackTime, interval: s.baseAttackTime * 100 / s.attackSpeed,
    damageType: cls.damageType, targets: cls.targets, canHitAir: cls.canHitAir,
    range: rangeOf(rangeId), rangeId,
    skillIndex, skillLevel, skillId: skillIndex >= 0 ? c.skills[skillIndex].skillId : null,
    raw: { talents: c.talents, trait: c.trait, description: c.description },
    // extensions (not in CONTRACT 2): basic attack exists / hits per attack / AoE kind / deployable on both tile kinds
    attacks: cls.attacks, hits: cls.hits, aoe: cls.aoe, anyTile: cls.anyTile, traitText: desc, module,
  };
}

// ---------- modifiers (CONTRACT 3) ----------
const STAT_ALIAS = { maxHp: 'hp', max_hp: 'hp', magicResistance: 'res', magic_resistance: 'res', attack_speed: 'attackSpeed', aspd: 'attackSpeed', respawnTime: 'redeploy', respawn_time: 'redeploy', blockCnt: 'block', block_cnt: 'block', moveSpeed: 'speed', ms: 'speed' };
const STAT_DEFAULT = { damageTaken: 1 };        // value of a stat the unit does not carry yet
// ASSUMPTION: attack speed is clamped to 10..600 when the interval is computed (community-documented game rule).
const ATTACK_SPEED_MIN = 10, ATTACK_SPEED_MAX = 600;
// ASSUMPTION: an enemy instance that carries only `interval` is treated as baseAttackTime = interval at attack
// speed 100 when an attackSpeed / baseAttackTime modifier reaches it.
const ENEMY_ATTACK_SPEED_ASSUMED = 100;

// `when`: every key must hold; the value is looked up in ctx first, then on the unit; an array means "any of";
// a field neither has fails the condition (so {type:'BOSS'} never matches an operator). {all:true} always holds.
function matchWhen(when, unit, ctx) {
  if (!when) return true;
  for (const k of Object.keys(when)) {
    if (k === 'all') continue;
    const want = when[k], have = ctx && ctx[k] !== undefined ? ctx[k] : unit[k];
    if (Array.isArray(want) ? !want.includes(have) : want !== have) return false;
  }
  return true;
}

// Returns a NEW unit. Per stat: all matching pct SUMMED and applied once, then add, then each mul, then set.
// {rule: ...} entries are skipped. pct/add/mul on a stat the unit lacks (and that has no default) do nothing.
function applyMods(unit, mods, ctx) {
  const u = { ...unit }, by = new Map();
  for (const m of mods || []) {
    if (!m || m.rule || !m.stat || !matchWhen(m.when, unit, ctx)) continue;
    const stat = STAT_ALIAS[m.stat] || m.stat;
    let g = by.get(stat);
    if (!g) by.set(stat, g = { pct: 0, add: 0, mul: [], set: undefined });
    if (m.op === 'pct') g.pct += m.value;
    else if (m.op === 'add') g.add += m.value;
    else if (m.op === 'mul') g.mul.push(m.value);
    else if (m.op === 'set') g.set = m.value;
    else throw new Error('unknown modifier op: ' + m.op);
  }
  if ((by.has('attackSpeed') || by.has('baseAttackTime')) && u.interval > 0 && u.baseAttackTime === undefined && u.attackSpeed === undefined) {
    u.baseAttackTime = u.interval; u.attackSpeed = ENEMY_ATTACK_SPEED_ASSUMED;
  }
  for (const [stat, g] of by) {
    let x = u[stat] ?? STAT_DEFAULT[stat];
    if (x === undefined) { if (g.set !== undefined) u[stat] = g.set; continue; }
    x = x * (1 + g.pct) + g.add;
    for (const k of g.mul) x *= k;
    u[stat] = g.set !== undefined ? g.set : x;
  }
  if (u.baseAttackTime > 0 && u.attackSpeed !== undefined) u.interval = u.baseAttackTime * 100 / Math.min(ATTACK_SPEED_MAX, Math.max(ATTACK_SPEED_MIN, u.attackSpeed));
  return u;
}

// ---------- secrecy (保密等级) ----------
// BWIKI 保密难度 table, column 敌人难度: "每进入新的一层，所有敌人攻击力和生命值较上一层额外+X%". Index = level.
const SECRECY_RATE_PCT = [0, 0, 0, 0, 0, 1, 2, 3, 5, 6, 7, 8, 10, 12, 16, 20, 25];
// ASSUMPTION: 'additive' = 1 + rate*steps; 'compound' = (1 + rate)^steps. The wiki sentence fits both.
const SECRECY_PER_FLOOR_DEFAULT = 'additive';
// ASSUMPTION: floor 1 has ZERO steps (the bonus is granted on entering a NEW floor, relative to the one before).
// Pass {floorOneSteps: 1} for the other reading (floor 1 already carries one step).
const SECRECY_FLOOR_ONE_STEPS = 0;
// ASSUMPTION: the per-floor bonus is a pct modifier, so it SUMS with the other secrecy percentages on the same
// stat (N5 +30% HP, N8 +15% ATK). Pass {floorOp: 'mul'} to make it an independent multiplier instead.
const SECRECY_FLOOR_OP_DEFAULT = 'pct';
// Effects of the table that are not numbers (or whose numbers the sources do not give): reported, not modelled.
const SECRECY_UNMODELLED = { 13: '“玻利瓦尔，症结之核” DEF up, “未熄之地” burn damage', 14: '“源阶方” max HP up, team HP drain when active', 15: '“猎犬proto” max HP up, heals the boss when attacking' };

// The effect column is inherited by higher levels ("均继承上一难度效果"); the per-floor rate is the single rate
// of the current level. Enemy-side stat modifiers plus {rule:'deployLimit'} for N10.
function secrecyMods(level, floor, opts = {}) {
  if (!Number.isInteger(level) || level < 0 || level >= SECRECY_RATE_PCT.length) throw new Error('secrecy level outside 0..16: ' + level);
  if (!Number.isInteger(floor) || floor < 1) throw new Error('floor must be an integer >= 1: ' + floor);
  const perFloor = opts.perFloor || SECRECY_PER_FLOOR_DEFAULT, floorOp = opts.floorOp || SECRECY_FLOOR_OP_DEFAULT;
  if (perFloor !== 'additive' && perFloor !== 'compound') throw new Error('perFloor must be additive or compound');
  if (floorOp !== 'pct' && floorOp !== 'mul') throw new Error('floorOp must be pct or mul');
  const rate = SECRECY_RATE_PCT[level], steps = floor - 1 + (opts.floorOneSteps ?? SECRECY_FLOOR_ONE_STEPS);
  const bonus = perFloor === 'additive' ? rate * steps / 100 : Math.pow(1 + rate / 100, steps) - 1;
  const out = [];
  if (bonus > 0) {
    const source = `secrecy N${level} floor ${floor} (+${rate}%/floor, ${perFloor})`;
    for (const stat of ['atk', 'hp']) out.push(floorOp === 'pct' ? { stat, op: 'pct', value: bonus, source } : { stat, op: 'mul', value: 1 + bonus, source });
  }
  if (level >= 5) out.push({ stat: 'hp', op: 'pct', value: 0.3, source: 'secrecy N5: all enemies +30% max HP' });
  if (level >= 8) out.push({ stat: 'atk', op: 'pct', value: 0.15, when: { type: ['ELITE', 'BOSS'] }, source: 'secrecy N8: elite and leader enemies +15% ATK' });
  if (level >= 10) out.push({ rule: 'deployLimit', add: -1, source: 'secrecy N10: deploy limit -1' });
  if (level >= 11) out.push({ stat: 'damageTaken', op: 'mul', value: 0.8, when: { type: 'BOSS' }, source: 'secrecy N11: leaders take 20% less damage' });
  return out;
}

// ---------- stage modifiers ----------
// tomimi mod keys -> our stats. `weight` goes to massLevel (stage_model reuses `weight` for the spawn share).
const STAGE_STAT = { atk: 'atk', def: 'def', hp: 'hp', res: 'res', ms: 'speed', aspd: 'attackSpeed', atk_interval: 'baseAttackTime', range: 'rangeRadius', weight: 'massLevel' };
const UNIT_TYPES = ['NORMAL', 'ELITE', 'BOSS'], UNIT_MOTIONS = ['WALK', 'FLY'];
// ASSUMPTION: n_mods belong to normal mode only and are NOT active in 紧急作战 (elite). Evidence: 猎犬病原 n_mods
// enable hidden group "normal" (2 屠夫) and elite_mods enable "raid" (3 术师) while eliteDesc says the 屠夫 are
// REPLACED. Pass {normalInElite: true} to get n_mods in elite mode too.
const STAGE_NORMAL_IN_ELITE = false;

// mc = decoded mapConfig (or a loadStage() object). all_mods apply in both modes, n_mods in normal mode,
// elite_mods in 紧急作战. Surveyed over the 77 IS6 stages: targets are "ALL", "system", or enemy_*/trap_* keys.
// forbid: "row,col" strings with the row counted from the BOTTOM (checked on 4 maps) -> grid {r, c}.
function stageMods(mc, opts = {}) {
  mc = mc && mc.mc ? mc.mc : mc;
  const elite = !!opts.elite, H = mc.mapData.map.length;
  const fields = ['all_mods'].concat(elite ? ((opts.normalInElite ?? STAGE_NORMAL_IN_ELITE) ? ['n_mods', 'elite_mods'] : ['elite_mods']) : ['n_mods']);
  const out = { mods: [], forbid: [], unhandled: [], hiddenGroups: { enable: [], disable: [] }, replace: [] };
  for (const field of fields) {
    const source = `stage ${mc.id} ${field}`;
    for (const g of mc[field] || []) {
      const targets = g.targets || [];
      if (g.special) {
        for (const [name, val] of Object.entries(g.special)) {
          // 隐匿 granted to the named enemies: a rule, not a stat
          if (name === 'stealth') out.mods.push({ rule: 'enemyStealth', when: { key: targets.slice() }, source });
          // mods_1 / mods_2 (per-form stat blocks of transforming enemies) and conditional auras: trigger unknown
          else out.unhandled.push({ field, targets, special: name, value: val, reason: 'conditional / per-form effect, trigger not in the data' });
        }
      }
      for (const m of g.mods || []) {
        if (targets.includes('system')) {
          if (m.key === 'global_forbid_location') for (const s of m.value) { const [row, col] = s.split(',').map(Number); out.forbid.push({ r: H - 1 - row, c: col }); }
          else if (m.key === 'level_hidden_group_enable') { out.hiddenGroups.enable.push(m.valueStr); out.mods.push({ rule: 'hiddenGroupEnable', group: m.valueStr, source }); }
          else if (m.key === 'level_hidden_group_disable') { out.hiddenGroups.disable.push(m.valueStr); out.mods.push({ rule: 'hiddenGroupDisable', group: m.valueStr, source }); }
          else if (m.key === 'level_enemy_replace') { out.replace.push({ from: m.target, to: m.value }); out.mods.push({ rule: 'enemyReplace', from: m.target, to: m.value, source }); }
          else out.unhandled.push({ field, targets, key: m.key, value: m.value, reason: 'unknown system key' });
          continue;
        }
        const stat = STAGE_STAT[m.key];
        if (!stat || (m.mode !== 'mul' && m.mode !== 'add') || typeof m.value !== 'number') { out.unhandled.push({ field, targets, key: m.key, mode: m.mode, value: m.value, reason: 'unknown key or mode' }); continue; }
        const mk = when => out.mods.push({ stat, op: m.mode, value: m.value, when, source });
        if (targets.includes('ALL')) { mk({ all: true }); continue; }
        const types = targets.filter(t => UNIT_TYPES.includes(String(t).toUpperCase())).map(t => t.toUpperCase());
        const motions = targets.filter(t => UNIT_MOTIONS.includes(String(t).toUpperCase())).map(t => t.toUpperCase());
        const keys = targets.filter(t => !UNIT_TYPES.includes(String(t).toUpperCase()) && !UNIT_MOTIONS.includes(String(t).toUpperCase()));
        if (types.length) mk({ type: types });
        if (motions.length) mk({ motion: motions });
        if (keys.length) mk({ key: keys });
      }
    }
  }
  return out;
}

// ---------- damage ----------
// HANDOFF formulas. Physical: max(ATK - DEF, 5% ATK). Arts: ATK * (1 - RES/100), floored at ARTS_MIN_DAMAGE_RATIO.
// True: ATK. Then the target's damageTaken multiplier (default 1).
// ASSUMPTION: DEF and RES below 0 (after debuffs) count as 0, and damageTaken scales the floored hit as well.
const PHYSICAL_MIN_DAMAGE_RATIO = 0.05;             // HANDOFF: max(ATK - DEF, 5% ATK)
// ASSUMPTION: arts hits have the same 5% ATK floor as physical ones. HANDOFF gives arts = ATK*(1 - RES/100) with no
// floor; the community wikis state a 5% floor for both, the game data cannot show it. It changes a hit only when
// RES > 95. hitDamage(..., {artsMinRatio: 0}) gives the HANDOFF formula without a floor.
const ARTS_MIN_DAMAGE_RATIO = 0.05;
const MIN_DAMAGE_RATIO = PHYSICAL_MIN_DAMAGE_RATIO; // older name, kept for callers
function hitDamage(atk, damageType, target, opts) {
  const t = target || {}, artsMin = opts && opts.artsMinRatio !== undefined ? opts.artsMinRatio : ARTS_MIN_DAMAGE_RATIO;
  let d;
  if (damageType === 'physical') d = Math.max(atk - Math.max(0, t.def || 0), PHYSICAL_MIN_DAMAGE_RATIO * atk);
  else if (damageType === 'arts') d = Math.max(atk * (1 - Math.max(0, t.res || 0) / 100), artsMin * atk);
  else if (damageType === 'true') d = atk;
  else return 0; // heal / none
  return d * (t.damageTaken ?? 1);
}

// Sustained single-target DPS of an operator object or a CombatProfile against one enemy.
function dpsAgainst(p, enemy) {
  if (p.attacks === false || !(p.interval > 0)) return 0;
  return hitDamage(p.atk * (p.atkScale || 1), p.damageType, enemy) * (p.hits || 1) / p.interval;
}

// ---------- roster ----------
// File: { secrecy, floor, operators: [{name, elite, level, potential, trust, skill, skillLevel, module}],
//         collectibles: [{name, note, mods: [modifier | {rule: ...}], placeholder?}] }.
// Returns operators with the collectible stat mods already applied (do NOT apply `mods` to them again).
// ASSUMPTION: collectible percentages on one stat add up with each other (pct) and act on the panel stat;
// skill and talent buffs are layered on top by skills.js. `dynamicMods` = mods whose `when` needs battle context
// (a key that is not an operator field), so they could not be applied here.
function loadRoster(file) {
  const p = path.resolve(file || path.join(__dirname, 'roster.example.json'));
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const mods = [], rules = [];
  for (const col of raw.collectibles || []) for (const m of col.mods || []) (m.rule ? rules : mods).push({ ...m, source: m.source || 'collectible ' + col.name });
  const base = (raw.operators || []).map(e => loadOperator(e.name, e));
  // A squad holds each operator once, and the simulator and plans key operators by name (candidates.js by roster
  // index), so a repeated operator is an error here, after names are resolved ('能天使' = 'Exusiai' = char id).
  const seen = new Map();
  base.forEach((op, i) => {
    if (seen.has(op.name)) throw new Error(`${p}: duplicate operator ${op.name} in roster (entries ${seen.get(op.name) + 1} and ${i + 1})`);
    seen.set(op.name, i);
  });
  const isStatic = m => Object.keys(m.when || {}).every(k => k === 'all' || base.some(op => k in op));
  const dynamicMods = mods.filter(m => !isStatic(m));
  const operators = base.map(op => applyMods(op, mods.filter(isStatic)));
  return { operators, raw, mods, rules, dynamicMods, secrecy: raw.secrecy ?? 0, floor: raw.floor ?? 1, path: p };
}

module.exports = {
  loadOperator, rotate, applyMods, secrecyMods, stageMods, hitDamage, dpsAgainst, loadRoster,
  // extras
  rangeOf, resolveId, matchWhen, table,
  TARGETS_ALL, SPLASH_TARGETS, MIN_DAMAGE_RATIO, PHYSICAL_MIN_DAMAGE_RATIO, ARTS_MIN_DAMAGE_RATIO, MODULE_STAGE_DEFAULT, MODULE_RANGE_TEXT, ATTACK_SPEED_MIN, ATTACK_SPEED_MAX, ENEMY_ATTACK_SPEED_ASSUMED,
  SECRECY_RATE_PCT, SECRECY_PER_FLOOR_DEFAULT, SECRECY_FLOOR_ONE_STEPS, SECRECY_FLOOR_OP_DEFAULT, SECRECY_UNMODELLED, STAGE_NORMAL_IN_ELITE,
};
