// combat/skills.js: skill specs, combat profiles (base / skill active) and the SP automaton. See CONTRACT.md 4.
// Data: skill_table levels[skillLevel-1] (spData, duration, rangeId, blackboard, description template),
// character_table talents / trait (op.raw), battle_equip_table (module talent and trait overrides).
//
// Every number comes from a blackboard. A description is used only to decide what a blackboard key MEANS:
// hand-checked handlers match the whole description against the template they were checked on, the generic
// compiler matches clause by clause; text that does not match is never guessed, it becomes a note.
//
// fidelity: 'exact'  = hand-checked and every clause of skill, talents and trait is in the contract fields;
//           'approx' = usable, each clause left out (or only exposed through an optional field) has a note;
//           'unsupported' = behaves as no skill: base profile only, never ready.
//
// Optional fields beyond CONTRACT 4 (a simulator may ignore all of them; then the notes describe the error):
//   profile: atkScaleMelee, atkScaleByType{ELITE,BOSS}, bonusHit{scale,damageType}, hitsByTarget[],
//            dot{dps,dpsVsRanged?,duration,damageType}, onHitDebuff{duration,resAdd,artsTakenAdd},
//            proc{prob,scale,damageType}, resIgnore, defIgnoreRamp{perHit,max,resetAfter}, hpRegenPerSec,
//            idleRegen{delay,ratioPerSec}, hpDrain{ratioPerSec,rampSeconds,tick}, deathDelay,
//            damageNegateProb, thorns{scale,damageType}, aura{mods,artsDodge?}, prefersAir
//   spec:    rangeId, charges, spRate, ammo, onDeploy, stages[{duration}], teamMods[], squad{initialDp,
//            redeployPct}, stacking{every,max,mods}, initSpRoll{min,max,used}, handChecked, effects
//   instant: damage.{hits,range}, heal.range (the skill's own rangeId, facing east), selfHeal{hpRatio}
'use strict';
const O = require('./operators.js');

// ---------- assumptions ----------
// ASSUMPTION: a TIME skill gains spData.increment SP per second (increment is 1 for every non-passive operator
// skill in skill_table; the per-second unit is the community-documented rule, the table has no unit).
const SP_PER_SECOND_PER_INCREMENT = 1;
// ASSUMPTION: SP is not gained while the skill is active, and charging restarts from what is left after
// spCost was consumed (0 for single-charge skills).
// ASSUMPTION: percentage buffs of talents and skill on one stat are SUMMED with each other (one 'pct' bucket,
// HANDOFF "same-type % buffs are summed") and multiply the stats the operator object carries. An operator
// from loadRoster already has collectible percentages inside those stats, so collectibles and skill buffs
// multiply each other here; spec.effects exposes the raw modifier lists for a caller that wants one bucket.
// ASSUMPTION: flat additions (生命上限+5000, 攻击速度+12, 法术抗性+15) are applied after the percentages
// (CONTRACT 3 order pct -> add); the blackboards do not say which bucket the game uses.
// ASSUMPTION: a negative base_attack_time under "攻击间隔…缩短" is ADDED seconds. Data argument: 艾雅法拉 S3 has
// -1.1 on a base attack time of 1.6, 白面鸮 S2 -2.1, 寒檀 S2 -2.4; as fractions they would give negative intervals.
const BAT_NEGATIVE_IS_SECONDS = true;
// ASSUMPTION: a value in (0,1) under "攻击间隔…缩短" MULTIPLIES the base attack time (深靛 S2 0.6, 安洁莉娜 S2
// 0.15: a positive addition could not shorten anything).
const BAT_FRACTION_IS_SCALE = true;
// ASSUMPTION: a positive value under "攻击间隔增大 / 延长" is ambiguous in the data (+v seconds or x(1+v)), so it
// is NOT understood by default (null -> the skill is 'unsupported'). Set to 'add' or 'scale' to opt in.
const BAT_LENGTHEN_MODE = null;
// ASSUMPTION: lord trait "可以进行远程攻击，但此时攻击力降低至80%": whether one attack is ranged depends on
// where the target stands, which a profile cannot know. true = every basic attack counts as ranged (atkScale
// 0.8, a lower bound); profile.atkScaleMelee carries the melee value for a simulator that can tell.
const LORD_BASIC_ATTACK_IS_RANGED = true;
// ASSUMPTION: talents that stack with time on the field (塞雷娅 莱茵充能护服) enter the profiles with this many
// stacks (0 = lower bound). profiles(op, spec, {stacks}) overrides it; spec.stacking has the schedule.
const TALENT_STACKS_DEFAULT = 0;
// ASSUMPTION: a random SP gift on deployment (艾雅法拉 乱火) counts with its minimum, the guaranteed part.
// 'mean' uses (min + max - 1) / 2 with max read as exclusive (blackboard sp_max is the text maximum + 1).
const DEPLOY_SP_ROLL = 'min';
// ASSUMPTION: a talent for "所有（友方）【X】干员" while on the field also applies to the operator herself when she is
// an X (桃金娘 先锋 regen, 星熊 重装 DEF, 艾雅法拉 术师 ATK). The text does not exclude her; false = team-only.
const AURA_INCLUDES_SELF = true;
// ASSUMPTION: "攻击距离+N" lengthens a single-row range by N tiles straight ahead. Ranges with several rows are
// not extended (the data does not say which rows grow): the skill is then 'unsupported'.
const EPS = 1e-6; // float slack: 150 ticks of 0.1 s must reach 15 SP

// ---------- small helpers ----------
const strip = s => String(s || '').replace(/<[^>]*>/g, '').replace(/\\n/g, '\n').trim();
// talent texts carry potential markers like "（+2%）" after the upgraded number
const stripTalent = s => strip(s).replace(/（[+\-][^（）]*）/g, '');
const toMap = list => { const m = {}; for (const b of list || []) m[b.key] = b.value; return m; };
const phaseNum = p => Number(String(p).replace('PHASE_', ''));
const condOk = (cond, op) => !cond || phaseNum(cond.phase) < op.elite || (phaseNum(cond.phase) === op.elite && (cond.level || 1) <= op.level);
// the candidate in force: unlocked at this elite/level, potential rank reached, highest (phase, level, rank)
function pick(cands, op) {
  let hit = null, key = null;
  for (const c of cands || []) {
    if (!condOk(c.unlockCondition, op) || (c.requiredPotentialRank || 0) > op.potential - 1) continue;
    const u = c.unlockCondition || {}, k = [phaseNum(u.phase || 0), u.level || 1, c.requiredPotentialRank || 0];
    if (!key || k[0] > key[0] || (k[0] === key[0] && (k[1] > key[1] || (k[1] === key[1] && k[2] >= key[2])))) { hit = c; key = k; }
  }
  return hit;
}
const near = (a, b) => Math.abs(a - b) < 1e-6;
const mod = (stat, op, value, source) => ({ stat, op, value, source });
const SP_TYPES = { INCREASE_WITH_TIME: 'TIME', INCREASE_WHEN_ATTACK: 'ATTACK', INCREASE_WHEN_TAKEN_DAMAGE: 'HIT', 8: 'NONE' };
const TRIGGERS = new Set(['MANUAL', 'AUTO', 'PASSIVE']);

function skillLevelData(op) {
  if (!op || !op.skillId) return null;
  const s = O.table('skill_table')[op.skillId];
  return s ? s.levels[op.skillLevel - 1] || null : null;
}

// Talents in force (module stage overrides included). Module candidates with talentIndex >= 0 replace that
// talent (their text is upgradeDescription); hidden ones (talentIndex -1) only carry numbers of the same text.
function talentsOf(op) {
  const list = [], hidden = [];
  ((op.raw && op.raw.talents) || []).forEach((t, index) => {
    const c = pick(t.candidates, op);
    if (c) list.push({ index, name: c.name, text: stripTalent(c.description), bb: toMap(c.blackboard), source: 'talent' });
  });
  const part = modulePhase(op);
  for (const p of (part && part.parts) || []) {
    if (p.isToken) continue;   // the summon's talents (夜莺 Y phantom: talentIndex 0 of the token, not her 白恶魔的庇护)
    const c = pick(p.addOrOverrideTalentDataBundle && p.addOrOverrideTalentDataBundle.candidates, op);
    if (!c) continue;
    if (c.talentIndex >= 0 && !c.isHideTalent) {
      const at = list.findIndex(t => t.index === c.talentIndex);
      const t = { index: c.talentIndex, name: c.name || (at >= 0 ? list[at].name : null), text: stripTalent(c.upgradeDescription || c.description), bb: toMap(c.blackboard), source: 'module' };
      if (at >= 0) list[at] = t; else list.push(t);
    } else hidden.push({ prefabKey: c.prefabKey, bb: toMap(c.blackboard) });
  }
  return { list, hidden, byIndex: i => list.find(t => t.index === i) };
}
function modulePhase(op) {
  if (!op.module || !op.module.id) return null;
  const be = O.table('battle_equip_table', true), e = be && be[op.module.id];
  return e ? e.phases.find(p => p.equipLevel === op.module.stage) || null : null;
}
// Trait in force: sentence chosen by operators.js (op.traitText), its blackboard, and what a module adds.
function traitOf(op) {
  const c = pick(op.raw && op.raw.trait && op.raw.trait.candidates, op);
  const out = { text: strip(op.traitText || (op.raw && op.raw.description)), bb: toMap(c && c.blackboard), extra: [] };
  const part = modulePhase(op);
  for (const p of (part && part.parts) || []) {
    if (p.isToken) continue;   // the summon's trait (迷迭香 isw-a), not hers
    const m = pick(p.overrideTraitDataBundle && p.overrideTraitDataBundle.candidates, op);
    if (!m) continue;
    if (m.overrideDescripton) { out.text = strip(m.overrideDescripton); out.bb = toMap(m.blackboard); out.moduleOverride = true; }
    if (m.additionalDescription) out.extra.push({ text: strip(m.additionalDescription), bb: toMap(m.blackboard) });
  }
  return out;
}

