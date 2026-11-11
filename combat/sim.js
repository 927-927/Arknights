// Deterministic fixed-tick combat simulator: scores ONE plan (= combat timeline: who goes where, facing where,
// when it is deployed, when each skill starts) on one stage. Interface: combat/CONTRACT.md sections 5-6.
// Usage: node combat/sim.js <stage> [--secrecy N --floor F --elite --seed S --tps X --timing afterLast|fromStart]
'use strict';
const sm = require('./stage_model.js');

// ---------- modelling constants: every unverified choice is named here ----------
// ASSUMPTION: move speed 1.0 = 0.5 tiles per second (community wikis; CONTRACT 6). The user calibrates it in game.
const TPS_DEFAULT = 0.5;
const DT_DEFAULT = 0.1;            // tick length in seconds
const TRACE_SAMPLE_DT = 0.5;       // spacing of trace frames
const EPS = 1e-9;
// HANDOFF: physical = max(ATK-DEF, 5% ATK). The same 5% floor is used for arts, as operators.hitDamage does.
const MIN_DAMAGE_RATIO = 0.05;
// ASSUMPTION: life points are a property of the run, not of the stage (no stage file carries them), so the default
// is 1: any leak that costs life loses. Pass opts.lifePoints (or stage.lifePoints) for the real value.
const LIFE_POINTS_DEFAULT = 1;
// ASSUMPTION: a planned retreat refunds floor(cost / 2) DP.
const RETREAT_REFUND = 0.5;
// HANDOFF secrecy table: from 保密等级 10 the deploy limit is 1 lower.
const SECRECY_LIMIT_LEVEL = 10;
// ASSUMPTION: a fragment's preDelay counts from the END of the previous fragment (= the last action it executed),
// not from its start ('fromStart' = what stage_model.enemyTimeline does). Evidence from the 77 stage files: 62 of
// 171 follow-on fragments have a preDelay shorter than the spawn span of the fragment before them and 61 have
// preDelay 0 (they would all start inside or together with the previous fragment, so splitting the script into
// fragments would do nothing); 虫虫游戏厅 would spawn its 65-83 slimes within 60 s. No file carries a duration to
// check against. opts.fragmentTiming switches between the two.
const FRAGMENT_TIMING_DEFAULT = 'afterLast';
// ASSUMPTION: every enemy takes exactly 1 block (enemy_database.blockVolume is -1 for all 321 enemies used).
const BLOCK_PER_ENEMY = 1;
// ASSUMPTION: the default time limit is the no-defence duration (waves strictly one after the other) * factor + pad.
const MAXTIME_FACTOR = 1.5, MAXTIME_PAD = 120;
// ASSUMPTION: maxTimeWaitingForNextWave (10 waves in the 77 stages) counts from the moment the wave's script has run
// out, not from the wave start: 选边站 wave 0 has a 70 s maximum wait on a 132 s script, which counted from the
// start would cut the script or run two waves at once.
// ASSUMPTION: a deterministic simulation uses probabilities as expected values (damageNegateProb scales the damage).
// ASSUMPTION (profile.dot): one poison per enemy; a new application at least as strong replaces it (dps, source,
// duration restarted), a weaker one while it runs is ignored. dpsVsRanged applies to enemies that attack at range.
// ASSUMPTION (profile.hpDrain): the drain rises linearly from 0 at activation to ratioPerSec x max HP per second
// after rampSeconds (skills.js: "the shape of the rise is not in the data"); its tick is treated as continuous.
// ASSUMPTION (profile.deathDelay): lethal damage leaves the operator at 1 HP, once per deployment; nothing takes her
// below 1 HP until she leaves deathDelay seconds later, which counts as 'died'.
// ASSUMPTION (profile.aura, 夜莺 "攻击范围内的友方单位…"): the operator that carries the aura is a friendly unit in her
// own range too, so it applies to her when her tile is in her range (the text does not exclude her).
const AURA_INCLUDES_SOURCE = true;
// ASSUMPTION (profile.idleRegen, 棘刺 "如果N秒内没有主动攻击过"): the idle clock starts at the deployment.
// ASSUMPTION (profile.defIgnoreRamp, 能天使 module "每次造成伤害提升N点"): a hit ignores the DEF reached before it,
// then the ramp rises by perHit; every damage instance of the operator counts, and it resets to 0 once resetAfter
// seconds passed without an attack.
// ASSUMPTION (opts.squad): spec.squad.initialDp ("编入队伍后…初始部署费用") counts for every operator of the squad;
// without opts.squad the squad is the operators of plan.deploys.
const AIR_FIRST = 1e7;             // prefersAir: FLY enemies sort before every ground enemy
const SAMPLE_CACHE_MAX = 64;       // prepared enemy lists kept per stage when opts.enemies is not given

const DIRS = { E: 0, S: 1, W: 2, N: 3 };
const PHYS = 0, ARTS = 1, TRUE = 2, HEAL = 3, NONE = 4;
const DCODE = { physical: PHYS, arts: ARTS, true: TRUE, heal: HEAL, none: NONE };
const MODE = { none: 0, melee: 1, ranged: 2 };
const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000, r6 = x => Math.round(x * 1e6) / 1e6;

// operators.js / skills.js are built in parallel: required on first use only; null while the file does not exist.
const LAZY = {};
function lazy(name) {
  if (name in LAZY) return LAZY[name];
  try { LAZY[name] = require('./' + name + '.js'); }
  catch (e) { if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes(name + '.js')) throw e; LAZY[name] = null; }
  return LAZY[name];
}

function mulberry32(seed) {
  let a = seed | 0;
  return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// ---------- stage facts ----------
// Hidden spawn groups the mode switches on, enemy replacements and forbidden tiles. all_mods hold in both modes,
// n_mods in normal mode only, elite_mods in 紧急作战: with exactly this reading the possible enemy totals reproduce
// tomimi's n_count on 75/77 stages and e_count on 35/35 (the two misses are the duel stages 搏杀 and 共斗).
function stageSystem(mc, elite) {
  const on = new Set(), off = new Set(), replace = new Map(), forbid = [];
  const H = mc.mapData && mc.mapData.map ? mc.mapData.map.length : 0;
  for (const field of elite ? ['all_mods', 'elite_mods'] : ['all_mods', 'n_mods'])
    for (const g of mc[field] || []) for (const m of Array.isArray(g.mods) ? g.mods : []) {
      if (m.key === 'level_hidden_group_enable') on.add(m.valueStr);
      else if (m.key === 'level_hidden_group_disable') off.add(m.valueStr);
      else if (m.key === 'level_enemy_replace') replace.set(m.target, m.value);
      // "row,col" with the row counted from the bottom (game coordinates)
      else if (m.key === 'global_forbid_location') for (const s of m.value || []) { const [row, col] = String(s).split(',').map(Number); forbid.push({ r: H - 1 - row, c: col }); }
    }
  for (const g of off) on.delete(g);
  if (elite && mc.elite_runes) {
    // "c,r" in grid coordinates (row from the top); names the same tiles as global_forbid_location on all 4 stages
    for (const s of mc.elite_runes.forbid_locations || []) { const [c, r] = String(s).split(',').map(Number); if (!forbid.some(f => f.r === r && f.c === c)) forbid.push({ r, c }); }
    for (const [k, v] of Object.entries(mc.elite_runes.enemy_replace || {})) replace.set(k, v);
  }
  return { on, replace, forbid };
}

const STAGE = new WeakMap();
function stageInfo(stage) {
  let s = STAGE.get(stage);
  if (s) return s;
  const { H, W, grid } = stage, mc = stage.mc || {};
  const high = new Uint8Array(H * W), dep = new Uint8Array(H * W);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { high[r * W + c] = grid[r][c].high ? 1 : 0; dep[r * W + c] = grid[r][c].deployable ? 1 : 0; }
  const ids = list => new Set((list || []).map(f => typeof f === 'number' ? f : f.r * W + f.c));
  s = { H, W, high, dep,
    initialCost: stage.initialCost ?? mc.initialCost ?? 0,
    costTime: stage.costIncreaseTime ?? mc.costIncreaseTime ?? 1,
    maxCost: stage.maxCost ?? mc.maxCost ?? 99,
    limit: stage.deployLimit ?? mc.characterLimit ?? Infinity,
    forbidAlways: ids(stage.forbidden),                                    // synthetic stages: [{r,c}] or tile ids
    forbidElite: ids(stage.mc ? stageSystem(mc, true).forbid : []) };      // 紧急作战 only
  STAGE.set(stage, s);
  return s;
}

function isOccupied(occ, t, W) {
  if (!occ) return false;
  if (typeof occ === 'function') return !!occ(t);
  if (typeof occ.has === 'function') return occ.has(t);                    // Set / Map of tile ids
  if (ArrayBuffer.isView(occ)) return !!occ[t];                            // bitmap over tile ids
  if (Array.isArray(occ)) return occ.some(x => (typeof x === 'number' ? x : x.r * W + x.c) === t);  // ids or {r,c}
  return false;
}

// Collectible rules (CONTRACT 3 {rule} entries, e.g. loadRoster().rules) this module implements:
//   {rule:'deployLimit', add}   deploy limit + add. One whose source names secrecy is skipped: opts.secrecy counts it.
//   {rule:'meleeOnHighGround'}  MELEE operators may also stand on deployable high ground (舞鞋)
const rulesOf = opts => (opts && Array.isArray(opts.rules) ? opts.rules : []);
const hasRule = (opts, name) => rulesOf(opts).some(x => x && x.rule === name);

// Reason a deployment is illegal, or null. MELEE: deployable non-high tile; RANGED: deployable high tile (HANDOFF).
// A MELEE operator with op.anyTile (operators.js, trait 可以放置于远程位: hookmaster and pusher specialists) or under
// the meleeOnHighGround rule may also use high ground. Forbidden tiles apply in elite mode (opts.elite or
// stage.elite); stage.forbidden always.
function deployError(stage, op, r, c, occupied, opts) {
  const S = stageInfo(stage);
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= S.H || c >= S.W) return 'tile is outside the map';
  const t = r * S.W + c, pos = op && op.position;
  if (!S.dep[t]) return 'tile is not deployable';
  if (pos === 'MELEE') { if (S.high[t] && !op.anyTile && !hasRule(opts, 'meleeOnHighGround')) return 'MELEE operators need a ground tile'; }
  else if (pos === 'RANGED') { if (!S.high[t]) return 'RANGED operators need a high-ground tile'; }
  else if (pos !== 'ALL') return 'operator has no position (MELEE or RANGED)';
  if (S.forbidAlways.has(t) || (((opts && opts.elite) || stage.elite) && S.forbidElite.has(t))) return 'tile is forbidden on this stage';
  if (isOccupied(occupied, t, S.W)) return 'tile is occupied';
  return null;
}
// occupied: Set/Map of tile ids (r*W+c), array of tile ids or {r,c}, bitmap typed array, or predicate.
// opts (extension): {elite, rules}.
const canDeploy = (stage, op, r, c, occupied, opts) => deployError(stage, op, r, c, occupied, opts) === null;

