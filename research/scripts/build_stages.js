// Builds research/derived/stages.json: every 黑流树海 battle with enemy roster, real stats and difficulty metrics.
// Inputs: tomimi stage data (research/sources/tomimi), ArknightsGameData enemy_database.json, lubiao stage frequencies.
// Usage: node research/scripts/build_stages.js
'use strict';
const fs = require('fs');
const path = require('path');
const { decodeFile } = require('./tomimi_decode.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'research', 'sources');
const OUT_DIR = path.join(ROOT, 'research', 'derived');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------- enemy stats, merged per level ----------
const db = JSON.parse(fs.readFileSync(path.join(SRC, 'gamedata', 'enemy_database.json'), 'utf8')).enemies;
const byKey = new Map(db.map(e => [e.Key, e.Value]));
const val = x => (x && typeof x === 'object' && 'm_defined' in x ? x.m_value : x);
function merged(key, level) {
  const levels = byKey.get(key);
  if (!levels) return null;
  const base = levels.find(l => l.level === 0) || levels[0];
  const lv = levels.find(l => l.level === level) || base;
  const pickAttr = name => {
    const a = lv.enemyData.attributes[name], b = base.enemyData.attributes[name];
    return a && a.m_defined ? a.m_value : b ? b.m_value : 0;
  };
  const pickData = name => {
    const a = lv.enemyData[name], b = base.enemyData[name];
    return a && a.m_defined ? a.m_value : b ? val(b) : null;
  };
  return {
    key, level,
    name: pickData('name'),
    levelType: pickData('levelType') || 'NORMAL',
    applyWay: pickData('applyWay'),
    motion: pickData('motion'),
    hp: pickAttr('maxHp'), atk: pickAttr('atk'), def: pickAttr('def'), res: pickAttr('magicResistance'),
    interval: pickAttr('baseAttackTime') / Math.max(0.1, pickAttr('attackSpeed') / 100),
    speed: pickAttr('moveSpeed'), weight: pickAttr('massLevel'),
    lifePoint: pickData('lifePointReduce') ?? 1,
    rangeRadius: pickData('rangeRadius'),
  };
}

// ---------- stages ----------
const tdir = path.join(SRC, 'tomimi');
const index = fs.readFileSync(path.join(tdir, 'index.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t'));
const freq = JSON.parse(fs.readFileSync(path.join(SRC, 'lubiao', 'foundation-battle-stage-frequencies-rogue_6.json'), 'utf8'));
const lbBattles = JSON.parse(fs.readFileSync(path.join(SRC, 'lubiao', 'battles_rogue_6.json'), 'utf8')).stages;
const freqById = {};
for (const g of freq.groups) for (const s of g.stages) (freqById[s.stageId] = freqById[s.stageId] || []).push({ floor: g.floor, type: g.type, remembrance: g.remembrance, share: +s.frequency.toFixed(4), count: s.count, groupSamples: g.sampleCount });

// A reference attacker: what one hit of a strong E2 operator does after typical buffs.
const REF_ATK = 1000;
const hitDamage = e => Math.max(REF_ATK - e.def, REF_ATK * 0.05);
const artsDamage = e => Math.max(REF_ATK * (1 - e.res / 100), REF_ATK * 0.05);
const multipliers = mods => {
  const m = { hp: 1, atk: 1, def: 1, res: 0 };
  for (const g of mods || []) for (const x of g.mods || []) {
    if (!(g.targets || []).includes('ALL')) continue;
    if (x.mode === 'mul' && m[x.key] !== undefined) m[x.key] *= x.value;
    if (x.mode === 'add' && x.key === 'magic_resistance') m.res += x.value;
  }
  return m;
};

const stages = [];
const missing = new Set();
for (const [i, slug] of index) {
  const d = decodeFile(path.join(tdir, i + '.json'));
  const mc = d.mapConfig;
  const elite = multipliers(mc.elite_mods);
  const normal = multipliers(mc.n_mods);
  const roster = [];
  for (const e of mc.enemies || []) {
    const st = merged(e.prefabKey || e.id, e.level || 0);
    if (!st) { missing.add(e.id); continue; }
    const n = ((e.min_count || 0) + (e.max_count || 0)) / 2;
    const ne = ((e.elite_min_count ?? e.min_count ?? 0) + (e.elite_max_count ?? e.max_count ?? 0)) / 2;
    if (!n && !ne) continue;
    roster.push({ ...st, count: n, eliteCount: ne });
  }
  const metric = (mult, countKey) => {
    let hp = 0, work = 0, dps = 0, enemies = 0, leaders = 0, flyers = 0, maxHp = 0, lifeAtRisk = 0;
    for (const e of roster) {
      const c = e[countKey];
      if (!c) continue;
      const eh = { ...e, hp: e.hp * mult.hp, def: e.def * mult.def, res: Math.min(100, e.res + mult.res) };
      hp += c * eh.hp;
      work += c * eh.hp / Math.max(hitDamage(eh), artsDamage(eh));
      dps += c * (e.atk * mult.atk) / Math.max(0.3, e.interval);
      enemies += c;
      if (e.levelType === 'ELITE' || e.levelType === 'BOSS') leaders += c;
      if (e.motion === 'FLY') flyers += c;
      maxHp = Math.max(maxHp, eh.hp);
      lifeAtRisk += c * (e.lifePoint || 1);
    }
    return { enemies: Math.round(enemies), leaders: Math.round(leaders), flyers: Math.round(flyers), totalHp: Math.round(hp), hitsToKill: Math.round(work), enemyDps: Math.round(dps), maxHp: Math.round(maxHp), lifeAtRisk: Math.round(lifeAtRisk) };
  };
  const lb = lbBattles.find(b => b.id === mc.id) || {};
  stages.push({
    id: mc.id, slug, name: mc.name_zh, code: mc.code, floors: mc.floors || [],
    deployLimit: mc.characterLimit, initialCost: mc.initialCost,
    description: (mc.description_zh || '').replace(/<[^>]*>/g, ''),
    eliteDesc: (mc.eliteDesc_zh || []).join ? mc.eliteDesc_zh : mc.eliteDesc_zh,
    rewards: lb.rewards || null,
    frequency: (freqById[mc.id] || []).concat(freqById[mc.id.replace('_n_', '_e_')] || []),
    normal: metric(normal, 'count'),
    elite: metric({ hp: normal.hp * elite.hp, atk: normal.atk * elite.atk, def: normal.def * elite.def, res: normal.res + elite.res }, 'eliteCount'),
    roster: roster.map(e => ({ key: e.key, name: e.name, level: e.level, type: e.levelType, motion: e.motion, way: e.applyWay, hp: e.hp, atk: e.atk, def: e.def, res: e.res, count: e.count, eliteCount: e.eliteCount })),
  });
}

// Relative difficulty: hits-to-kill and enemy pressure, scaled within the whole set.
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 1; };
const mWork = med(stages.map(s => s.normal.hitsToKill).filter(Boolean));
const mDps = med(stages.map(s => s.normal.enemyDps).filter(Boolean));
for (const s of stages) for (const k of ['normal', 'elite']) {
  const m = s[k];
  m.index = +(0.6 * (m.hitsToKill / mWork) + 0.4 * (m.enemyDps / mDps)).toFixed(2);
}
fs.writeFileSync(path.join(OUT_DIR, 'stages.json'), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), refAtk: REF_ATK, missingEnemies: [...missing], stages }, null, 1));
console.log('stages', stages.length, 'missing enemies', missing.size, [...missing].slice(0, 8));
for (const s of stages.slice().sort((a, b) => (a.floors[0] || 9) - (b.floors[0] || 9) || b.normal.index - a.normal.index)) {
  console.log((s.floors.join('/') || '?').padEnd(6), s.code, s.name.padEnd(8, '　'), 'idx', String(s.normal.index).padStart(5), 'e', String(s.elite.index).padStart(5), 'n', s.normal.enemies, 'lead', s.normal.leaders, 'fly', s.normal.flyers, 'hits', s.normal.hitsToKill, 'dps', s.normal.enemyDps, 'deploy', s.deployLimit, 'cost', s.initialCost, 'freq', s.frequency.map(f => f.floor + f.type + ':' + (f.share * 100).toFixed(0) + '%').join(' '));
}