// ---------- builder: what a handler may say ----------
function builder(op, lv) {
  const sbb = toMap(lv && lv.blackboard), used = new Set();
  const x = {
    op, lv, notes: [], degraded: false, failed: false,
    base: { mods: [], patch: {} }, active: { mods: [], patch: {} },   // modifiers (CONTRACT 3) + field overrides
    stages: null, instant: null, dpOverDuration: 0, duration: undefined, ammo: 0, onDeploy: false,
    teamMods: [], squad: {}, stacking: null, initSpAdd: 0, initSpRoll: null,
    traitSeen: false, extraSeen: new Set(),   // trait sentence / module trait additions a handler took (see traitRest)
  };
  x.omit = msg => { x.degraded = true; x.notes.push(msg); };          // clause left out -> at best 'approx'
  x.fail = msg => { x.failed = true; x.notes.push(msg); };            // not understood -> 'unsupported'
  x.both = m => { x.base.mods.push(m); x.active.mods.push(m); };      // talents and passives: both profiles
  x.set = (k, v) => { x.base.patch[k] = v; x.active.patch[k] = v; };
  x.has = k => k in sbb;
  x.use = k => { if (!(k in sbb)) throw new Error('blackboard key missing: ' + k); used.add(k); return sbb[k]; };
  x.skip = k => { if (k in sbb) used.add(k); };
  x.unused = () => Object.keys(sbb).filter(k => !used.has(k));
  x.sbb = sbb;
  return x;
}

// ---------- traits ----------
// Rules that change a profile. Everything else in a trait reaches the profiles only through the basic-attack
// classification of operators.js (damage type, targets, hits, canHitAir, block).
function traitBearer(x, tr) {           // flag-bearer vanguards
  if (tr.text !== '技能发动期间阻挡数变为0') return false;
  x.active.patch.block = 0;
  return true;
}
function traitLord(x, tr) {             // lord guards
  const m = /^可以进行远程攻击，但此时攻击力降低至(\d+)%$/.exec(tr.text);
  if (!m || !('atk_scale' in tr.bb) || !near(tr.bb.atk_scale * 100, Number(m[1]))) return false;
  x.set('atkScale', LORD_BASIC_ATTACK_IS_RANGED ? tr.bb.atk_scale : 1);
  x.set('atkScaleMelee', 1);
  x.omit(`trait: ranged attacks deal ${m[1]}% ATK; outside the skill every basic attack is counted as ${LORD_BASIC_ATTACK_IS_RANGED ? 'ranged (atkScale ' + tr.bb.atk_scale + ', lower bound)' : 'melee (atkScale 1, upper bound)'}; profile.atkScaleMelee = 1 is the melee value`);
  return true;
}
function traitPrefersAir(x, tr) {       // fast-shot snipers
  if (tr.text !== '优先攻击空中单位') return false;
  x.set('prefersAir', true);
  x.omit('trait: target priority "优先攻击空中单位" is only exposed as profile.prefersAir');
  return true;
}
// sentences fully captured by the operators.js classification (no note needed); a module override sentence counts
// too, operators.js classifies from it (夜莺 Y "同时恢复四个…" -> targets 4, 星熊 Y "能够阻挡四个敌人" = block_cnt +1)
const TRAIT_COVERED = [/^攻击造成法术伤害$/, /^能够阻挡[一二两三四]个敌人$/, /^同时恢复[两二三四五]个友方单位的生命$/, /^恢复友方单位生命$/, /^技能可以治疗友方单位$/];
// a hand-checked handler that reads the trait sentence itself
function handTrait(x, tr, rule) {
  x.traitSeen = true;
  if (!rule(x, tr)) x.omit(`trait: "${tr.text}" not recognised`);
}
function traitSentence(x, tr) {
  if (!tr.text) return;
  if (!(traitBearer(x, tr) || traitLord(x, tr) || traitPrefersAir(x, tr) || TRAIT_COVERED.some(r => r.test(tr.text))))
    x.omit(`trait: "${tr.text}" is reflected only through the basic-attack classification of operators.js`);
}
// Module trait additions with a profile field (number from the addition's own blackboard); the rest are notes.
const MODULE_EXTRA = [
  // 艾雅法拉 X (ccr-x): the same key and meaning as 史尔特尔's talent 熔火 "无视攻击目标N法术抗性"
  [/^无视目标\{magic_resist_penetrate_fixed\}点法术抗性$/, (x, e) => {
    if (x.base.patch.resIgnore !== undefined || !('magic_resist_penetrate_fixed' in e.bb)) return false;
    x.set('resIgnore', e.bb.magic_resist_penetrate_fixed);
    x.omit(`module trait: ignores ${e.bb.magic_resist_penetrate_fixed} RES of the target: only in profile.resIgnore`);
    return true;
  }],
  // the new range is op.range already (operators.js MODULE_RANGE_TEXT)
  [/^攻击范围扩大$/, x => !!(x.op.module && x.op.module.rangeId && x.op.rangeId === x.op.module.rangeId)],
];
// What no handler took: the trait sentence (handlers that do not read it rely on the classification) and every
// module trait addition. Runs after every talent / trait handler, so a module never changes a profile silently.
function traitRest(x, tr) {
  if (!x.traitSeen) traitSentence(x, tr);
  for (const e of tr.extra) {
    if (x.extraSeen.has(e)) continue;
    const rule = MODULE_EXTRA.find(([re]) => re.test(e.text));
    if (!(rule && rule[1](x, e))) x.omit(`module trait: "${fill(e.text, e.bb)}" not modelled`);
  }
}
// "{key:0%}" placeholders -> numbers, for notes and describeSkill
function fill(text, bb) {
  return String(text).replace(/\{(-?)([^}:]+)(?::([^}]*))?\}/g, (all, neg, key, fmt) => {
    const k = Object.keys(bb).find(b => b.toLowerCase() === key.toLowerCase());
    if (k === undefined) return all;
    const v = bb[k] * (neg ? -1 : 1);
    return fmt && fmt.includes('%') ? +(v * 100).toFixed(2) + '%' : String(+v.toFixed(3));
  });
}

// ---------- talents: generic ----------
// A sentence is folded into both profiles only when EVERY comma clause of it is an unconditional self stat
// bonus whose number equals a blackboard value. Anything else (conditions, team-wide, on-hit) is a note.
const TALENT_RULES = [
  [/^攻击力\+(\d+(?:\.\d+)?)%$/, 'atk', 'pct', 'atk', 100],
  [/^防御力\+(\d+(?:\.\d+)?)%$/, 'def', 'pct', 'def', 100],
  [/^(?:生命上限|最大生命值)\+(\d+(?:\.\d+)?)%$/, 'hp', 'pct', 'max_hp', 100],
  [/^攻击速度\+(\d+)$/, 'attackSpeed', 'add', 'attack_speed', 1],
  [/^法术抗性\+(\d+)$/, 'res', 'add', 'magic_resistance', 1],
];
function talentsGeneric(x, T) {
  for (const t of T.list) {
    for (const sentence of t.text.split(/[。；\n]/).map(s => s.trim()).filter(Boolean)) {
      const mods = [];
      const ok = sentence.split('，').every(clause => {
        for (const [re, stat, op, key, scale] of TALENT_RULES) {
          const m = re.exec(clause.trim());
          if (m && key in t.bb && near(t.bb[key] * scale, Number(m[1]))) { mods.push(mod(stat, op, t.bb[key], `talent ${t.name}`)); return true; }
        }
        return false;
      });
      if (ok) mods.forEach(x.both); else x.omit(`talent ${t.name}: "${sentence}" not modelled`);
    }
  }
}