// characterLimit, -1 from 保密等级 10, + collectible deployLimit rules (opts.rules).
function deployLimit(stage, opts) {
  let n = stageInfo(stage).limit - (((opts && opts.secrecy) | 0) >= SECRECY_LIMIT_LEVEL ? 1 : 0);
  for (const x of rulesOf(opts)) if (x && x.rule === 'deployLimit' && Number.isFinite(x.add) && !/secrecy/i.test(x.source || '')) n += x.add;
  return Math.max(0, n);
}

// ---------- score ----------
// Lexicographic: fewer lifeLost, then larger hpRemoved/hpTotal (1e-4 steps), then fewer operators that died
// (planned retreats are not losses), then shorter duration. Higher score = better.
function scoreParts(res) {
  const frac = res.hpTotal > 0 ? Math.min(1, Math.max(0, res.hpRemoved / res.hpTotal)) : 1;
  let died = 0;
  for (const l of res.losses || []) if (l.cause === 'died') died++;
  return [res.lifeLost || 0, Math.round(frac * 1e4), Math.min(99, died), Math.min(9999, res.duration || 0)];
}
function scoreOf(res) {
  const p = scoreParts(res);
  return -p[0] * 1e8 + p[1] * 1e3 - p[2] * 10 - p[3] * 1e-3;
}
// < 0 when a is better than b, so results.sort(compareResults) puts the best first.
function compareResults(a, b) {
  const x = scoreParts(a), y = scoreParts(b);
  return x[0] - y[0] || y[1] - x[1] || x[2] - y[2] || x[3] - y[3];
}

// ---------- enemies ----------
// How an enemy attacks. Source 1: tomimi's sheet (forms[0].normal_attack.atk_type, e.g. ["ranged","arts"]); every
// one of the 6700 enemy instances of the 77 stages (normal + elite, hidden groups included) has it.
// Source 2 (no sheet): enemy_database applyWay; ASSUMPTION: physical (enemy_database has no damage-type field).
// Modes:
//   none    never attacks (no_attack; also "raw" and "heal", whose mechanics the data does not describe)
//   melee   attacks only the operator that blocks it
//   ranged  attacks its blocker, and while walking any operator inside rangeRadius (needs rangeRadius > 0)
function attackOf(info, stats) {
  const na = info && info.forms && info.forms[0] && info.forms[0].normal_attack;
  if (na && Array.isArray(na.atk_type)) {
    const a = na.atk_type;
    const mode = a.includes('no_attack') || a.includes('raw') || a.includes('heal') ? 'none' : a.includes('ranged') ? 'ranged' : a.includes('melee') ? 'melee' : 'none';
    return { attackMode: mode, damageType: a.includes('arts') ? 'arts' : 'physical', hits: na.hits || 1 };
  }
  const w = stats.applyWay;
  return { attackMode: !w || w === 'NONE' ? 'none' : w === 'MELEE' ? 'melee' : 'ranged', damageType: 'physical', hits: 1 };
}

const asMods = x => Array.isArray(x) ? x : x && Array.isArray(x.mods) ? x.mods : [];
// Enemy modifiers = operators.stageMods + operators.secrecyMods + opts.enemyMods, applied with operators.applyMods.
// opts.modApi ({stageMods, secrecyMods, applyMods}) replaces operators.js (tests).
function enemyMods(stage, opts) {
  const elite = !!opts.elite, secrecy = opts.secrecy || 0, extra = opts.enemyMods || [];
  const api = opts.modApi || lazy('operators');
  if (!api) {
    if (elite || secrecy > 0 || extra.length) throw new Error('sim: combat/operators.js is needed to apply enemy modifiers (elite / secrecy / enemyMods)');
    return null;
  }
  const list = asMods(api.stageMods(stage.mc, { elite })).concat(secrecy > 0 ? asMods(api.secrecyMods(secrecy, opts.floor || 1, opts.secrecyOpts)) : [], extra);
  return list.length ? { api, list } : null;
}

// Enemy instances of one playthrough (CONTRACT 5) with every modifier applied, sorted by nominal spawn time.
// Extra fields: prefabKey, baseAttackTime, attackSpeed, massLevel, notCount, attackMode, damageType, hits,
// waveT (spawn relative to the start of its wave), waveSpan (length of its wave's script: the next wave cannot start
// earlier), dontBlockWave, bonus (bonus wave), leaveAt (nominal).
// The returned array also carries a non-enumerable `meta` {seed, fragmentTiming, hiddenGroups, skipped, waveSpans}
// (waveSpans covers waves without enemies too, e.g. a bonus wave that picked EMPTY).
function sampleEnemies(stage, opts) {
  opts = opts || {};
  const mc = stage.mc, out = [], skipped = [];
  if (!mc || !Array.isArray(mc.waves)) return out;
  const tps = opts.tps > 0 ? opts.tps : TPS_DEFAULT, elite = !!opts.elite;
  const timing = opts.fragmentTiming || FRAGMENT_TIMING_DEFAULT;
  if (timing !== 'afterLast' && timing !== 'fromStart') throw new Error('sim: fragmentTiming must be "afterLast" or "fromStart"');
  const rng = mulberry32(opts.seed ?? 1), sys = stageSystem(mc, elite), mods = enemyMods(stage, opts);
  const templates = new Map(), paths = new Map();
  const template = key => {
    if (templates.has(key)) return templates.get(key);
    const me = (mc.enemies || []).find(e => e.id === key) || (mc.enemies || []).find(e => e.prefabKey === key);
    const prefabKey = me ? me.prefabKey || me.id : key, s = sm.enemyStats(prefabKey, me ? me.level : 0);
    let t = null;
    if (s) {
      // overwrittenData = absolute per-stage stat overrides (hp, atk, def, res, ms, aspd = base attack time,
      // attackSpeed, range, lifepoint, weight, levelType): reproduces tomimi's sheet on 805 of 808 stage enemies.
      const o = (me && me.overwrittenData) || {};
      const bat = o.aspd ?? s.baseAttackTime, as = o.attackSpeed ?? s.attackSpeed;
      t = { key, prefabKey, name: s.name, type: o.levelType || s.type, motion: s.motion,
        hp: o.hp ?? s.hp, atk: o.atk ?? s.atk, def: o.def ?? s.def, res: o.res ?? s.res, speed: o.ms ?? s.speed,
        baseAttackTime: bat, attackSpeed: as, interval: bat * 100 / Math.max(10, as), life: o.lifepoint ?? s.life,
        rangeRadius: o.range ?? s.rangeRadius, applyWay: s.applyWay, damageTaken: 1, massLevel: o.weight ?? s.massLevel,
        notCount: s.notCount, ...attackOf(stage.enemyInfo && stage.enemyInfo.get(key), s) };
      if (mods) t = mods.api.applyMods(t, mods.list, { side: 'enemy' });
      if (!(t.interval > 0) && t.baseAttackTime > 0) t.interval = t.baseAttackTime * 100 / Math.max(10, t.attackSpeed || 100);
    }
    templates.set(key, t);
    return t;
  };
  const pathOf = (a, route, t, fly, off) => {
    const v = tps * t.speed, timed = (route.checkpoints || []).some(cp => cp.type === 'WAIT_CURRENT_FRAGMENT_TIME');
    const key = a.routeIndex + '|' + v + '|' + fly + '|' + (timed ? off : '');
    if (!paths.has(key)) paths.set(key, sm.routeTimeline(stage, route, v, fly, { straightFallback: true, strictHidden: true, fragOffset: off }));
    return paths.get(key);
  };
  const bonus = mc.bonus && mc.bonus.type === 'wave' ? mc.bonus : null, waveSpans = [];
  let waveStart = 0;
  mc.waves.forEach((wave, wi) => {
    let clock = waveStart + (wave.preDelay || 0), lastSpawn = waveStart;
    const first = out.length;
    (wave.fragments || []).forEach((frag, fi) => {
      const fragStart = clock + (frag.preDelay || 0);
      // Hidden groups fire only when the mode enables them (stageSystem) or with includeHidden.
      const live = (frag.actions || []).filter(a => !a.hiddenGroup || opts.includeHidden || sys.on.has(a.hiddenGroup));
      // Random spawn groups: exactly one option per (fragment, randomSpawnGroupKey), by weight; options need not be
      // SPAWN (EMPTY, ACTIVATE_PREDEFINED traps): such a pick spawns nothing. An action that carries only a
      // randomSpawnGroupPackKey fires iff the picked option of a group has the same pack key; a pack key no group
      // uses always fires (虫虫游戏厅 pack "aa": needed to reproduce n_count).
      const groups = new Map(), packs = new Set(), picked = new Set(), pickedPacks = new Set();
      for (const a of live) if (a.randomSpawnGroupKey) {
        if (!groups.has(a.randomSpawnGroupKey)) groups.set(a.randomSpawnGroupKey, []);
        groups.get(a.randomSpawnGroupKey).push(a);
        if (a.randomSpawnGroupPackKey) packs.add(a.randomSpawnGroupPackKey);
      }
      for (const options of groups.values()) {
        let total = 0;
        for (const a of options) total += Math.max(0, a.weight || 0);
        let x = rng() * (total > 0 ? total : options.length), pick = options[options.length - 1];   // all weights 0: uniform
        for (const a of options) { x -= total > 0 ? Math.max(0, a.weight || 0) : 1; if (x < 0) { pick = a; break; } }
        picked.add(pick);
        if (pick.randomSpawnGroupPackKey) pickedPacks.add(pick.randomSpawnGroupPackKey);
      }
      let span = 0;
      for (const a of live) {
        const pk = a.randomSpawnGroupPackKey;
        if (a.randomSpawnGroupKey ? !picked.has(a) : pk && packs.has(pk) && !pickedPacks.has(pk)) continue;
        // ASSUMPTION ('afterLast'): every executed action, whatever its type, keeps its fragment open until its
        // last repetition (preDelay + (count-1)*interval).
        span = Math.max(span, (a.preDelay || 0) + Math.max(0, (a.count || 1) - 1) * (a.interval || 0));
        if (a.actionType !== 'SPAWN') continue;
        const key = sys.replace.get(a.key) || a.key, t = template(key), route = mc.routes[a.routeIndex];
        if (!t || !route) { skipped.push({ key, wave: wi, frag: fi, count: a.count, reason: !t ? 'no enemy data' : 'no route' }); continue; }
        // ASSUMPTION: an enemy with move speed 0 (only 圣徒像, a hidden-group statue) never reaches the exit and
        // would keep the fight from ending: left out.
        if (!(t.speed > 0)) { skipped.push({ key, wave: wi, frag: fi, count: a.count, reason: 'move speed 0' }); continue; }
        // ASSUMPTION: an enemy on a FLY route flies (6 spawn actions put a WALK enemy on a FLY route).
        const fly = t.motion === 'FLY' || route.motionMode === 'FLY';
        for (let k = 0; k < a.count; k++) {
          const off = (a.preDelay || 0) + k * (a.interval || 0), spawn = fragStart + off, path = pathOf(a, route, t, fly, off);
          out.push({ ...t, id: 0, motion: fly ? 'FLY' : 'WALK', wave: wi, frag: fi, group: a.randomSpawnGroupKey || null, spawn, waveT: spawn - waveStart,
            path, leaveAt: spawn + path[path.length - 1].t, dontBlockWave: !!a.dontBlockWave, bonus: !!(bonus && bonus.wave_index === wi && (bonus.frag_index === -1 || bonus.frag_index === fi)) });
          lastSpawn = Math.max(lastSpawn, spawn);
        }
      }
      clock = timing === 'afterLast' ? fragStart + span : fragStart;
    });
    const end = timing === 'afterLast' ? clock : lastSpawn;
    waveSpans.push(end - waveStart);
    for (let k = first; k < out.length; k++) out[k].waveSpan = end - waveStart;
    waveStart = end + (wave.postDelay || 0);
  });
  out.sort((a, b) => a.spawn - b.spawn);          // stable: ties keep script order
  out.forEach((e, i) => { e.id = i; });
  Object.defineProperty(out, 'meta', { value: { seed: opts.seed ?? 1, fragmentTiming: timing, hiddenGroups: opts.includeHidden ? 'all' : [...sys.on], skipped, waveSpans } });
  return out;
}

const SAMPLES = new WeakMap();
function preparedEnemies(stage, opts) {
  let m = SAMPLES.get(stage);
  if (!m) SAMPLES.set(stage, m = new Map());
  const key = JSON.stringify([opts.tps > 0 ? opts.tps : TPS_DEFAULT, opts.seed ?? 1, !!opts.includeHidden, !!opts.elite, opts.secrecy || 0, opts.floor || 1, opts.fragmentTiming || FRAGMENT_TIMING_DEFAULT, opts.enemyMods || [], opts.secrecyOpts || null]);
  let e = m.get(key);
  if (!e) { if (m.size >= SAMPLE_CACHE_MAX) m.clear(); m.set(key, e = sampleEnemies(stage, opts)); }
  return e;
}

// Typed, read-only view of an enemy list, cached per list: simulate never mutates enemy objects, and callers must
// not mutate a list (or a profile range) they have already simulated with.
const PATHS = new WeakMap(), COMPILED = new WeakMap();
function compilePath(path) {
  let p = PATHS.get(path);
  if (p) return p;
  const n = path.length;
  p = { T: new Float64Array(n), R: new Float64Array(n), C: new Float64Array(n), H: new Uint8Array(n) };
  for (let i = 0; i < n; i++) { p.T[i] = path[i].t; p.R[i] = path[i].r; p.C[i] = path[i].c; p.H[i] = path[i].hidden ? 1 : 0; }
  PATHS.set(path, p);
  return p;
}
function compileEnemies(enemies, stage) {
  let E = COMPILED.get(enemies);
  if (E && E.stage === stage && E.n === enemies.length) return E;
  const n = enemies.length, f = () => new Float64Array(n);
  E = { n, stage, ids: new Array(n), hp0: f(), atk: f(), def: f(), res: f(), resK: f(), interval: f(), life: f(), rr2: f(), taken: f(), end: f(), waveT: f(),
    hits: f(), mode: new Uint8Array(n), arts: new Uint8Array(n), fly: new Uint8Array(n), gate: new Uint8Array(n), tcode: new Uint8Array(n), wave: new Int32Array(n),
    pT: new Array(n), pR: new Array(n), pC: new Array(n), pH: new Array(n), hpTotal: 0, lifeTotal: 0, nW: 0 };
  // script length per wave (sampleEnemies meta, also for waves without enemies); hand-made lists: from the spawns
  const ms = enemies.meta && Array.isArray(enemies.meta.waveSpans) ? enemies.meta.waveSpans : [];
  for (const e of enemies) E.nW = Math.max(E.nW, (e.wave | 0) + 1);
  E.nW = Math.max(E.nW, ms.length);
  // Lists without waveT (hand-made): wave k is taken to start at the last spawn of the earlier waves.
  const lastSpawn = new Float64Array(E.nW), nomStart = new Float64Array(E.nW);
  for (const e of enemies) lastSpawn[e.wave | 0] = Math.max(lastSpawn[e.wave | 0], e.spawn || 0);
  for (let k = 1; k < E.nW; k++) nomStart[k] = Math.max(nomStart[k - 1], lastSpawn[k - 1]);
  E.wSpan = new Float64Array(E.nW); E.wPost = new Float64Array(E.nW); E.wMax = new Float64Array(E.nW).fill(-1); E.wCount = new Int32Array(E.nW);
  const leave = new Float64Array(E.nW), waves = stage.mc && Array.isArray(stage.mc.waves) ? stage.mc.waves : [];
  for (let i = 0; i < n; i++) {
    const e = enemies[i], w = e.wave | 0;
    if (!Array.isArray(e.path) || !e.path.length || !(e.hp > 0)) throw new Error(`sim: enemy #${i} (${e.name || e.key}) needs hp > 0 and a path`);
    const p = compilePath(e.path);
    E.ids[i] = e.id ?? i; E.pT[i] = p.T; E.pR[i] = p.R; E.pC[i] = p.C; E.pH[i] = p.H; E.end[i] = p.T[p.T.length - 1];
    E.hp0[i] = e.hp; E.atk[i] = e.atk || 0; E.def[i] = Math.max(0, e.def || 0); E.res[i] = e.res || 0; E.resK[i] = 1 - Math.min(100, Math.max(0, e.res || 0)) / 100;
    E.interval[i] = e.interval || 0; E.life[i] = e.life ?? 1; E.taken[i] = e.damageTaken ?? 1; E.hits[i] = e.hits || 1;
    E.fly[i] = e.motion === 'FLY' ? 1 : 0; E.arts[i] = e.damageType === 'arts' ? 1 : 0; E.tcode[i] = e.type === 'BOSS' ? 2 : e.type === 'ELITE' ? 1 : 0;
    E.rr2[i] = e.rangeRadius > 0 ? e.rangeRadius * e.rangeRadius : -1;
    let mode = e.attackMode in MODE ? MODE[e.attackMode] : !e.applyWay ? 1 : e.applyWay === 'NONE' ? 0 : e.applyWay === 'MELEE' ? 1 : 2;
    if (!(E.atk[i] > 0) || !(E.interval[i] > 0)) mode = 0;
    if (mode === 2 && E.rr2[i] < 0) mode = 1;
    E.mode[i] = mode;
    E.wave[i] = w; E.waveT[i] = Math.max(0, e.waveT ?? (e.spawn || 0) - nomStart[w]); E.gate[i] = e.dontBlockWave ? 0 : 1;
    E.wSpan[w] = Math.max(E.wSpan[w], E.waveT[i], e.waveSpan > 0 ? e.waveSpan : 0); E.wCount[w] += E.gate[i]; leave[w] = Math.max(leave[w], E.waveT[i] + E.end[i]);
    E.hpTotal += e.hp; E.lifeTotal += E.life[i];
  }
  E.bound = 0;
  for (let k = 0; k < E.nW; k++) {
    if (ms[k] > E.wSpan[k]) E.wSpan[k] = ms[k];
    if (waves[k]) { E.wPost[k] = waves[k].postDelay || 0; E.wMax[k] = waves[k].maxTimeWaitingForNextWave ?? -1; }
    E.bound += Math.max(leave[k], E.wSpan[k]) + E.wPost[k];
  }
  E.order = Int32Array.from(enemies.map((_, i) => i).sort((a, b) => E.wave[a] - E.wave[b] || E.waveT[a] - E.waveT[b] || a - b));
  COMPILED.set(enemies, E);
  return E;
}