// ---------- talents and traits: hand-checked roster operators (CONTRACT 9) ----------
// Each talent text is matched against the sentence the handler was checked on; numbers come from the blackboard
// (the text number is compared with it). A text that does not match is left out with a note.
function talentMatch(x, t, re) {
  if (!t) return null;
  const m = re.exec(t.text);
  if (!m) x.omit(`talent ${t.name}: text not recognised, not modelled: "${t.text}"`);
  return m;
}
function need(x, t, key, textNum, scale) {
  if (!(key in t.bb)) throw new Error(`talent ${t.name}: blackboard key missing: ${key}`);
  if (textNum !== undefined && !near(t.bb[key] * (scale || 1), Number(textNum))) x.omit(`talent ${t.name}: text says ${textNum}, blackboard ${key} = ${t.bb[key]} (blackboard used)`);
  return t.bb[key];
}
const CHAR = {
  // 桃金娘: trait 技能发动期间阻挡数变为0; talent 在场时，所有【先锋】干员每秒回复N点生命
  char_151_myrtle(x, T, tr) {
    handTrait(x, tr, traitBearer);
    const t = T.byIndex(0), m = talentMatch(x, t, /^在场时，所有【先锋】干员每秒回复(\d+)点生命$/);
    if (m) {
      const v = need(x, t, 'hp_recovery_per_sec', m[1]);
      if (AURA_INCLUDES_SELF && x.op.profession === 'PIONEER') x.set('hpRegenPerSec', v);   // she is a 先锋 herself
      x.teamMods.push({ stat: 'hpRegenPerSec', op: 'add', value: v, when: { profession: 'PIONEER' }, source: `talent ${t.name}` });
      x.omit(`talent ${t.name}: +${v} HP/s for every 先锋 on the field: own part in profile.hpRegenPerSec, the others in spec.teamMods (both outside the contract profile)`);
    }
  },
  // 德克萨斯: trait 能够阻挡两个敌人 (block stat); talent 编入队伍后，额外获得N点初始部署费用
  char_102_texas(x, T) {
    const t = T.byIndex(0), m = talentMatch(x, t, /^编入队伍后，额外获得(\d+)点初始部署费用$/);
    if (m) { x.squad.initialDp = need(x, t, 'cost', m[1]); x.omit(`talent ${t.name}: +${x.squad.initialDp} initial DP while she is in the squad: only in spec.squad.initialDp`); }
  },
  // 塞雷娅: trait 技能可以治疗友方单位 (says what the skills do); talents 莱茵充能护服 (stacks with time), 精神回复
  char_202_demkni(x, T) {
    let t = T.byIndex(0), m = talentMatch(x, t, /^每在场上停留(\d+)秒，攻击力\+(\d+)%，防御力\+(\d+)%，最多叠加(\d+)层$/);
    if (m) {
      x.stacking = { every: need(x, t, 'interval', m[1]), max: need(x, t, 'max_stack_cnt', m[4]),
        mods: [mod('atk', 'pct', need(x, t, 'atk', m[2], 100), `talent ${t.name}`), mod('def', 'pct', need(x, t, 'def', m[3], 100), `talent ${t.name}`)] };
      x.omit(`talent ${t.name}: ATK +${m[2]}% / DEF +${m[3]}% per ${m[1]} s on the field, up to ${m[4]} stacks: profiles use ${TALENT_STACKS_DEFAULT} stacks (profiles(op, spec, {stacks}) and spec.stacking for more)`);
    }
    t = T.byIndex(1); m = talentMatch(x, t, /^每次回复友方单位生命值时额外回复该单位(\d+)点技力$/);
    if (m) x.omit(`talent ${t.name}: +${need(x, t, 'sp', m[1])} SP to every unit she heals not modelled`);
  },
  // 星熊: trait 能够阻挡三个敌人 (block stat); talents 战术装甲 (伤害抵挡), 特种作战策略 (重装 DEF aura)
  char_136_hsguma(x, T) {
    let t = T.byIndex(0), m = talentMatch(x, t, /^获得(\d+)%的伤害抵挡$/);
    if (m) { const p = need(x, t, 'prob', m[1], 100); x.set('damageNegateProb', p); x.omit(`talent ${t.name}: ${m[1]}% chance to block incoming damage: only in profile.damageNegateProb`); }
    t = T.byIndex(1); m = talentMatch(x, t, /^在场时所有友方【重装】职业干员的防御力提升(\d+)%$/);
    if (m) {
      const v = need(x, t, 'def', m[1], 100);
      if (AURA_INCLUDES_SELF && x.op.profession === 'TANK') x.both(mod('def', 'pct', v, `talent ${t.name}`));   // she is 重装 herself
      x.teamMods.push({ stat: 'def', op: 'pct', value: v, when: { profession: 'TANK' }, source: `talent ${t.name}` });
      x.omit(`talent ${t.name}: DEF +${m[1]}% is folded in for herself; for the other 重装 it is only in spec.teamMods`);
    }
  },
  // 银灰: lord trait; talents 领袖 (ATK%, squad redeploy; module X adds elite/boss scale and an area redeploy cut), 鹰眼视觉
  char_172_svrash(x, T, tr) {
    handTrait(x, tr, traitLord);
    for (const e of tr.extra) {   // other additions: traitRest notes them
      if (!/^攻击附带\{atk_scale_m:0%\}攻击力的法术伤害$/.test(e.text) || !('atk_scale_m' in e.bb)) continue;
      x.set('bonusHit', { scale: e.bb.atk_scale_m, damageType: 'arts' }); x.extraSeen.add(e);
      x.omit(`module trait: every attack adds ${fill('{atk_scale_m:0%}', e.bb)} ATK as arts damage: only in profile.bonusHit`);
    }
    let t = T.byIndex(0);
    let m = talentMatch(x, t, /^攻击力\+(\d+)%(且攻击精英与领袖敌人时攻击力提升至(\d+)%)?，编入队伍时所有我方单位的再部署时间-(\d+)%(，银灰及周围8格的其他友军再部署时间额外-(\d+)%)?$/);
    if (m) {
      x.both(mod('atk', 'pct', need(x, t, 'atk', m[1], 100), `talent ${t.name}`));
      x.squad.redeployPct = need(x, t, 'respawn_time', -m[4], 100);
      x.omit(`talent ${t.name}: redeploy time -${m[4]}% for the whole squad: only in spec.squad.redeployPct`);
      if (m[2]) {
        const h = T.hidden.find(h => 'atk_scale' in h.bb && near(h.bb.atk_scale * 100, Number(m[3])));
        if (h) { x.set('atkScaleByType', { ELITE: h.bb.atk_scale, BOSS: h.bb.atk_scale }); x.omit(`talent ${t.name} (module): ATK x${h.bb.atk_scale} against elite and leader enemies: only in profile.atkScaleByType`); }
        else x.omit(`talent ${t.name} (module): "${m[2]}" has no matching blackboard value, not modelled`);
      }
      if (m[5]) x.omit(`talent ${t.name} (module): redeploy time -${m[6]}% more for himself and the 8 tiles around not modelled`);
    }
    t = T.byIndex(1); m = talentMatch(x, t, /^攻击范围内敌人的隐匿效果失效$/);
    if (m) x.omit(`talent ${t.name}: cancels 隐匿 of enemies in range not modelled`);
  },
  // 史尔特尔: trait 攻击造成法术伤害; talents 熔火 (ignores RES), 余烬 (stays at 1 HP, then leaves)
  char_350_surtr(x, T) {
    let t = T.byIndex(0), m = talentMatch(x, t, /^无视攻击目标(\d+)法术抗性$/);
    if (m) { x.set('resIgnore', need(x, t, 'magic_resist_penetrate_fixed', m[1])); x.omit(`talent ${t.name}: ignores ${m[1]} RES of the target: only in profile.resIgnore`); }
    t = T.byIndex(1); m = talentMatch(x, t, /^受到致命伤害时持续使生命值不低于1，(\d+)秒后强制退出战场$/);
    if (m) { x.set('deathDelay', need(x, t, 'surtr_t_2[withdraw].interval', m[1])); x.omit(`talent ${t.name}: lethal damage leaves her at 1 HP for ${m[1]} s before she leaves: only in profile.deathDelay`); }
  },
  // 能天使: trait 优先攻击空中单位; talents 快速弹匣 (attack speed; module Y adds a DEF-ignore ramp), 天使的祝福
  char_103_angel(x, T, tr) {
    handTrait(x, tr, traitPrefersAir);   // module additions (X: vs air, Y: ground enemies in range): traitRest notes them
    let t = T.byIndex(0);
    let m = talentMatch(x, t, /^攻击速度\+(\d+)(；连续造成伤害时逐渐无视敌人防御力，最高无视(\d+)点防御力（每次造成伤害提升(\d+)点），(\d+)秒内未攻击则失去加成)?$/);
    if (m) {
      x.both(mod('attackSpeed', 'add', need(x, t, 'attack_speed', m[1]), `talent ${t.name}`));
      if (m[2]) {
        const per = need(x, t, 'def_penetrate_fixed', m[4]), max = per * need(x, t, 'max_stack_cnt'), reset = need(x, t, 'duration', m[5]);
        if (!near(max, Number(m[3]))) x.omit(`talent ${t.name}: text says ${m[3]} DEF, blackboard ${max}`);
        x.set('defIgnoreRamp', { perHit: per, max, resetAfter: reset });
        x.omit(`talent ${t.name} (module): ignores ${per} more DEF per damaging hit up to ${max}, lost after ${reset} s without attacking: only in profile.defIgnoreRamp`);
      }
    }
    t = T.byIndex(1); m = talentMatch(x, t, /^攻击力\+(\d+)%，生命上限\+(\d+)%。置入战场后这个效果会同样赋予给一名随机友方单位$/);
    if (m) {
      x.both(mod('atk', 'pct', need(x, t, 'atk', m[1], 100), `talent ${t.name}`));
      x.both(mod('hp', 'pct', need(x, t, 'max_hp', m[2], 100), `talent ${t.name}`));
      x.omit(`talent ${t.name}: the same ATK +${m[1]}% / HP +${m[2]}% on one random ally not modelled`);
    }
  },
  // 蓝毒: trait 优先攻击空中单位; talent 神经毒素 (poison)
  char_129_bluep(x, T, tr) {
    handTrait(x, tr, traitPrefersAir);
    const t = T.byIndex(0), m = talentMatch(x, t, /^攻击使目标中毒，在(\d+)秒内每秒受到(\d+)点法术伤害$/);
    if (m) {
      const dot = { dps: need(x, t, 'poison_damage', m[2]), duration: need(x, t, 'duration'), damageType: 'arts' };
      x.set('dot', dot);
      x.omit(`talent ${t.name}: poison ${dot.dps} arts damage per second for ${m[1]} s (blackboard ${dot.duration} s) on every target hit: only in profile.dot`);
    }
  },
  // 艾雅法拉: trait 攻击造成法术伤害; talents 炎息 (术师 ATK aura), 乱火 (random SP on deployment)
  char_180_amgoat(x, T) {
    let t = T.byIndex(0), m = talentMatch(x, t, /^在场时，所有友方【术师】职业干员的攻击力\+(\d+)%$/);
    if (m) {
      const v = need(x, t, 'atk', m[1], 100);
      if (AURA_INCLUDES_SELF && x.op.profession === 'CASTER') x.both(mod('atk', 'pct', v, `talent ${t.name}`));   // she is 术师 herself
      x.teamMods.push({ stat: 'atk', op: 'pct', value: v, when: { profession: 'CASTER' }, source: `talent ${t.name}` });
      x.omit(`talent ${t.name}: ATK +${m[1]}% is folded in for herself; for the other 术师 it is only in spec.teamMods`);
    }
    t = T.byIndex(1); m = talentMatch(x, t, /^部署后立即随机获得(\d+)~(\d+)点技力$/);
    if (m) {
      const min = need(x, t, 'sp_min', m[1]), max = need(x, t, 'sp_max');
      x.initSpAdd = DEPLOY_SP_ROLL === 'mean' ? (min + max - 1) / 2 : min;
      x.initSpRoll = { min, max, used: x.initSpAdd };
      x.omit(`talent ${t.name}: random ${m[1]}~${m[2]} SP on deployment (blackboard ${min}..${max}); initSp includes ${x.initSpAdd} (${DEPLOY_SP_ROLL})`);
    }
  },
  // 逻各斯: trait 攻击造成法术伤害; talents 语汇演化 (chance of an extra hit), 剜魂具辞 (debuff on hit)
  char_4133_logos(x, T) {
    let t = T.byIndex(0), m = talentMatch(x, t, /^对一个目标发起攻击时，有(\d+)%几率额外对攻击范围内一个随机目标造成相当于攻击力(\d+)%的法术伤害(并使其停顿([\d.]+)秒)?$/);
    if (m) {
      x.set('proc', { prob: need(x, t, 'prob', m[1], 100), scale: need(x, t, 'atk_scale', m[2], 100), damageType: 'arts' });
      x.omit(`talent ${t.name}: ${m[1]}% chance per attacked target of an extra ${m[2]}% ATK arts hit on a random enemy in range${m[3] ? ` with ${need(x, t, 'sluggish', m[4])} s 停顿` : ''}: only in profile.proc (停顿 not at all)`);
    }
    t = T.byIndex(1); m = talentMatch(x, t, /^攻击使目标在(\d+)秒内法术抗性-(\d+)且受到的法术伤害提高(\d+)点$/);
    if (m) {
      x.set('onHitDebuff', { duration: need(x, t, 'duration', m[1]), resAdd: need(x, t, 'magic_resistance', -m[2]), artsTakenAdd: need(x, t, 'atk_addition', m[3]) });
      x.omit(`talent ${t.name}: targets hit get RES -${m[2]} and take +${m[3]} arts damage per hit for ${m[1]} s: only in profile.onHitDebuff`);
    }
  },
  // 夜莺: trait 同时恢复三个友方单位的生命 (targets 3); talents 白恶魔的庇护 (RES aura), 转瞬即逝的幻影 (summons)
  char_179_cgbird(x, T) {
    let t = T.byIndex(0), m = talentMatch(x, t, /^攻击范围内的友方单位法术抗性\+(\d+)$/);
    if (m) {
      const a = mod('res', 'add', need(x, t, 'magic_resistance', m[1]), `talent ${t.name}`);
      x.base.patch.aura = { mods: [a] }; x.active.patch.aura = { mods: [a] };
      x.omit(`talent ${t.name}: RES +${m[1]} for allies inside her range: only in profile.aura`);
    }
    t = T.byIndex(1); m = talentMatch(x, t, /^可以使用幻影。/);
    if (m) x.omit(`talent ${t.name}: the phantom summons (${t.bb.cnt}) are not modelled`);
  },
  // 棘刺: lord trait; talents 神经腐蚀 (poison, doubled on ranged enemies), 故土潮声 (regeneration when idle)
  char_293_thorns(x, T, tr) {
    handTrait(x, tr, traitLord);
    let t = T.byIndex(0), m = talentMatch(x, t, /^攻击使目标中毒，在(\d+)秒内每秒受到(\d+)点法术伤害（对会远程攻击的目标伤害加倍）$/);
    if (m) {
      const dot = { dps: need(x, t, 'damage[normal]', m[2]), dpsVsRanged: need(x, t, 'damage[ranged]', 2 * m[2]), duration: need(x, t, 'duration', m[1]), damageType: 'arts' };
      x.set('dot', dot);
      x.omit(`talent ${t.name}: poison ${dot.dps} arts damage per second for ${dot.duration} s (${dot.dpsVsRanged} on enemies that attack at range): only in profile.dot`);
    }
    t = T.byIndex(1); m = talentMatch(x, t, /^如果(\d+)秒内没有主动攻击过，每秒恢复最大生命([\d.]+)%的生命$/);
    if (m) {
      x.set('idleRegen', { delay: need(x, t, 'delay', m[1]), ratioPerSec: need(x, t, 'hp_recovery_per_sec_by_max_hp_ratio', m[2], 100) });
      x.omit(`talent ${t.name}: regenerates ${m[2]}% max HP per second after ${m[1]} s without attacking: only in profile.idleRegen`);
    }
  },
};