// ---------- operators ----------
// Internal profile: defaults filled in, per-hit attack precomputed. Injected profiles are never mutated.
const PROFILES = new WeakMap();
function normProfile(p, op) {
  let q = PROFILES.get(p);
  if (q) return q;
  const dcode = DCODE[p.damageType ?? op.damageType] ?? NONE, interval = p.interval ?? op.interval, atk = p.atk ?? op.atk ?? 0;
  const ty = p.atkScaleByType, bh = p.bonusHit, th = p.thorns, dr = p.hpDrain, dot = p.dot;
  q = { hp: p.hp ?? op.hp ?? 1, def: Math.max(0, p.def ?? op.def ?? 0), resK: 1 - Math.min(100, Math.max(0, p.res ?? op.res ?? 0)) / 100,
    block: (p.block ?? op.block ?? 0) | 0, interval, dcode, targets: p.targets ?? op.targets ?? 1, canHitAir: !!(p.canHitAir ?? op.canHitAir),
    range: p.range || op.range || [], atk, dmg: atk * (p.atkScale ?? 1), hits: p.hits ?? 1,
    attacks: p.attacks !== false && dcode !== NONE && interval > 0,
    // Optional fields, honoured because each costs a few lines: healScale (multiplier on a heal), hpDrainPerSec (flat
    // HP lost per second while this profile is current), damageTaken (multiplier on damage received), and from the
    // skills.js header: atkScaleByType {ELITE, BOSS} (multiplier on ATK-based damage vs those types), hitsByTarget
    // (hits on the k-th target), bonusHit {scale, damageType} (one extra hit of scale x ATK per target attacked),
    // resIgnore (flat RES ignored by arts hits), damageNegateProb, thorns {scale, damageType} (scale x ATK back at
    // every enemy attack received), hpRegenPerSec, prefersAir (FLY targets first), hpDrain {ratioPerSec,
    // rampSeconds}, deathDelay, dot {dps, dpsVsRanged, duration, damageType} (applied on every target hit),
    // idleRegen {delay, ratioPerSec}, defIgnoreRamp {perHit, max, resetAfter}, aura {mods, artsDodge} (read by the
    // team refresh in simulate, with spec.teamMods and spec.stacking).
    // Ignored: atkScaleMelee (whether one lord attack is melee or ranged is not in the data), proc (its random
    // target), onHitDebuff (whether its flat arts bonus is added before or after RES, and to which sources).
    healScale: p.healScale ?? 1, drainFlat: p.hpDrainPerSec || 0, taken: p.damageTaken ?? 1,
    byType: ty ? [1, ty.ELITE ?? 1, ty.BOSS ?? 1] : null,
    hitsBy: Array.isArray(p.hitsByTarget) && p.hitsByTarget.length ? p.hitsByTarget : null,
    bonus: bh && bh.scale > 0 ? { dmg: atk * bh.scale, dcode: DCODE[bh.damageType] ?? ARTS } : null,
    resIgnore: p.resIgnore > 0 ? p.resIgnore : 0,
    negate: p.damageNegateProb > 0 ? Math.min(1, p.damageNegateProb) : 0,
    thorns: th && th.scale > 0 ? { dmg: atk * th.scale, dcode: DCODE[th.damageType] ?? PHYS } : null,
    regen: p.hpRegenPerSec > 0 ? p.hpRegenPerSec : 0,
    air: !!p.prefersAir,
    drain: dr && dr.ratioPerSec > 0 ? { ratio: dr.ratioPerSec, ramp: dr.rampSeconds > 0 ? dr.rampSeconds : 0 } : null,
    deathDelay: p.deathDelay > 0 ? p.deathDelay : 0,
    dot: dot && dot.dps > 0 && dot.duration > 0 ? { dps: dot.dps, dpsR: dot.dpsVsRanged ?? dot.dps, dur: dot.duration, dcode: DCODE[dot.damageType] ?? ARTS } : null,
    idle: p.idleRegen && p.idleRegen.ratioPerSec > 0 ? { delay: p.idleRegen.delay > 0 ? p.idleRegen.delay : 0, ratio: p.idleRegen.ratioPerSec } : null,
    ramp: p.defIgnoreRamp && p.defIgnoreRamp.perHit > 0 ? { per: p.defIgnoreRamp.perHit, max: p.defIgnoreRamp.max > 0 ? p.defIgnoreRamp.max : Infinity, reset: p.defIgnoreRamp.resetAfter > 0 ? p.defIgnoreRamp.resetAfter : Infinity } : null,
    aura: p.aura && ((Array.isArray(p.aura.mods) && p.aura.mods.length) || p.aura.artsDodge > 0) ? p.aura : null };
  PROFILES.set(p, q);
  return q;
}

// ---------- team effects: talents of one operator that change another one's profile ----------
// spec.teamMods (skills.js: "在场时，所有【X】干员…" talents, the bearer's own part already folded in): apply to every
// OTHER planned operator matching `when` while the bearer is on the field. spec.stacking (塞雷娅 "每在场上停留N秒…最多
// 叠加M层"): floor(seconds on the field / every) stacks, at most max. profile.aura: to every operator whose tile is in
// the bearer's current range. Stat mods are folded in through skills.profiles(op, spec, {stacks, extraMods}) (so they
// share the pct bucket of the receiver's talents and skill, as skills.js does); hpRegenPerSec and artsDodge are
// simulator-side. Operators with injected op.profiles (or a skillApi without profiles) only get the simulator-side part.
const TEAM_STATS = new Set(['hp', 'atk', 'def', 'res', 'block', 'attackSpeed', 'baseAttackTime']);
// same semantics as operators.matchWhen: every key equals the unit's field (an array = any of), `all` always matches
const whenOk = (when, unit) => !when || Object.keys(when).every(k => k === 'all' || (Array.isArray(when[k]) ? when[k].includes(unit[k]) : when[k] === unit[k]));
// Variant keys name each source by the identity of its modifier object (a teamMods list, an aura), never by its plan
// index: the variant cache lives on the operator's kit and outlives one plan.
const OBJ_IDS = new WeakMap();
let objSeq = 0;
const objId = a => { let id = OBJ_IDS.get(a); if (id === undefined) OBJ_IDS.set(a, id = ++objSeq); return id; };
// The kit of `op` with these team modifiers and stacks, cached on the kit per key.
function variantOf(k, op, key, stacks, extra) {
  let v = k.variants.get(key);
  if (!v) {
    const pr = k.api.profiles(op, k.raw, { stacks, extraMods: extra });
    v = { base: normProfile(pr.base, op), active: normProfile(pr.active || pr.base, op), stages: k.stages && Array.isArray(pr.stages) && pr.stages.length ? pr.stages.map(s => normProfile(s, op)) : null };
    k.variants.set(key, v);
  }
  return v;
}

// Skill spec + profiles of an operator: op.skillSpec / op.profiles if present (CONTRACT 6 injection points),
// otherwise skills.compileSkill / skills.profiles; without skills.js the operator's own stats, no skill.
const KITS = new WeakMap();
function kitOf(op, api) {
  let k = KITS.get(op);
  if (k && k.specRef === op.skillSpec && k.profRef === op.profiles && k.api === api) return k;
  const spec = op.skillSpec !== undefined ? op.skillSpec : api && api.compileSkill ? api.compileSkill(op) : null;
  const pr = op.profiles || (spec && api && api.profiles ? api.profiles(op, spec) : null);
  // unsupported = no skill (CONTRACT 4); a PASSIVE has no SP automaton (the base profile already holds its effect)
  // unless spec.onDeploy (skills.js: "部署后…" passives, active for spec.duration from the deployment).
  // profiles.stages (skills.js, 棘刺 S3): the active profile of the n-th use is stages[min(n, length) - 1].
  const live = !!spec && spec.fidelity !== 'unsupported' && (spec.trigger === 'MANUAL' || spec.trigger === 'AUTO' || !!spec.onDeploy);
  // raw: the compiled spec even when it is not live (its talents still carry teamMods / squad / stacking);
  // dyn: profiles can be rebuilt with team modifiers (skills.profiles available, no injected op.profiles).
  k = { specRef: op.skillSpec, profRef: op.profiles, api, spec: live ? spec : null, raw: spec || null,
    dyn: !!spec && !op.profiles && !!(api && api.profiles), variants: new Map(),
    base: normProfile(pr && pr.base ? pr.base : op, op), active: normProfile(pr && pr.active ? pr.active : pr && pr.base ? pr.base : op, op),
    stages: live && pr && Array.isArray(pr.stages) && pr.stages.length ? pr.stages.map(s => normProfile(s, op)) : null };
  KITS.set(op, k);
  return k;
}

// Rotated range as a bitmap over tile ids, cached per (range array, map size, tile, direction).
const MASKS = new WeakMap();
function maskFor(S, range, r, c, dirIdx) {
  let m = MASKS.get(range);
  if (!m) MASKS.set(range, m = new Map());
  const key = ((S.H * 64 + S.W) * 4096 + r * S.W + c) * 4 + dirIdx;
  let b = m.get(key);
  if (b) return b;
  b = new Uint8Array(S.H * S.W);
  for (const o of range) {
    let y = o.dr, x = o.dc;
    for (let k = 0; k < dirIdx; k++) { const ny = x; x = -y; y = ny; }       // CONTRACT 1: (dr, dc) -> (dc, -dr) per step E->S->W->N
    const rr = r + y, cc = c + x;
    if (rr >= 0 && cc >= 0 && rr < S.H && cc < S.W) b[rr * S.W + cc] = 1;
  }
  m.set(key, b);
  return b;
}

// ---------- the simulation ----------
// Tick at time T (state = the world at T): waves and spawns -> retreats -> deploys -> operators (skill start,
// attack, SP/duration tick) -> enemies (attack, then move dt in free time, leak, get blocked) -> DP.
// Extra opts: enemies, skillApi (the six SP-automaton functions, replaces skills.js), modApi, fragmentTiming,
// stopOnDefeat, secrecyOpts, rules (collectible {rule} entries: deployLimit, meleeOnHighGround), strictSkills,
// noSkills (no skill is ever started), squad (operator objects of the squad, for spec.squad.initialDp).
// Extra result fields: alive, timedOut, lifePoints, dp.initial, dp.refunded.
function simulate(stage, plan, opts) {
  opts = opts || {}; plan = plan || {};
  const S = stageInfo(stage), W = S.W, H = S.H;
  const dt = opts.dt > 0 ? opts.dt : DT_DEFAULT;
  const enemies = opts.enemies || preparedEnemies(stage, opts);
  const E = compileEnemies(enemies, stage), nE = E.n;
  const limit = deployLimit(stage, opts);
  const api = opts.skillApi || lazy('skills');
  const list = plan.deploys || [], nD = list.length, skillPlan = plan.skills || {};
  const lifePoints = opts.lifePoints ?? stage.lifePoints ?? LIFE_POINTS_DEFAULT;
  const maxTime = opts.maxTime > 0 ? opts.maxTime : E.bound * MAXTIME_FACTOR + MAXTIME_PAD;
  const tr = opts.trace ? { sampleDt: Math.max(1, Math.round(TRACE_SAMPLE_DT / dt)) * dt, frames: [], events: [] } : null;
  const sampleEvery = Math.max(1, Math.round(TRACE_SAMPLE_DT / dt));

  // ---- static validation (throws before anything is simulated) and operator slots ----
  const retreats = (plan.retreats || []).map(x => ({ name: x.op && x.op.name ? x.op.name : x.op, t: x.t || 0 })).sort((a, b) => a.t - b.t);
  const retreating = new Set(retreats.map(x => x.name)), byName = new Map(), tileOwner = new Map(), ops = new Array(nD);
  for (let i = 0; i < nD; i++) {
    const d = list[i], op = d && d.op;
    if (!op || typeof op.name !== 'string') throw new Error(`illegal deploy #${i}: no operator object`);
    const where = `illegal deploy #${i} (${op.name} at r${d.r} c${d.c})`;
    if (!(d.dir in DIRS)) throw new Error(`${where}: dir must be E, S, W or N`);
    if (!(op.cost >= 0)) throw new Error(`${where}: operator has no cost`);
    const err = deployError(stage, op, d.r, d.c, null, opts);
    if (err) throw new Error(`${where}: ${err}`);
    if (byName.has(op.name)) throw new Error(`${where}: operator reused (already deploy #${byName.get(op.name).i})`);
    const tile = d.r * W + d.c, prev = tileOwner.get(tile);
    // a tile may be planned twice only if its first occupant has a planned retreat (the deploy then waits for it)
    if (prev !== undefined && !retreating.has(ops[prev].name)) throw new Error(`${where}: tile occupied by deploy #${prev} (${ops[prev].name})`);
    // opts.noSkills: no skill is ever started (MANUAL, AUTO and onDeploy alike); the base profile, with talents and
    // always-on passive skills folded in, is kept.
    const kit = kitOf(op, api), spec = opts.noSkills ? null : kit.spec, dirIdx = DIRS[d.dir];
    if (spec && !(api && api.skillInit && api.skillTick && api.skillReady && api.skillActivate)) throw new Error(`sim: combat/skills.js (or opts.skillApi) is needed to run the skill of ${op.name}`);
    let pol = spec && spec.trigger === 'AUTO' ? 'asap' : skillPlan[op.name] === undefined ? 'asap' : skillPlan[op.name], times = null;
    if (Array.isArray(pol)) { times = pol.slice().sort((a, b) => a - b); pol = 'times'; }
    else if (pol === null || pol === false) pol = 'never';
    else if (typeof pol === 'string' ? pol !== 'asap' && pol !== 'never' : typeof pol !== 'object') throw new Error(`illegal skill entry for ${op.name}: use "asap", "never", a list of times, or {minEnemiesInRange, minHpInRange, notBefore}`);
    ops[i] = { i, name: op.name, r: d.r, c: d.c, tile, dir: d.dir, dirIdx, t: d.t || 0, cost: op.cost, on: false, gone: false,
      spec, ss: null, pol, times, tIdx: 0, hitSp: !!spec && spec.spType === 'HIT',
      // skillOnAttack: ATTACK-type SP, and ammo skills (skills.js spec.ammo: the use ends after that many attacks)
      onAtk: !!spec && (spec.spType === 'ATTACK' || spec.ammo > 0),
      dpRate: spec && spec.dpOverDuration > 0 && spec.duration > 0 ? spec.dpOverDuration / spec.duration : 0,
      base: kit.base, active: kit.active, mBase: maskFor(S, kit.base.range, d.r, d.c, dirIdx), mAct: maskFor(S, kit.active.range, d.r, d.c, dirIdx),
      stages: kit.stages, mStages: kit.stages ? kit.stages.map(p => maskFor(S, p.range, d.r, d.c, dirIdx)) : null, ap: kit.active, am: null,
      cur: kit.base, mask: null, isActive: false, hp: 0, cap: 0, canBlock: !S.high[tile], nextAt: 0, blocked: [], use: null, useStart: 0, healStamp: 0,
      dieAt: 0, delayUsed: false, op, kit, useK: -1, depT: 0, lastAtk: 0, pen: 0,
      // team effects (see variantOf): stacks, current key, sources, simulator-side regen and arts dodge
      stackEvery: kit.dyn && kit.raw.stacking && kit.raw.stacking.every > 0 ? kit.raw.stacking.every : 0, stackMax: kit.raw && kit.raw.stacking ? kit.raw.stacking.max : 0,
      stacks: 0, key: null, srcs: [], teamRegen: 0, dodge: 0, dyn: false,
      stats: { name: op.name, damage: 0, healing: 0, kills: 0, blockedSeconds: 0, damageTaken: 0, skillUptime: 0, died: false } };
    byName.set(op.name, ops[i]); tileOwner.set(tile, i);
  }
  for (const x of retreats) if (!byName.has(x.name)) throw new Error(`illegal retreat: ${x.name} is not in plan.deploys`);
  // team sources: teamMods of every other planned operator that match this one; aura bearers
  const auraOps = [];
  for (const o of ops) {
    const k = o.kit;
    if ([k.base, k.active].concat(k.stages || []).some(p => p.aura)) auraOps.push(o.i);
    for (const b of ops) {
      if (b === o || !b.kit.raw || !Array.isArray(b.kit.raw.teamMods)) continue;
      const src = { j: b.i, id: objId(b.kit.raw.teamMods), mods: [], regen: 0 };
      for (const m of b.kit.raw.teamMods) {
        if (!m || !whenOk(m.when, o.op)) continue;
        if (m.stat === 'hpRegenPerSec' && m.op === 'add') src.regen += m.value;
        else if (TEAM_STATS.has(m.stat)) src.mods.push({ stat: m.stat, op: m.op, value: m.value, source: m.source });
      }
      if (src.mods.length || src.regen) o.srcs.push(src);
    }
  }
  for (const o of ops) {
    o.dyn = o.kit.dyn && (o.stackEvery > 0 || o.srcs.some(s => s.mods.length) || auraOps.length > 0);
    if (o.dyn && o.stackEvery === 0) o.key = '0|';       // the plain kit is the variant without sources
  }
  // squad talents (spec.squad.initialDp): opts.squad (operator objects) or the planned operators
  let squadDp = 0;
  for (const op of Array.isArray(opts.squad) ? opts.squad : list.map(d => d.op)) {
    const k = op ? kitOf(op, api) : null;
    if (k && k.raw && k.raw.squad && k.raw.squad.initialDp > 0) squadDp += k.raw.squad.initialDp;
  }
  for (const name of Object.keys(skillPlan)) if (!byName.has(name) && opts.strictSkills) throw new Error(`illegal skill entry: ${name} is not in plan.deploys`);

  // ---- state (allocated once per call; nothing is allocated per tick unless opts.trace) ----
  const hp = Float64Array.from(E.hp0), tau = new Float64Array(nE), er = new Float64Array(nE), ec = new Float64Array(nE), eNext = new Float64Array(nE);
  const seg = new Int32Array(nE), tile = new Int32Array(nE).fill(-1), blocker = new Int16Array(nE).fill(-1), act = new Int32Array(nE), apos = new Int32Array(nE);
  const hid = new Uint8Array(nE), est = new Uint8Array(nE);       // est: 0 not spawned, 1 on the field, 2 killed, 3 leaked
  const dotEnd = new Float64Array(nE), dotDps = new Float64Array(nE), dotSrc = new Int16Array(nE), dotCode = new Uint8Array(nE);
  const tg = new Int32Array(Math.max(1, nE)), tgRem = new Float64Array(Math.max(1, nE));
  const blockerAt = new Int16Array(H * W).fill(-1), occupied = new Uint8Array(H * W), wLeft = Int32Array.from(E.wCount);
  const field = [], deployed = [], uses = [], losses = [];
  let nAct = 0, kills = 0, leaks = 0, lifeLost = 0, hpRemoved = 0, lastT = 0, timedOut = false, healStamp = 0;
  let dp = Math.min(S.maxCost, S.initialCost + squadDp), gen = 0, spent = 0, refunded = 0, dirty = false;
  const dpStart = dp, dpRate = 1 / (S.costTime > 0 ? S.costTime : 1);
  const addDp = x => { const v = dp + x > S.maxCost ? S.maxCost : dp + x; if (v > dp) { gen += v - dp; dp = v; } };

  // position of enemy i at its free time tau[i]; false = it reached the end of its path
  const place = i => {
    const T = E.pT[i], last = T.length - 1, tu = tau[i];
    let k = seg[i];
    while (k < last && tu + EPS >= T[k + 1]) k++;     // EPS: tau is a sum of dt steps (0.1 x 100 < 10 in floats)
    if (k >= last) return false;
    seg[i] = k;
    // hidden leg (DISAPPEAR ... APPEAR teleport): not on the map, so neither targetable nor blockable
    if (E.pH[i][k]) { hid[i] = 1; tile[i] = -1; return true; }
    const f = (tu - T[k]) / (T[k + 1] - T[k]), R = E.pR[i], C = E.pC[i];
    const y = R[k] + (R[k + 1] - R[k]) * f, x = C[k] + (C[k + 1] - C[k]) * f, ty = (y + 0.5) | 0, tx = (x + 0.5) | 0;
    er[i] = y; ec[i] = x; hid[i] = 0;
    tile[i] = y > -0.5 && x > -0.5 && ty < H && tx < W ? ty * W + tx : -1;     // tile = rounded position
    return true;
  };
  const resolve = (i, state, t) => {             // enemy leaves the field: 2 killed, 3 leaked
    est[i] = state; lastT = t;
    const p = apos[i], l = act[--nAct];
    act[p] = l; apos[l] = p;
    const b = blocker[i];
    if (b >= 0) { const bl = ops[b].blocked; bl.splice(bl.indexOf(i), 1); blocker[i] = -1; }
    if (E.gate[i]) wLeft[E.wave[i]]--;
  };
  const leak = (i, t) => { resolve(i, 3, t); leaks++; lifeLost += E.life[i]; if (tr) tr.events.push({ t: r3(t), type: 'leak', id: E.ids[i] }); };
  const setProfile = (o, p, mask) => {
    const oldMax = o.cur.hp;
    o.cur = p; o.mask = mask;
    // ASSUMPTION: a max-HP gain is added to current HP; a loss only clamps it.
    if (p.hp > oldMax) o.hp += p.hp - oldMax; else if (o.hp > p.hp) o.hp = p.hp;
    o.cap = o.canBlock ? p.block : 0;
    // ASSUMPTION: when the block count drops, the enemies blocked last are released first.
    while (o.blocked.length * BLOCK_PER_ENEMY > o.cap) blocker[o.blocked.pop()] = -1;
  };
  const opDown = (o, cause, t) => {              // frees the tile, the deploy slot and the blocked enemies
    o.on = false; o.gone = true; field.splice(field.indexOf(o.i), 1); occupied[o.tile] = 0; blockerAt[o.tile] = -1;
    for (let j = 0; j < o.blocked.length; j++) blocker[o.blocked[j]] = -1;
    o.blocked.length = 0; o.isActive = false;
    if (o.use) { o.use.end = r3(t); o.use = null; }
    if (cause === 'died') { o.stats.died = true; o.hp = 0; }
    dirty = true;                                // team effects of and on this operator change
    losses.push({ name: o.name, t: r3(t), cause });
    if (tr) tr.events.push({ t: r3(t), type: 'opDown', name: o.name, cause });
  };
  // HANDOFF damage formulas, inline. ri: flat RES ignored by arts damage (profile.resIgnore); di: flat DEF ignored by
  // physical damage (profile.defIgnoreRamp).
  const hitEnemy = (o, i, atk, dcode, t, ri, di) => {
    const k = dcode === ARTS && ri > 0 ? 1 - Math.min(100, Math.max(0, E.res[i] - ri)) / 100 : E.resK[i];
    let d = dcode === PHYS ? Math.max(atk - (di > 0 ? Math.max(0, E.def[i] - di) : E.def[i]), atk * MIN_DAMAGE_RATIO) : dcode === ARTS ? Math.max(atk * k, atk * MIN_DAMAGE_RATIO) : atk;
    d *= E.taken[i];
    if (d >= hp[i]) {
      d = hp[i]; hp[i] = 0; resolve(i, 2, t); kills++; o.stats.kills++;
      if (tr) tr.events.push({ t: r3(t), type: 'kill', id: E.ids[i], name: o.name });
    } else hp[i] -= d;
    hpRemoved += d; o.stats.damage += d;
  };
  // Operator o loses d HP (enemy: counts as damageTaken). Returns true when o left the field. deathDelay: see top.
  const hurt = (o, d, t, enemy) => {
    if (o.dieAt > 0) d = Math.min(d, Math.max(0, o.hp - 1));
    if (d < o.hp) { o.hp -= d; if (enemy) o.stats.damageTaken += d; return false; }
    if (o.cur.deathDelay > 0 && !o.delayUsed) {
      if (enemy) o.stats.damageTaken += Math.max(0, o.hp - 1);
      o.hp = 1; o.delayUsed = true; o.dieAt = t + o.cur.deathDelay;
      return false;
    }
    if (enemy) o.stats.damageTaken += o.hp;
    opDown(o, 'died', t);
    return true;
  };
  const hitOp = (i, o, t) => {                   // enemy i hits operator o: physical vs DEF, arts (tomimi atk_type) vs RES
    const a = E.atk[i], p = o.cur;
    // o.dodge: arts dodge from auras (夜莺 S3), as an expected value
    const d = (E.arts[i] ? Math.max(a * p.resK, a * MIN_DAMAGE_RATIO) * (1 - o.dodge) : Math.max(a - p.def, a * MIN_DAMAGE_RATIO)) * E.hits[i] * p.taken * (1 - p.negate);
    if (o.hitSp) for (let h = 0; h < E.hits[i]; h++) api.skillOnHit(o.spec, o.ss);
    if (p.thorns) hitEnemy(o, i, p.thorns.dmg * (p.byType ? p.byType[E.tcode[i]] : 1), p.thorns.dcode, t, p.resIgnore);
    hurt(o, d, t, true);
  };
  const applyDot = (o, i, d, t) => {
    const dps = E.mode[i] === 2 ? d.dpsR : d.dps;
    if (dotEnd[i] > t + EPS && dps < dotDps[i]) return;
    dotEnd[i] = t + d.dur; dotDps[i] = dps; dotSrc[i] = o.i; dotCode[i] = d.dcode;
  };
  // Up to K targets for operator o inside `mask`, written to tg[]: what it blocks first, then by least remaining
  // path time to the exit (ASSUMPTION: no other priority; ties by spawn order); FLY first with prefersAir (pa).
  // FLY needs canHitAir (air).
  const pick = (o, K, mask, air, pa) => {
    if (K > nE) K = nE;
    let n = 0;
    const bl = o.blocked, oi = o.i;
    for (let j = 0; j < bl.length && n < K; j++) tg[n++] = bl[j];
    if (n >= K) return n;
    const nb = n;
    for (let a = 0; a < nAct; a++) {
      const i = act[a], t = tile[i];
      if (t < 0 || !mask[t] || blocker[i] === oi || (E.fly[i] && !air)) continue;
      const rem = E.end[i] - tau[i] - (pa && E.fly[i] ? AIR_FIRST : 0);
      let j = n;
      if (n < K) n++;
      else if (rem > tgRem[n - 1] || (rem === tgRem[n - 1] && i > tg[n - 1])) continue;
      else j = n - 1;
      while (j > nb && (tgRem[j - 1] > rem || (tgRem[j - 1] === rem && tg[j - 1] > i))) { tg[j] = tg[j - 1]; tgRem[j] = tgRem[j - 1]; j--; }
      tg[j] = i; tgRem[j] = rem;
    }
    return n;
  };
  // Heals up to K of the most injured (lowest HP fraction) deployed operators standing in `mask`.
  // ASSUMPTION: a healer whose own tile is in its range can heal itself.
  const heal = (o, amount, K, mask) => {
    let n = 0;
    healStamp++;
    for (; n < K; n++) {
      let best = null, bf = 1 - 1e-9;
      for (let f = 0; f < field.length; f++) {
        const a = ops[field[f]];
        if (a.healStamp === healStamp || !mask[a.tile]) continue;
        const fr = a.hp / a.cur.hp;
        if (fr < bf) { bf = fr; best = a; }
      }
      if (!best) break;
      const h = Math.min(amount, best.cur.hp - best.hp);
      best.hp += h; best.healStamp = healStamp; o.stats.healing += h;
    }
    return n;
  };
  const endSkill = (o, t) => {
    o.isActive = false; setProfile(o, o.base, o.mBase); o.useK = -1;
    if (auraOps.length) dirty = true;            // range (and aura) of this operator changed
    if (o.use) { o.use.end = r3(t); o.use = null; }
    if (tr) tr.events.push({ t: r3(t), type: 'skillEnd', name: o.name });
  };
  // plan.skills semantics (CONTRACT 6): 'asap' | times, each used once in order | {minEnemiesInRange, minHpInRange,
  // notBefore}, counted in the ACTIVE profile's range; AUTO skills always fire. Extension: 'never'.
  const tryActivate = (o, time) => {
    const spec = o.spec, ss = o.ss, pol = o.pol;
    if (ss.active || (spec.trigger !== 'MANUAL' && spec.trigger !== 'AUTO') || !api.skillReady(spec, ss)) return;
    if (pol === 'never') return;
    if (pol === 'times') { if (o.tIdx >= o.times.length || time + EPS < o.times[o.tIdx]) return; }
    else if (pol !== 'asap') {
      if (pol.notBefore > 0 && time + EPS < pol.notBefore) return;
      if (pol.minEnemiesInRange > 0 || pol.minHpInRange > 0) {
        let n = 0, h = 0;
        const mask = o.mAct, air = o.active.canHitAir;
        for (let a = 0; a < nAct; a++) { const i = act[a], t = tile[i]; if (t >= 0 && mask[t] && (air || !E.fly[i])) { n++; h += hp[i]; } }
        if (n < (pol.minEnemiesInRange || 0) || h < (pol.minHpInRange || 0)) return;
      }
    }
    if (pol === 'times') o.tIdx++;
    const inst = api.skillActivate(spec, ss) || {};
    beginUse(o, time);
    // Instant part (CONTRACT 4 instant), scaled on the ATK of this use's active profile. Extensions read from
    // skills.js: damage.hits, damage.range / heal.range (facing east, rotated like the operator; default: the
    // active range), selfHeal {hpRatio} (heals the operator up to hpRatio x max HP).
    const ap = o.ap, am = o.am;
    if (inst.dp > 0) addDp(inst.dp);
    const dm = inst.damage;
    if (dm) {
      const code = DCODE[dm.damageType] ?? ap.dcode;
      if (code <= TRUE) {
        const n = pick(o, dm.targets || 1, Array.isArray(dm.range) ? maskFor(S, dm.range, o.r, o.c, o.dirIdx) : am, ap.canHitAir, ap.air), a = ap.atk * (dm.scale ?? 1), nh = dm.hits || 1;
        for (let j = 0; j < n; j++) { const i = tg[j], m = ap.byType ? ap.byType[E.tcode[i]] : 1; for (let h = 0; h < nh && est[i] === 1; h++) hitEnemy(o, i, a * m, code, time, ap.resIgnore); }
      }
    }
    const hl = inst.heal;
    if (hl) heal(o, ap.atk * (hl.scale ?? 1), Math.min(hl.targets || 1, field.length), Array.isArray(hl.range) ? maskFor(S, hl.range, o.r, o.c, o.dirIdx) : am);
    const sh = inst.selfHeal;
    if (sh && sh.hpRatio > 0 && o.on) { const want = Math.min(o.cur.hp, sh.hpRatio * o.cur.hp); if (want > o.hp) { o.stats.healing += want - o.hp; o.hp = want; } }
  };
  // A use starts (activation, or spec.onDeploy at deployment): record it and switch to its active profile.
  const beginUse = (o, time) => {
    const ss = o.ss, k = o.stages ? Math.min(Math.max(ss.uses | 0, 1), o.stages.length) - 1 : -1;
    o.ap = k >= 0 ? o.stages[k] : o.active; o.am = k >= 0 ? o.mStages[k] : o.mAct; o.useK = k;
    if (auraOps.length) dirty = true;
    uses.push(o.use = { name: o.name, skill: o.spec.name || o.spec.id || null, t: r3(time), end: null });
    o.useStart = time;
    if (tr) tr.events.push({ t: r3(time), type: 'skill', name: o.name });
    if (ss.active) { o.isActive = true; setProfile(o, o.ap, o.am); } else { o.use.end = o.use.t; o.use = null; }   // duration 0: instant
  };
  // Team effects (see variantOf), recomputed when the field, a skill state or a stack count changed. One pass is
  // enough: what an operator receives never changes its own range or aura.
  const refresh = () => {
    dirty = false;
    for (let f = 0; f < field.length; f++) {
      const o = ops[field[f]];
      let key = '', regen = 0, keep = 1, extra = null;
      for (const s of o.srcs) if (ops[s.j].on) {
        regen += s.regen;
        if (s.mods.length) { key += 't' + s.id + ','; (extra = extra || []).push(...s.mods); }
      }
      for (const j of auraOps) {
        const b = ops[j], au = b.on ? b.cur.aura : null;
        if (!au || !b.mask[o.tile] || (j === o.i && !AURA_INCLUDES_SOURCE)) continue;
        if (Array.isArray(au.mods) && au.mods.length) { key += 'a' + objId(au) + ','; (extra = extra || []).push(...au.mods); }
        if (au.artsDodge > 0) keep *= 1 - Math.min(1, au.artsDodge);
      }
      o.teamRegen = regen; o.dodge = 1 - keep;
      if (!o.dyn) continue;
      key = o.stacks + '|' + key;
      if (key === o.key) continue;
      o.key = key;
      const v = variantOf(o.kit, o.op, key, o.stacks, extra || []);
      o.base = v.base; o.active = v.active; o.stages = v.stages;
      o.mBase = maskFor(S, v.base.range, o.r, o.c, o.dirIdx); o.mAct = maskFor(S, v.active.range, o.r, o.c, o.dirIdx);
      o.mStages = v.stages ? v.stages.map(p => maskFor(S, p.range, o.r, o.c, o.dirIdx)) : null;
      if (o.isActive) { o.ap = o.useK >= 0 && o.stages ? o.stages[o.useK] : o.active; o.am = o.useK >= 0 && o.mStages ? o.mStages[o.useK] : o.mAct; setProfile(o, o.ap, o.am); }
      else setProfile(o, o.base, o.mBase);
    }
  };
  const frame = time => {
    const en = [], op = [];
    for (let i = 0; i < nE; i++) if (est[i] === 1 && !hid[i]) en.push([E.ids[i], r2(er[i]), r2(ec[i]), r3(hp[i] / E.hp0[i])]);
    for (let f = 0; f < field.length; f++) {
      const o = ops[field[f]];
      op.push([o.name, r3(o.hp / o.cur.hp), o.isActive, o.spec ? r3(Math.min(1, o.spec.spCost > 0 ? Math.max(0, o.ss.sp) / o.spec.spCost : 1)) : 0]);
    }
    tr.frames.push({ t: r3(time), dp: r2(dp), enemies: en, ops: op });
  };

  // ---- main loop ----
  let time = 0, wave = -1, wStart = 0, sp = 0, nextDep = 0, nextRet = 0;
  const order = E.order, pending = [];           // pending: due retreats whose operator is not on the field yet
  const anyStack = ops.some(o => o.stackEvery > 0);
  const startWave = (k, t) => { wave = k; wStart = t; if (tr) tr.events.push({ t: r3(t), type: 'wave', id: k }); };
  if (E.nW > 0) startWave(0, 0);
  for (let tick = 0; ; tick++) {
    time = tick * dt;
    if (kills + leaks === nE) { time = Math.min(time, lastT); break; }
    if (time + EPS >= maxTime || (opts.stopOnDefeat && lifeLost >= lifePoints)) { timedOut = time + EPS >= maxTime; break; }

    // 1. waves. Wave k+1 starts (its delays begin to count) only when the script of wave k has run out AND every
    //    enemy of wave k that blocks the wave is dead or leaked, or maxTimeWaitingForNextWave (> 0) after the
    //    script ran out; then postDelay. So spawn times are dynamic; enemy.spawn is only the nominal time.
    for (;;) {
      while (sp < nE && E.wave[order[sp]] === wave && wStart + E.waveT[order[sp]] <= time + EPS) {
        const i = order[sp++];
        est[i] = 1; apos[i] = nAct; act[nAct++] = i; seg[i] = 0;
        tau[i] = Math.max(0, time - wStart - E.waveT[i]);
        if (!place(i)) leak(i, time);
      }
      if (wave + 1 >= E.nW || (sp < nE && E.wave[order[sp]] === wave)) break;
      const done = wStart + E.wSpan[wave];
      if (time + EPS < done || (wLeft[wave] > 0 && !(E.wMax[wave] > 0 && time + EPS >= done + E.wMax[wave]))) break;
      startWave(wave + 1, time + E.wPost[wave]);
    }

    // 2. planned retreats: at the first tick >= t at which the operator is on the field
    while (nextRet < retreats.length && retreats[nextRet].t <= time + EPS) pending.push(byName.get(retreats[nextRet++].name));
    for (let j = 0; j < pending.length; j++) {
      const o = pending[j];
      if (o.on) { const back = Math.floor(o.cost * RETREAT_REFUND), v = Math.min(S.maxCost, dp + back); refunded += v - dp; dp = v; opDown(o, 'retreat', time); }
      if (o.gone) pending.splice(j--, 1);       // retreated just now, or died before its retreat
    }

    // 3. deploys, in list order: first tick with time >= t, enough DP, a free slot, a free tile
    while (nextDep < nD) {
      const o = ops[nextDep];
      if (time + EPS < o.t || dp + EPS < o.cost || field.length >= limit || occupied[o.tile]) break;
      nextDep++;
      dp -= o.cost; spent += o.cost; o.on = true; field.push(o.i); occupied[o.tile] = 1;
      o.cur = o.base; o.mask = o.mBase; o.hp = o.base.hp; o.cap = o.canBlock ? o.base.block : 0; o.nextAt = time; o.isActive = false;
      o.depT = time; o.lastAtk = time; o.pen = 0; o.stacks = 0; dirty = true;
      if (o.canBlock) blockerAt[o.tile] = o.i;
      deployed.push({ name: o.name, t: r3(time), r: o.r, c: o.c, dir: o.dir, cost: o.cost });
      if (tr) tr.events.push({ t: r3(time), type: 'deploy', name: o.name });
      if (o.spec) { o.ss = api.skillInit(o.spec); if (o.ss.active) beginUse(o, time); }   // spec.onDeploy: active from the deployment
    }
    // team effects: stacks reached this tick, then a refresh if anything changed
    if (anyStack) for (let f = 0; f < field.length; f++) {
      const o = ops[field[f]];
      if (o.stackEvery > 0) { const n = Math.min(o.stackMax, Math.floor((time - o.depT) / o.stackEvery + EPS)); if (n !== o.stacks) { o.stacks = n; dirty = true; } }
    }
    if (dirty) refresh();
    if (tr && tick % sampleEvery === 0) frame(time);

    // 4. operators, in deploy order
    for (let f = 0; f < field.length; f++) {
      const o = ops[field[f]];
      if (o.dieAt > 0 && time + EPS >= o.dieAt) { opDown(o, 'died', time); f--; continue; }   // deathDelay ran out
      if (o.spec) tryActivate(o, time);
      const p = o.cur;
      if (p.attacks && time + EPS >= o.nextAt) {
        let did = false;
        if (p.dcode === HEAL) did = heal(o, p.dmg * p.healScale, Math.min(p.targets, field.length), o.mask) > 0;
        else {
          const n = pick(o, p.targets, o.mask, p.canHitAir, p.air), hb = p.hitsBy, rp = p.ramp;
          did = n > 0;
          if (rp && time - o.lastAtk > rp.reset + EPS) o.pen = 0;      // defIgnoreRamp lost after resetAfter idle seconds
          for (let j = 0; j < n; j++) {
            const i = tg[j], m = p.byType ? p.byType[E.tcode[i]] : 1, nh = hb && j < hb.length ? hb[j] : p.hits;
            for (let h = 0; h < nh && est[i] === 1; h++) { hitEnemy(o, i, p.dmg * m, p.dcode, time, p.resIgnore, o.pen); if (rp) o.pen = Math.min(rp.max, o.pen + rp.per); }
            if (p.bonus && est[i] === 1) hitEnemy(o, i, p.bonus.dmg * m, p.bonus.dcode, time, p.resIgnore);
            if (p.dot && est[i] === 1) applyDot(o, i, p.dot, time);
          }
        }
        if (did) {
          // keep the phase while attacking back to back (exact average rate for any interval); restart it after idling
          o.nextAt = (time - o.nextAt < dt ? o.nextAt : time) + p.interval;
          o.lastAtk = time;
          if (o.onAtk) api.skillOnAttack(o.spec, o.ss);
        }
      }
      if (o.spec) {
        if (o.isActive) { o.stats.skillUptime += dt; if (o.dpRate) addDp(o.dpRate * dt); }
        if (api.skillTick(o.spec, o.ss, dt) === 'ended' || (o.isActive && !o.ss.active)) endSkill(o, time + dt);
      }
      const q = o.cur;                           // the profile after a skill that ended this tick
      const regen = q.regen + o.teamRegen + (q.idle && time + EPS >= o.lastAtk + q.idle.delay ? q.idle.ratio * q.hp : 0);
      if (regen > 0 && o.hp < q.hp) o.hp = Math.min(q.hp, o.hp + regen * dt);
      let drain = q.drainFlat;
      if (q.drain) drain += q.drain.ratio * q.hp * (q.drain.ramp > 0 && o.isActive ? Math.min(1, (time + dt - o.useStart) / q.drain.ramp) : 1);
      if (drain > 0 && hurt(o, drain * dt, time + dt, false)) f--;
    }
    if (dirty) refresh();                        // a skill that started or ended changes auras before enemies act

    // 5. enemies
    for (let a = 0; a < nAct; a++) {
      const i = act[a], b = blocker[i];
      if (dotEnd[i] > time + EPS) {             // poison (profile.dot) ticks wherever the enemy is
        hitEnemy(ops[dotSrc[i]], i, dotDps[i] * Math.min(dt, dotEnd[i] - time), dotCode[i], time, 0);
        if (est[i] !== 1) { a--; continue; }     // killed: the last active enemy moved into slot a
      }
      if (b >= 0) {                              // blocked: free time stands still, it attacks its blocker
        const o = ops[b];
        o.stats.blockedSeconds += dt;            // enemy-seconds held
        if (E.mode[i] && time + EPS >= eNext[i]) {
          eNext[i] = (time - eNext[i] < dt ? eNext[i] : time) + E.interval[i]; hitOp(i, o, time);
          if (est[i] !== 1) a--;                 // killed by thorns
        }
        continue;
      }
      // ASSUMPTION: a ranged enemy shoots the most recently deployed operator inside its Euclidean rangeRadius
      // (centre to centre) and keeps walking while it does.
      if (E.mode[i] === 2 && !hid[i] && field.length && time + EPS >= eNext[i]) {
        const rr = E.rr2[i], y = er[i], x = ec[i];
        for (let f = field.length - 1; f >= 0; f--) {
          const o = ops[field[f]], dy = o.r - y, dx = o.c - x;
          if (dy * dy + dx * dx <= rr) { eNext[i] = (time - eNext[i] < dt ? eNext[i] : time) + E.interval[i]; hitOp(i, o, time); break; }
        }
        if (est[i] !== 1) { a--; continue; }
      }
      tau[i] += dt;
      if (!place(i)) { leak(i, time + dt); a--; continue; }      // end of path; the last active enemy moved into slot a
      // A WALK enemy whose position (rounded to a tile) is on the tile of an operator with spare block is blocked.
      if (!E.fly[i] && tile[i] >= 0) {
        const b2 = blockerAt[tile[i]];
        if (b2 >= 0) { const o = ops[b2]; if ((o.blocked.length + 1) * BLOCK_PER_ENEMY <= o.cap) { o.blocked.push(i); blocker[i] = b2; } }
      }
    }

    // 6. DP: +1 every costIncreaseTime seconds, fractional, capped at maxCost
    addDp(dpRate * dt);
  }

  const duration = r3(time);
  // The fight ends with its last kill or leak: nothing is reported after that moment (a skill still running
  // ends with the fight). Events are stamped with the time they take effect and delivered in time order.
  for (const u of uses) if (u.end === null || u.end > duration) u.end = duration;
  for (const l of losses) if (l.t > duration) l.t = duration;
  if (tr) {
    tr.events = tr.events.filter(e => e.t <= duration + EPS).sort((a, b) => a.t - b.t);
    if (!(tr.frames.length && tr.frames[tr.frames.length - 1].t === duration)) frame(time);   // closing frame
  }
  const lifeLeft = Math.max(0, lifePoints - lifeLost), alive = nE - kills - leaks;
  // win = life left AND the stage is over (an enemy still alive at maxTime is a stall, not a win)
  const res = { win: lifeLeft > 0 && alive === 0, lifeLost, lifeLeft, leaks, kills, totalEnemies: nE, hpRemoved, hpTotal: E.hpTotal, duration, score: 0,
    deploys: deployed, skillUses: uses, losses,
    perOp: ops.map(o => { const s = o.stats; s.blockedSeconds = r6(s.blockedSeconds); s.skillUptime = r6(s.skillUptime); return s; }),
    dp: { generated: r6(gen), spent, endUnspent: r6(dp), initial: dpStart, refunded },
    alive, timedOut, lifePoints };
  res.score = scoreOf(res);
  if (tr) res.trace = tr;
  return res;
}