// ---------- skills: hand-checked (CONTRACT 9) ----------
// [template of the stripped description (all levels), handler]. The handler runs only when the template matches.
const src = x => `skill ${x.lv.name}`;
const skillRange = x => { if (!x.lv.rangeId) throw new Error('skill has no rangeId'); return O.rangeOf(x.lv.rangeId); };
// one row only (see the ASSUMPTION above); null when the range has several rows
function extendForward(range, n) {
  if (range.some(o => o.dr !== 0)) return null;
  const max = Math.max(...range.map(o => o.dc)), out = range.map(o => ({ dr: o.dr, dc: o.dc }));
  for (let k = 1; k <= n; k++) out.push({ dr: 0, dc: max + k });
  return Object.freeze(out.map(o => Object.freeze(o)));
}
function batShorten(x, v) {              // "攻击间隔…缩短"
  if (v === 0) return true;
  if (v < 0 && BAT_NEGATIVE_IS_SECONDS) { x.active.mods.push(mod('baseAttackTime', 'add', v, src(x))); return true; }
  if (v > 0 && v < 1 && BAT_FRACTION_IS_SCALE) { x.active.mods.push(mod('baseAttackTime', 'mul', v, src(x))); return true; }
  return false;
}
const SKILL = [
  // 支援号令 (桃金娘 S1 and the other flag-bearers): 停止攻击，持续时间内回复总共{value}点部署费用
  [/^skcom_assist_cost\[\d\]$/, /^停止攻击，持续时间内回复总共\{value\}点部署费用$/, x => {
    x.active.patch.attacks = false;
    x.dpOverDuration = x.use('value');
    // interval / cost = how the game pays it out (cost DP every interval s); the total is {value}
    const n = Math.round(x.lv.duration / x.use('interval')) * x.use('cost');
    if (!near(n, x.dpOverDuration)) x.omit(`skill: duration / interval x cost = ${n} DP does not equal the stated total ${x.dpOverDuration} (total used)`);
  }],
  // 德克萨斯 S2 剑雨: 立即获得{cost}点费用；对周围所有敌人造成两次相当于攻击力{atk_scale:0%}的法术伤害，并令击中目标晕眩{stun}秒
  [/^skchr_texas_2$/, /^立即获得\{cost\}点费用；对周围所有敌人造成两次相当于攻击力\{atk_scale:0%\}的法术伤害，并令击中目标晕眩\{stun\}秒$/, x => {
    // "两次" is in the text, not in the blackboard: hits 2. "周围" = the skill's own rangeId.
    x.instant = { dp: x.use('cost'), damage: { scale: x.use('atk_scale'), hits: 2, damageType: 'arts', targets: O.TARGETS_ALL, range: skillRange(x) } };
    x.duration = 0;
    x.omit(`skill: stun ${x.use('stun')} s on the enemies hit not modelled`);
    x.omit('skill: instant.damage carries hits: 2 and its own range (extensions of the contract shape {scale, damageType, targets})');
  }],
  // 塞雷娅 S2 药物配置: 治疗附近一定范围内的所有友军相当于塞雷娅攻击力{heal_scale:0%}的生命
  [/^skchr_demkni_2$/, /^治疗附近一定范围内的所有友军相当于塞雷娅攻击力\{heal_scale:0%\}的生命$/, x => {
    x.instant = { heal: { scale: x.use('heal_scale'), targets: O.TARGETS_ALL, range: skillRange(x) } };
    x.duration = 0;
  }],
  // 星熊 S2 荆棘 (passive): 防御力+{def:0%}\n每次受到攻击时对目标造成相当于星熊攻击力{atk_scale:0%}的物理伤害
  [/^skchr_hsguma_2$/, /^防御力\+\{def:0%\}\n每次受到攻击时对目标造成相当于星熊攻击力\{atk_scale:0%\}的物理伤害$/, x => {
    x.both(mod('def', 'pct', x.use('def'), src(x)));
    x.set('thorns', { scale: x.use('atk_scale'), damageType: 'physical' });
    x.duration = 0;
    x.omit(`skill: ${fill('{atk_scale:0%}', x.sbb)} ATK physical damage to every attacker: only in profile.thorns`);
  }],
  // 银灰 S3 真银斩: 防御力-{-def:0%}，攻击力+{atk:0%}，攻击范围扩大，同时攻击至多{attack@max_target}个目标（视为近距离攻击）
  [/^skchr_svrash_3$/, /^防御力-\{-def:0%\}，攻击力\+\{atk:0%\}，攻击范围扩大，同时攻击至多\{attack@max_target\}个目标（视为近距离攻击）$/, x => {
    x.active.mods.push(mod('def', 'pct', x.use('def'), src(x)), mod('atk', 'pct', x.use('atk'), src(x)));
    Object.assign(x.active.patch, { range: skillRange(x), targets: x.use('attack@max_target'), atkScale: 1 }); // 视为近距离攻击: no 80%
  }],
  // 史尔特尔 S3 黄昏
  [/^skchr_surtr_3$/, /^立即恢复所有生命；攻击力\+\{atk:0%\}，攻击距离\+\{ability_range_forward_extend\}，攻击目标数\+(\d+)，生命上限\+\{max_hp\}，逐渐流失生命（\{duration\}秒后到达最大生命\{hp_ratio:0%\}\/秒）；持续时间无限$/, (x, m) => {
    // 立即恢复所有生命 (of the raised maximum). Not under instant.heal: that key means "heal allies by scale x ATK".
    x.instant = { selfHeal: { hpRatio: 1 } };
    x.active.mods.push(mod('atk', 'pct', x.use('atk'), src(x)), mod('hp', 'add', x.use('max_hp'), src(x)));
    const range = extendForward(x.op.range, x.use('ability_range_forward_extend')), targets = x.use('attack@max_target');
    if (!range) throw new Error('range has several rows, forward extension not defined');
    if (targets !== x.op.targets + Number(m[1])) x.omit(`skill: text says targets +${m[1]}, blackboard attack@max_target = ${targets} (blackboard used)`);
    const drain = { ratioPerSec: x.use('hp_ratio'), rampSeconds: x.use('duration'), tick: x.use('interval') };
    Object.assign(x.active.patch, { range, targets, hpDrain: drain });
    x.duration = -1;
    x.omit(`skill: HP drain rising to ${drain.ratioPerSec * 100}% max HP per second after ${drain.rampSeconds} s: only in profile.hpDrain (the shape of the rise is not in the data)`);
    x.omit('skill: the full heal on activation is instant.selfHeal {hpRatio: 1} (extension of the contract shape)');
  }],
  // 能天使 S3 过载模式 (the interval and ATK clauses appear from level 4 and 8)
  [/^skchr_angel_3$/, /^攻击变为\{attack@times\}连射(，攻击间隔(?:略微|少量|一定程度)缩短)?(，攻击力提升至\{attack@atk_scale:0%\})?\n技能会自动开启$/, (x, m) => {
    Object.assign(x.active.patch, { hits: x.use('attack@times'), atkScale: x.use('attack@atk_scale') });
    const v = x.use('base_attack_time');
    if (!!m[1] !== (v !== 0) || !batShorten(x, v)) throw new Error('base_attack_time ' + v + ' does not fit the interval clause');
    if (!m[2] && x.sbb['attack@atk_scale'] !== 1) throw new Error('attack@atk_scale without its clause');
  }],
  // 蓝毒 S2 毒液散射 ("对主目标额外射击一次" appears from level 8, with attack@times = 2)
  [/^skchr_bluep_2$/, /^攻击力\+\{atk:0%\}，每次攻击(对主目标额外射击一次，并)?额外攻击(\d+)个目标$/, (x, m) => {
    x.active.mods.push(mod('atk', 'pct', x.use('atk'), src(x)));
    const times = x.use('attack@times'), targets = x.op.targets + Number(m[2]);  // "额外攻击2个目标": the 2 is text only
    if ((times === 2) !== !!m[1] || times < 1 || times > 2) throw new Error('attack@times ' + times + ' does not fit the text');
    x.active.patch.targets = targets;
    if (times > 1) {
      x.active.patch.hitsByTarget = [times].concat(new Array(targets - 1).fill(1));
      x.omit(`skill: the main target is shot ${times} times per attack, the ${m[2]} extra targets once: profile.hits stays 1 (lower bound), the split is in profile.hitsByTarget`);
    }
  }],
  // 艾雅法拉 S3 火山
  [/^skchr_amgoat_3$/, /^攻击力\+\{atk:0%\}，攻击范围增大，攻击间隔大幅度缩短，攻击变为随机对攻击范围内至多\{attack@max_target\}个敌人发射熔岩$/, x => {
    x.active.mods.push(mod('atk', 'pct', x.use('atk'), src(x)));
    if (!batShorten(x, x.use('base_attack_time'))) throw new Error('base_attack_time not a shortening');
    Object.assign(x.active.patch, { range: skillRange(x), targets: x.use('attack@max_target') });
    x.omit('skill: the targets are chosen at random among the enemies in range; the simulator picks by its own priority');
  }],
  // 逻各斯 S3 延异视阈
  [/^skchr_logos_3$/, /^攻击范围扩大，攻击力\+\{atk:0%\}，同时攻击\{attack@max_target\}个目标，使攻击范围内敌方子弹的飞行速度大幅降低、并在技能结束时将其全部清除$/, x => {
    x.active.mods.push(mod('atk', 'pct', x.use('atk'), src(x)));
    Object.assign(x.active.patch, { range: skillRange(x), targets: x.use('attack@max_target') });
    x.omit(`skill: enemy projectiles in range slowed to ${fill('{projectile_move_scale:0%}', x.sbb)} speed and removed when the skill ends not modelled`);
    x.skip('projectile_move_scale');
  }],
  // 夜莺 S3 圣域
  [/^skchr_cgbird_3$/, /^攻击范围扩大，攻击力\+\{atk:0%\}，攻击范围内的友方单位法术抗性\+\{magic_resistance:0%\}并获得\{prob:0%\}的法术闪避$/, x => {
    x.active.mods.push(mod('atk', 'pct', x.use('atk'), src(x)));
    const talentAura = (x.active.patch.aura && x.active.patch.aura.mods) || [];
    x.active.patch.range = skillRange(x);
    x.active.patch.aura = { mods: talentAura.concat([mod('res', 'pct', x.use('magic_resistance'), src(x))]), artsDodge: x.use('prob') };
    x.omit(`skill: allies inside the range get RES ${fill('+{magic_resistance:0%}', x.sbb)} and ${fill('{prob:0%}', x.sbb)} arts dodge: only in profile.aura`);
  }],
  // 棘刺 S3 至高之术: second and later uses doubled and permanent
  [/^skchr_thorns_3$/, /^攻击范围扩大，攻击力\+\{atk:0%\}，攻击速度\+\{attack_speed\}，远程攻击不再降低攻击力\n第二次及以后使用时能力加成变为最初的两倍，且持续时间无限$/, x => {
    Object.assign(x.active.patch, { range: skillRange(x), atkScale: 1 });   // 远程攻击不再降低攻击力
    const stage = (atk, aspd, duration) => ({ duration, mods: [mod('atk', 'pct', atk, src(x)), mod('attackSpeed', 'add', aspd, src(x))], patch: {} });
    x.stages = [stage(x.use('atk'), x.use('attack_speed'), x.lv.duration),
      stage(x.use('thorns_s_3[b].atk'), x.use('thorns_s_3[b].attack_speed'), x.use('thorns_s_3[b].duration'))];
    x.omit('skill: second and later uses (doubled bonus, permanent): the automaton handles the duration, the doubled bonus is profiles.stages[1] (skills.currentProfile); profiles.active is the first use');
  }],
];