module.exports = { simulate, sampleEnemies, canDeploy, deployLimit, scoreOf, compareResults, TPS_DEFAULT,
  // extras
  deployError, stageSystem, mulberry32, EPS, DT_DEFAULT, TRACE_SAMPLE_DT, LIFE_POINTS_DEFAULT, RETREAT_REFUND, SECRECY_LIMIT_LEVEL,
  FRAGMENT_TIMING_DEFAULT, MIN_DAMAGE_RATIO, BLOCK_PER_ENEMY, MAXTIME_FACTOR, MAXTIME_PAD, AURA_INCLUDES_SOURCE };

// ---------- CLI: no-defence baseline and the enemy roster after mods ----------
if (require.main === module) {
  const argv = process.argv.slice(2), flag = (name, dflt) => { const k = argv.indexOf('--' + name); return k < 0 ? dflt : argv[k + 1]; };
  const which = argv.find((a, k) => !a.startsWith('--') && !(k > 0 && argv[k - 1].startsWith('--') && argv[k - 1] !== '--elite')) || '彼处水如酒';
  const opts = { secrecy: Number(flag('secrecy', 0)), floor: Number(flag('floor', 1)), elite: argv.includes('--elite'), seed: Number(flag('seed', 1)),
    tps: Number(flag('tps', TPS_DEFAULT)), fragmentTiming: flag('timing', FRAGMENT_TIMING_DEFAULT) };
  const st = sm.loadStage(which), enemies = sampleEnemies(st, opts);
  const t0 = process.hrtime.bigint(), res = simulate(st, { deploys: [] }, { ...opts, enemies }), ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${st.name} (${st.id})  ${st.H}x${st.W}  deploy limit ${deployLimit(st, opts)}  initial cost ${st.initialCost}`);
  console.log(`secrecy ${opts.secrecy}  floor ${opts.floor}  ${opts.elite ? 'elite (紧急作战)' : 'normal'}  seed ${opts.seed}  tps ${opts.tps}  fragmentTiming ${opts.fragmentTiming}  hidden groups on: ${[].concat(enemies.meta.hiddenGroups).join(', ') || 'none'}`);
  for (const s of enemies.meta.skipped) console.log(`  left out: ${s.count} x ${s.key} (${s.reason})`);
  console.log(`\nno-defence baseline (empty plan): ${res.totalEnemies} enemies, ${res.leaks} leak, ${res.kills} killed, life lost ${res.lifeLost}, fight lasts ${res.duration} s, ${Math.round(res.hpTotal)} HP in total  [simulated in ${ms.toFixed(1)} ms]`);
  const waves = new Map();
  for (const e of enemies) { const w = waves.get(e.wave) || { n: 0, first: Infinity, last: -Infinity }; w.n++; w.first = Math.min(w.first, e.spawn); w.last = Math.max(w.last, e.spawn); waves.set(e.wave, w); }
  for (const [k, w] of waves) console.log(`  wave ${k}: ${w.n} enemies, nominal spawns ${w.first.toFixed(1)}-${w.last.toFixed(1)} s (a wave starts only once the one before it is cleared)`);
  const by = new Map();
  for (const e of enemies) { const r = by.get(e.key) || { e, n: 0, first: e.spawn }; r.n++; by.set(e.key, r); }
  console.log('\nroster after mods:');
  for (const { e, n, first } of by.values()) {
    console.log(`  ${e.name.padEnd(10, '　')} x${String(n).padStart(3)}  HP ${String(Math.round(e.hp)).padStart(7)}  ATK ${String(Math.round(e.atk)).padStart(5)}  DEF ${String(Math.round(e.def)).padStart(5)}  RES ${String(Math.round(e.res)).padStart(3)}`
      + `  speed ${e.speed}  every ${r2(e.interval)}s  ${e.type.padEnd(6)} ${e.motion}  ${e.attackMode}${e.attackMode === 'none' ? '' : '/' + e.damageType}${e.attackMode === 'ranged' ? ' r' + e.rangeRadius : ''}`
      + `  life ${e.life}${e.damageTaken !== 1 ? '  dmg taken x' + e.damageTaken : ''}${e.bonus ? '  [bonus]' : ''}  first ${first.toFixed(0)}s`);
  }
}