// ---------- skills: generic ----------
// Whole-clause grammar: a skill compiles only when EVERY clause of its description matches one rule and every
// blackboard key was consumed by a rule; otherwise it is 'unsupported' and says which clause or key.
// A skill hit scale replaces profile.atkScale. On a lord (trait ranged x0.8) whether the two multiply is not in the
// data: the skill value is used alone (exact for melee hits, an upper bound for ranged ones) and noted.
function skillScale(x, v) {
  x.active.patch.atkScale = v;
  if (x.active.patch.atkScaleMelee !== undefined) x.omit(`skill: hit scale ${v} replaces the trait ranged-attack scale ${x.base.patch.atkScale}; whether they multiply is not in the data`);
}
const G = [
  [/^(?:自身)?攻击力\+\{atk:0%\}$/, x => x.active.mods.push(mod('atk', 'pct', x.use('atk'), src(x)))],
  [/^(?:自身)?攻击速度\+\{attack_speed\}$/, x => x.active.mods.push(mod('attackSpeed', 'add', x.use('attack_speed'), src(x)))],
  [/^(?:自身)?防御力\+\{def:0%\}$/, x => x.active.mods.push(mod('def', 'pct', x.use('def'), src(x)))],
  [/^(?:自身)?防御力-\{-def:0%\}$/, x => { const v = x.use('def'); if (v > 0) throw new Error('def expected negative'); x.active.mods.push(mod('def', 'pct', v, src(x))); }],
  [/^(?:生命上限|最大生命值)\+\{max_hp:0%\}$/, x => x.active.mods.push(mod('hp', 'pct', x.use('max_hp'), src(x)))],
  [/^攻击力和防御力\+\{atk:0%\}$/, x => { const v = x.use('atk'); if (x.use('def') !== v) throw new Error('atk and def differ'); x.active.mods.push(mod('atk', 'pct', v, src(x)), mod('def', 'pct', v, src(x))); }],
  [/^阻挡数\+\{block_cnt\}$/, x => x.active.mods.push(mod('block', 'add', x.use('block_cnt'), src(x)))],
  [/^阻挡数\+1$/, x => x.active.mods.push(mod('block', 'add', 1, src(x)))],
  [/^阻挡数变为0$/, x => { x.active.patch.block = 0; }],
  [/^停止攻击$/, x => { x.active.patch.attacks = false; }],
  [/^攻击范围(?:扩大|增大|改变|缩小)$/, x => { x.active.patch.range = skillRange(x); }],
  [/^攻击(?:距离|范围)\+\{ability_range_forward_extend\}格?$/, x => { const r = extendForward(x.op.range, x.use('ability_range_forward_extend')); if (!r) throw new Error('forward extension of a range with several rows'); x.active.patch.range = r; }],
  [/^[且但]?攻击间隔(?:略微|少量|小幅|稍微|一定程度|较大幅度?|大幅度?|超大幅度|极大幅度)?(?:缩短|降低|减小|缩小)$/, x => { const v = x.use('base_attack_time'); if (!batShorten(x, v)) throw new Error('base_attack_time ' + v + ' is not a shortening'); }],
  [/^[且但]?攻击间隔(?:略微|少量|小幅|稍微|一定程度|较大幅度?|大幅度?|超大幅度|极大幅度)?(?:增大|延长)$/, x => {
    const v = x.use('base_attack_time');
    if (!(v > 0) || !BAT_LENGTHEN_MODE) throw new Error(`base_attack_time ${v} under "攻击间隔增大": +seconds or x(1+v) cannot be told from the data (BAT_LENGTHEN_MODE)`);
    x.active.mods.push(BAT_LENGTHEN_MODE === 'add' ? mod('baseAttackTime', 'add', v, src(x)) : mod('baseAttackTime', 'mul', 1 + v, src(x)));
  }],
  [/^(?:立即|并)?获得\{cost\}点(?:部署)?费用$/, x => { x.instant = Object.assign(x.instant || {}, { dp: x.use('cost') }); }],
  [/^(?:持续时间内回复总共|技能持续时间内逐渐获得|逐渐回复总共)\{value\}点部署费用$/, x => {
    x.dpOverDuration = x.use('value');
    if (x.has('interval') && x.has('cost') && near(Math.round(x.lv.duration / x.sbb.interval) * x.sbb.cost, x.dpOverDuration)) { x.skip('interval'); x.skip('cost'); }
  }],
  [/^下一?次攻击的攻击力(?:提高|提升)至\{atk_scale:0%\}$/, x => { x.nextAttack = true; skillScale(x, x.use('atk_scale')); }],
  [/^下一?次攻击造成相当于攻击力\{atk_scale:0%\}的(物理|法术)伤害$/, (x, m) => { x.nextAttack = true; skillScale(x, x.use('atk_scale')); x.active.patch.damageType = m[1] === '法术' ? 'arts' : 'physical'; }],
  [/^并连续攻击两次$/, x => { if (!x.nextAttack) throw new Error('"并连续攻击两次" outside a next-attack skill'); x.active.patch.hits = 2; }],
  [/^同时攻击\{attack@max_target\}个目标$/, x => { x.active.patch.targets = x.use('attack@max_target'); }],
  [/^额外攻击(?:一|1)(?:个|名)目标$/, x => { x.active.patch.targets = x.op.targets + 1; }],
  [/^同时攻击2名敌人$/, x => { x.active.patch.targets = 2; }],
  [/^攻击变为(二|三|2|3)连(?:击|射)$/, (x, m) => { x.active.patch.hits = m[1] === '二' || m[1] === '2' ? 2 : 3; }],
  [/^(?:每次)?攻击造成相当于攻击力\{attack@atk_scale:0%\}的(物理|法术)伤害$/, (x, m) => { skillScale(x, x.use('attack@atk_scale')); x.active.patch.damageType = m[1] === '法术' ? 'arts' : 'physical'; }],
  [/^(?:伤害类型变为法术|普通攻击造成法术伤害)$/, x => { x.active.patch.damageType = 'arts'; }],
  [/^远程攻击不再降低攻击力$/, x => { if (x.active.patch.atkScaleMelee === undefined) throw new Error('no ranged-attack penalty to lift'); x.active.patch.atkScale = 1; }],
  [/^且?持续时间无限$/, x => { x.infinite = true; }],
  [/^技能会?自动开启$/, x => { if (x.lv.skillType !== 'AUTO') throw new Error('"自动开启" on a skill that is not AUTO'); }],
  [/^攻击装有\{attack@trigger_time\}发弹药$/, x => { if (x.lv.durationType !== 'AMMO') throw new Error('ammo clause without AMMO durationType'); x.ammo = x.use('attack@trigger_time'); }],
  [/^打完后结束（可随时停止技能）$/, x => { if (x.lv.durationType !== 'AMMO') throw new Error('ammo clause without AMMO durationType'); }],
  [/^可充能(?:\{(ct|cnt)\}|(\d))次$/, (x, m) => { const n = m[1] ? x.use(m[1]) : Number(m[2]); if (n !== x.lv.spData.maxChargeTime) throw new Error('charges ' + n + ' differ from maxChargeTime'); }],
];
const ZERO_OK = new Set(['base_attack_time', 'atk', 'def', 'attack_speed', 'max_hp']);   // value 0 = no effect

function skillGeneric(x) {
  const lv = x.lv, passive = lv.skillType === 'PASSIVE', a0 = x.active.mods.length;   // mods before a0 are talents (already in base)
  let clauses = strip(lv.description).split(/[，,；;。\n]/).map(s => s.trim()).filter(Boolean);
  // passives "部署后…": active from deployment for the duration; other passives are always on
  if (passive && clauses.length && clauses[0].startsWith('部署后')) {
    if (!(lv.duration > 0)) return x.fail('skill: "部署后…" passive without a positive duration is not understood');
    clauses[0] = clauses[0].slice(3); x.onDeploy = true;
  }
  for (const cl of clauses) {
    const rule = G.find(([re]) => re.test(cl));
    if (!rule) return x.fail(`skill: clause not understood: "${cl}"`);
    try { rule[1](x, rule[0].exec(cl)); } catch (e) { return x.fail(`skill: clause "${cl}": ${e.message}`); }
  }
  const left = x.unused().filter(k => !(ZERO_OK.has(k) && x.sbb[k] === 0));
  if (left.length) return x.fail('skill: blackboard key not understood: ' + left.map(k => `${k}=${x.sbb[k]}`).join(', '));
  if (lv.durationType === 'AMMO') { if (!x.ammo) return x.fail('skill: AMMO skill without attack@trigger_time'); x.duration = -1; x.omit('skill: ends after ' + x.ammo + ' attacks (spec.ammo); stopping it early is not modelled'); }
  else if (x.nextAttack) { x.ammo = 1; x.duration = -1; x.omit('skill: "next attack" skill, modelled as active until one attack was made (spec.ammo = 1)'); }
  else if (passive && !x.onDeploy) { x.duration = 0; x.base.mods.push(...x.active.mods.slice(a0)); Object.assign(x.base.patch, x.active.patch); }
  else if (x.infinite) { if (lv.duration !== -1) return x.fail('skill: "持续时间无限" with duration ' + lv.duration); x.duration = -1; }
  else if (lv.duration > 0) x.duration = lv.duration;
  else if (x.instant && !x.active.mods.length && !Object.keys(x.active.patch).some(k => !(k in x.base.patch))) x.duration = 0;
  else return x.fail(`skill: duration ${lv.duration} without "持续时间无限" is not understood`);
}

// ---------- compileSkill ----------
const SPEC_CACHE = new WeakMap();
function compileSkill(op) {
  if (SPEC_CACHE.has(op)) return SPEC_CACHE.get(op);
  const lv = skillLevelData(op), x = builder(op, lv);
  const T = talentsOf(op), tr = traitOf(op);
  const handChar = CHAR[op.id];
  let handSkill = false;
  try { if (handChar) handChar(x, T, tr); else talentsGeneric(x, T); }
  catch (e) { x.omit('talents / trait: ' + e.message + ' (rest not modelled)'); }
  traitRest(x, tr);   // trait sentence (unless a handler read it) and every module addition no handler took
  const spec = {
    id: op.skillId || null, name: lv ? lv.name : null, level: lv ? op.skillLevel : 0,
    trigger: 'PASSIVE', spType: 'NONE', spCost: 0, initSp: 0, duration: 0, instant: null, dpOverDuration: 0,
    fidelity: 'approx', notes: x.notes,
  };
  if (!lv) x.notes.push(op.skillId ? `skill ${op.skillId} level ${op.skillLevel} not in skill_table` : 'no skill selected');
  else {
    const desc = strip(lv.description), sp = lv.spData;
    spec.trigger = lv.skillType; spec.spType = SP_TYPES[sp.spType];
    if (!TRIGGERS.has(spec.trigger)) x.fail('skill: unknown skillType ' + lv.skillType);
    if (!spec.spType) { x.fail('skill: unknown spType ' + sp.spType); spec.spType = 'NONE'; }
    spec.spCost = sp.spCost; spec.initSp = sp.initSp; spec.duration = lv.duration;
    const hand = SKILL.find(([id]) => id.test(op.skillId));
    const m = hand && hand[1].exec(desc);
    if (m) {
      // a failing hand-checked handler must not leave half its effects behind (talents stay)
      const keep = { bm: x.base.mods.length, am: x.active.mods.length, bp: { ...x.base.patch }, ap: { ...x.active.patch } };
      try {
        hand[2](x, m); handSkill = true;
        for (const k of x.unused()) x.omit(`skill: blackboard key ${k} = ${x.sbb[k]} not interpreted`);
      } catch (e) {
        x.base.mods.length = keep.bm; x.active.mods.length = keep.am; x.base.patch = keep.bp; x.active.patch = keep.ap;
        Object.assign(x, { instant: null, dpOverDuration: 0, duration: undefined, stages: null, ammo: 0 });
        x.fail(`skill: hand-checked handler failed (${e.message})`);
      }
    } else {
      if (hand) x.omit('skill: description differs from the hand-checked template, compiled generically');
      if (!x.failed) skillGeneric(x);
    }
    if (x.duration !== undefined) spec.duration = x.duration;
  }
  const failed = x.failed || !lv;
  spec.fidelity = x.failed ? 'unsupported' : handSkill && handChar && !x.degraded ? 'exact' : !lv && handChar && !x.degraded ? 'exact' : 'approx';
  if (x.failed) x.notes.push('unsupported: behaves as no skill (base profile only)');
  if (!failed) {
    spec.instant = x.instant; spec.dpOverDuration = x.dpOverDuration;
    if (spec.spType === 'TIME' || spec.spType === 'NONE') spec.initSp += spec.trigger === 'PASSIVE' ? 0 : x.initSpAdd;
  }
  // ----- extensions -----
  spec.operator = op.name;
  spec.rangeId = (lv && lv.rangeId) || null;
  spec.charges = lv ? Math.max(1, lv.spData.maxChargeTime || 1) : 1;
  spec.spRate = lv ? lv.spData.increment * SP_PER_SECOND_PER_INCREMENT : 0;
  spec.ammo = failed ? 0 : x.ammo;
  spec.onDeploy = !failed && x.onDeploy;
  spec.stages = failed || !x.stages ? null : x.stages.map(s => ({ duration: s.duration }));
  spec.teamMods = x.teamMods; spec.squad = x.squad; spec.stacking = x.stacking;
  spec.initSpRoll = x.initSpRoll && !failed && spec.trigger !== 'PASSIVE' ? x.initSpRoll : null;
  spec.handChecked = { skill: handSkill, talents: !!handChar };
  const act = failed ? x.base : x.active;
  spec.effects = { base: x.base, active: act, stages: failed || !x.stages ? null : x.stages.map(s => ({ mods: act.mods.concat(s.mods), patch: Object.assign({}, act.patch, s.patch) })) };
  SPEC_CACHE.set(op, spec);
  return spec;
}

// ---------- profiles ----------
function buildProfile(op, eff, extra) {
  const e = eff || { mods: [], patch: {} };
  const u = O.applyMods({ hp: op.hp, atk: op.atk, def: op.def, res: op.res, block: op.block, attackSpeed: op.attackSpeed, baseAttackTime: op.baseAttackTime, interval: op.interval }, e.mods.concat(extra));
  return Object.assign({
    hp: u.hp, atk: u.atk, def: u.def, res: u.res, block: u.block, interval: u.interval,
    damageType: op.damageType, targets: op.targets ?? 1, canHitAir: !!op.canHitAir, range: op.range,
    atkScale: 1, hits: op.hits || 1, attacks: op.attacks !== false,
  }, e.patch);
}
// profiles(op, spec, {stacks, extraMods}) -> {base, active[, stages]}. `stacks` = stacks of a time-stacking talent
// (spec.stacking); `extraMods` = further modifiers (team buffs) summed into the same buckets.
function profiles(op, spec, opts = {}) {
  spec = spec || compileSkill(op);
  const eff = spec.effects, extra = (opts.extraMods || []).slice();
  if (spec.stacking) {
    const n = Math.max(0, Math.min(spec.stacking.max, opts.stacks ?? TALENT_STACKS_DEFAULT));
    for (const m of spec.stacking.mods) if (n) extra.push({ ...m, value: m.value * n });
  }
  const base = buildProfile(op, eff && eff.base, extra);
  if (!eff || spec.fidelity === 'unsupported') return { base, active: base };
  const out = { base, active: buildProfile(op, eff.active, extra) };
  if (eff.stages) { out.stages = eff.stages.map(s => buildProfile(op, s, extra)); out.active = out.stages[0]; }
  return out;
}
// The profile in force for an automaton state: base when inactive; while active the stage of this use
// (棘刺 S3: second and later uses) or profiles.active.
function currentProfile(profs, state) {
  if (!state || !state.active) return profs.base;
  return profs.stages ? profs.stages[Math.min(Math.max(state.uses, 1), profs.stages.length) - 1] : profs.active;
}

// ---------- SP automaton ----------
const usable = spec => spec.fidelity !== 'unsupported';
const spCap = spec => (spec.spCost || 0) * (spec.charges || 1);
const durationOfUse = (spec, n) => spec.stages ? spec.stages[Math.min(n, spec.stages.length) - 1].duration : spec.duration;
function skillInit(spec) {
  const st = { sp: Math.min(spec.initSp || 0, spCap(spec)), active: false, remaining: 0, uses: 0 };
  if (spec.onDeploy && usable(spec)) { st.active = true; st.remaining = spec.duration; st.uses = 1; }   // "部署后…" passives
  return st;
}
function gainTime(spec, st, dt) {
  if (spec.spType === 'TIME' && spec.trigger !== 'PASSIVE' && usable(spec)) st.sp = Math.min(spCap(spec), st.sp + dt * (spec.spRate ?? 1));
}
// TIME sp while inactive; duration countdown while active. remaining < 0 = until retreat (or until the ammo is spent).
function skillTick(spec, st, dt) {
  if (!st.active) { gainTime(spec, st, dt); return null; }
  if (st.remaining < 0) return null;
  st.remaining -= dt;
  if (st.remaining > EPS) return null;
  const over = Math.max(0, -st.remaining);          // the part of this tick after the skill ended charges SP again
  st.active = false; st.remaining = 0; delete st.ammo;
  gainTime(spec, st, over);
  return 'ended';
}
function skillOnAttack(spec, st) {
  if (st.active) { if (st.ammo !== undefined && --st.ammo <= 0) st.remaining = 0; return; }   // ammo spent: next tick returns 'ended'
  if (spec.spType === 'ATTACK' && usable(spec)) st.sp = Math.min(spCap(spec), st.sp + 1);
}
function skillOnHit(spec, st) {
  if (!st.active && spec.spType === 'HIT' && usable(spec)) st.sp = Math.min(spCap(spec), st.sp + 1);
}
function skillReady(spec, st) {
  return !st.active && usable(spec) && (spec.trigger === 'MANUAL' || spec.trigger === 'AUTO') && st.sp >= spec.spCost - EPS;
}
function skillActivate(spec, st) {
  if (!skillReady(spec, st)) throw new Error('skill not ready: ' + (spec.name || spec.id));
  st.sp = Math.max(0, st.sp - spec.spCost); st.uses += 1;
  const d = durationOfUse(spec, st.uses);
  if (spec.ammo) { st.active = true; st.remaining = -1; st.ammo = spec.ammo; }
  else if (d !== 0) { st.active = true; st.remaining = d; }          // d = 0: fires instantly, never active
  return spec.instant || {};
}

// Steady state of a TIME skill used the moment it is ready: {uptime, period}. null where that is not a fixed
// cycle (ATTACK / HIT sp, passives, ammo, multi-stage, unsupported).
function cycle(spec) {
  if (!spec || !usable(spec) || spec.spType !== 'TIME' || spec.trigger === 'PASSIVE' || spec.ammo || spec.stages || spec.onDeploy) return null;
  if (spec.duration < 0) return { uptime: 1, period: Infinity };
  const rate = spec.spRate ?? 1, period = rate > 0 ? spec.spCost / rate + spec.duration : 0;
  return period > 0 ? { uptime: spec.duration / period, period } : null;
}

// ---------- describeSkill ----------
const f2 = v => String(+v.toFixed(2));
function describeSkill(op) {
  const spec = compileSkill(op), p = profiles(op, spec), b = p.base, bits = [];
  const delta = a => {
    const d = [];
    if (!near(a.atk, b.atk)) d.push(`ATK x${f2(a.atk / b.atk)}`);
    if (!near(a.def, b.def)) d.push(`DEF x${f2(a.def / b.def)}`);
    if (!near(a.hp, b.hp)) d.push(`HP ${a.hp > b.hp ? '+' : ''}${f2(a.hp - b.hp)}`);
    if (!near(a.res, b.res)) d.push(`RES ${f2(b.res)}->${f2(a.res)}`);
    if (!near(a.interval, b.interval)) d.push(`interval ${f2(b.interval)}->${f2(a.interval)}s`);
    if (a.atkScale !== b.atkScale) d.push(`hit x${f2(a.atkScale)}`);
    if (a.hits !== b.hits) d.push(`${a.hits} hits/attack`);
    if (a.targets !== b.targets) d.push(`targets ${b.targets}->${a.targets}`);
    if (a.block !== b.block) d.push(`block ${b.block}->${a.block}`);
    if (a.range !== b.range) d.push(`range ${b.range.length}->${a.range.length} tiles`);
    if (a.damageType !== b.damageType) d.push(a.damageType + ' damage');
    if (a.attacks !== b.attacks) d.push(a.attacks ? 'attacks' : 'stops attacking');
    return d;
  };
  if (!spec.id) return `${op.name}: no skill [${spec.fidelity}]`;
  const head = `${op.name} S${op.skillIndex + 1} ${spec.name} Lv${spec.level}`;
  if (spec.fidelity === 'unsupported') return `${head}: unsupported (${spec.notes.find(n => n.startsWith('skill')) || 'not understood'})`;
  const timing = spec.trigger === 'PASSIVE' ? (spec.onDeploy ? `passive, ${spec.duration}s from deployment` : 'passive, always on')
    : `${spec.trigger} ${spec.spType} sp ${f2(spec.initSp)}/${spec.spCost}${spec.charges > 1 ? ' x' + spec.charges : ''}, ` +
      (spec.ammo ? `${spec.ammo} attack${spec.ammo > 1 ? 's' : ''}` : spec.duration === 0 ? 'instant' : spec.duration < 0 ? 'until retreat' : spec.duration + 's');
  const ins = spec.instant || {};
  if (ins.dp) bits.push(`+${ins.dp} DP`);
  if (ins.damage) bits.push(`${ins.damage.hits > 1 ? ins.damage.hits + 'x' : ''}${f2(ins.damage.scale * 100)}% ATK ${ins.damage.damageType} to ${ins.damage.targets >= O.TARGETS_ALL ? 'all enemies' : ins.damage.targets + ' enemies'} in ${ins.damage.range ? ins.damage.range.length + ' tiles' : 'range'}`);
  if (ins.selfHeal) bits.push(`heals herself to ${f2(ins.selfHeal.hpRatio * 100)}% HP`);
  if (ins.heal) bits.push(`heals all allies in ${ins.heal.range ? ins.heal.range.length + ' tiles' : 'range'} for ${f2(ins.heal.scale * 100)}% ATK`);
  if (spec.dpOverDuration) bits.push(`+${spec.dpOverDuration} DP over the duration`);
  if (p.stages) p.stages.forEach((s, i) => bits.push(`use ${i + 1}${i === p.stages.length - 1 ? '+' : ''} (${spec.stages[i].duration < 0 ? 'permanent' : spec.stages[i].duration + 's'}): ${delta(s).join(', ')}`));
  else if (spec.trigger !== 'PASSIVE' || spec.onDeploy) bits.push(...delta(p.active));
  else bits.push(...spec.effects.base.mods.filter(m => String(m.source).startsWith('skill')).map(m => `${m.stat} ${m.op} ${m.value}`));
  return `${head}: ${timing}; ${bits.join(', ') || 'no profile change'} [${spec.fidelity}${spec.notes.length ? ', ' + spec.notes.length + ' notes' : ''}]`;
}

module.exports = {
  compileSkill, profiles, skillInit, skillTick, skillOnAttack, skillOnHit, skillReady, skillActivate, describeSkill, cycle,
  // extras
  currentProfile, talentsOf, traitOf, skillLevelData,
  SP_PER_SECOND_PER_INCREMENT, BAT_NEGATIVE_IS_SECONDS, BAT_FRACTION_IS_SCALE, BAT_LENGTHEN_MODE, LORD_BASIC_ATTACK_IS_RANGED,
  TALENT_STACKS_DEFAULT, DEPLOY_SP_ROLL, AURA_INCLUDES_SELF, EPS,
};
