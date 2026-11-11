// combat/candidates.js: stage + operators + enemies -> the placement instance of CONTRACT section 7 (for optimize.js),
// plus the teaching primitives behind it: enemy heatmaps, 2D cross-correlation of a range mask with a heatmap (the
// "placement heatmap"), summed-area tables and exact seconds-in-range from the timed enemy paths.
// Usage: node combat/candidates.js [stage] [--K n] [--mode base|active|average] [--share] [--seed s]
//
// The surrogate (what pot[p][i] means): the damage placement p would deal to enemy i if i walked its path unblocked
// and p attacked it for every second it is in range. It knows nothing about DP timing, blocking, deploy order,
// operator deaths or team buffs; timeline.js closes that gap with sim.simulate.
'use strict';
const O = require('./operators.js');
const SK = require('./skills.js');
const sim = require('./sim.js');

// ---------- constants ----------
const DIRS = ['E', 'S', 'W', 'N'];
const ARROW = { E: '>', S: 'v', W: '<', N: '^' };
const EPS = 1e-9;
const K_DEFAULT = 6;                 // candidates kept per operator: search effort, not a game fact (untuned)
const POT_MODE_DEFAULT = 'average';
const POT_MODES = ['base', 'active', 'average'];
const DAMAGE_TYPES = new Set(['physical', 'arts', 'true']);
// CONTRACT 7 defines pot[p][i] = dps x seconds for every enemy independently, so a single-target operator is credited
// with hitting every enemy in its range at once. opts.targetShare = true caps that: at each instant with n enemies
// in range each one gets min(1, targets / n) of the operator's attacks (enemy spawns at their nominal times).
const TARGET_SHARE_DEFAULT = false;
// ASSUMPTION: (profile.dot, poison) counted as dot.dps on top of the hits for every second the enemy is in range
// (an operator in range keeps re-applying it); the tail after the enemy leaves the range is ignored (lower bound).
// RES applies to the per-second amount, as sim.js applies it per tick (exact for arts; physical dots do not occur).
// false = poison left out of pot.
const DOT_WHILE_IN_RANGE = true;
// ASSUMPTION: (profile.hitsByTarget, e.g. 蓝毒 S2 [2,1,1]) an enemy gets the MEAN hits over the first
// min(targets, length) slots, since the surrogate cannot know which target slot it takes. 'first' = slot 0.
const HITS_BY_TARGET = 'mean';
// ASSUMPTION: (instant skill damage, e.g. 德克萨斯 S2 剑雨) fires at the steady-state rate (1 / skills.cycle period,
// or uses / horizon from the automaton below) and hits an enemy with probability = its seconds in the instant range
// x that rate, i.e. expected damage per second = rate x (damage of one activation) while in range; targets ignored
// unless targetShare. Its ATK, RES ignore and ELITE/BOSS multiplier come from the active profile, as in sim.js.
// false = instant damage left out of pot.
const INSTANT_AS_RATE = true;
// ASSUMPTION: (uptime when skills.cycle is null: ATTACK/HIT sp, multi-stage, ammo, onDeploy) skills.js's SP automaton
// is run for `horizon` seconds (default: the nominal no-defence fight length, max enemy leaveAt) from a deployment
// at t = 0, the operator attacking without pause at the interval of its current profile and starting the skill the
// moment it is ready. HIT sp never charges (no enemy attacks in the surrogate): such a skill counts as never used.
// 'none' = such skills count as never used ('average' = base).
const UPTIME_FALLBACK = 'automaton';
const AUTOMATON_DT = 0.1;
// Profile fields the surrogate leaves out although they change damage dealt (reported per operator in meta.perOp):
const IGNORED_FIELDS = ['defIgnoreRamp', 'proc', 'onHitDebuff', 'atkScaleMelee', 'thorns'];
const IGNORED_WHY = { defIgnoreRamp: 'DEF-ignore ramp (needs hit history)', proc: 'random proc', onHitDebuff: 'on-hit debuff',
  atkScaleMelee: 'lord melee hits (counted as ranged x0.8)', thorns: 'thorns (no enemy attacks in the surrogate)' };

// ---------- paths -> timed tile pieces ----------
// sim.js moves an enemy linearly between consecutive waypoints and puts it on the tile of its ROUNDED position
// (place(): tile = floor(y + 0.5), floor(x + 0.5)); a leg that starts at a hidden waypoint (DISAPPEAR ... APPEAR)
// is off the map; the enemy leaves at the last waypoint. pieces() cuts every leg where a rounded coordinate
// changes, so the time per tile below is exact for that model (walking unblocked). Result: [{tile, t0, t1}], t
// relative to the spawn, consecutive pieces on one tile merged. Cached per path array (sim shares them).
const PIECES = new WeakMap();
function pieces(path, H, W) {
  const key = H * 65536 + W, hit = PIECES.get(path);
  if (hit && hit.key === key) return hit.list;
  const list = [];
  const cuts = (fs, y0, y1) => {
    if (y0 === y1) return;
    const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
    for (let m = Math.floor(lo + 0.5); m <= Math.ceil(hi + 0.5); m++) { const f = (m - 0.5 - y0) / (y1 - y0); if (f > 0 && f < 1) fs.push(f); }
  };
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k], b = path[k + 1], dt = b.t - a.t;
    if (a.hidden || !(dt > 0)) continue;
    const fs = [0, 1];
    cuts(fs, a.r, b.r); cuts(fs, a.c, b.c);
    fs.sort((x, y) => x - y);
    for (let j = 0; j + 1 < fs.length; j++) {
      const f0 = fs[j], f1 = fs[j + 1];
      if (!(f1 > f0)) continue;
      const fm = (f0 + f1) / 2, y = a.r + (b.r - a.r) * fm, x = a.c + (b.c - a.c) * fm, ty = Math.floor(y + 0.5), tx = Math.floor(x + 0.5);
      if (!(y > -0.5 && x > -0.5 && ty < H && tx < W)) continue;
      const tile = ty * W + tx, t0 = a.t + dt * f0, t1 = f1 === 1 ? b.t : a.t + dt * f1, last = list[list.length - 1];
      if (last && last.tile === tile && Math.abs(last.t1 - t0) < EPS) last.t1 = t1; else list.push({ tile, t0, t1 });
    }
  }
  PIECES.set(path, { key, list });
  return list;
}
// seconds per tile id of one path (Float64Array H*W)
function tileTimes(path, H, W) {
  const out = new Float64Array(H * W);
  for (const p of pieces(path, H, W)) out[p.tile] += p.t1 - p.t0;
  return out;
}

// Per (stage, enemy list): distinct paths with their tile times, which tiles any / any ground enemy visits.
const CTX = new WeakMap();
function contextOf(stage, enemies) {
  let x = CTX.get(enemies);
  if (x && x.stage === stage && x.n === enemies.length) return x;
  const H = stage.H, W = stage.W, n = enemies.length, paths = [], idx = new Map();
  x = { stage, n, H, W, N: H * W, paths, pathIdx: new Int32Array(n), fly: new Uint8Array(n), spawn: new Float64Array(n),
    anyTile: new Uint8Array(H * W), groundTile: new Uint8Array(H * W) };
  enemies.forEach((e, i) => {
    let k = idx.get(e.path);
    if (k === undefined) { idx.set(e.path, k = paths.length); paths.push({ pieces: pieces(e.path, H, W), time: tileTimes(e.path, H, W) }); }
    x.pathIdx[i] = k; x.fly[i] = e.motion === 'FLY' ? 1 : 0; x.spawn[i] = e.spawn || 0;
    for (const p of paths[k].pieces) { x.anyTile[p.tile] = 1; if (!x.fly[i]) x.groundTile[p.tile] = 1; }
  });
  CTX.set(enemies, x);
  return x;
}

// ---------- heatmaps, correlation, summed-area tables ----------
const grid0 = (H, W) => Array.from({ length: H }, () => new Array(W).fill(0));
// heatmaps(stage, enemies) -> {time, hp, airTime, airHp}: H x W enemy-seconds and HP-seconds (seconds x max HP) per
// tile, every enemy weight 1, hidden legs skipped; air* = the FLY enemies' share (ground = total - air).
function heatmaps(stage, enemies) {
  const { H, W } = stage, time = grid0(H, W), hp = grid0(H, W), airTime = grid0(H, W), airHp = grid0(H, W);
  for (const e of enemies) for (const p of pieces(e.path, H, W)) {
    const r = Math.floor(p.tile / W), c = p.tile % W, s = p.t1 - p.t0;
    time[r][c] += s; hp[r][c] += s * e.hp;
    if (e.motion === 'FLY') { airTime[r][c] += s; airHp[r][c] += s * e.hp; }
  }
  return { time, hp, airTime, airHp };
}
// mask offsets as a set (duplicates count once)
function uniqueMask(mask) {
  const seen = new Set(), out = [];
  for (const o of mask) { const k = o.dr + ',' + o.dc; if (!seen.has(k)) { seen.add(k); out.push({ dr: o.dr, dc: o.dc }); } }
  return out;
}
// correlate2d(map, mask): explicit 2D cross-correlation, out[r][c] = sum over the mask of map[r+dr][c+dc] (offsets
// outside the map contribute 0). With a rotated range as the mask and the HP-seconds map this is the placement
// heatmap: out[r][c] = HP-seconds an operator on (r, c) facing that way has in range.
function correlate2d(map, mask) {
  const H = map.length, W = H ? map[0].length : 0, m = uniqueMask(mask), out = grid0(H, W);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    let s = 0;
    for (const o of m) { const y = r + o.dr, x = c + o.dc; if (y >= 0 && x >= 0 && y < H && x < W) s += map[y][x]; }
    out[r][c] = s;
  }
  return out;
}
// mask <-> dense 0/1 kernel; kernel[i][j] is offset (i - r0, j - c0)
function maskToKernel(mask) {
  const m = uniqueMask(mask);
  if (!m.length) return { kernel: [], r0: 0, c0: 0 };
  const r0 = -Math.min(...m.map(o => o.dr)), c0 = -Math.min(...m.map(o => o.dc));
  const kernel = grid0(Math.max(...m.map(o => o.dr)) + r0 + 1, Math.max(...m.map(o => o.dc)) + c0 + 1);
  for (const o of m) kernel[o.dr + r0][o.dc + c0] = 1;
  return { kernel, r0, c0 };
}
function kernelToMask({ kernel, r0, c0 }) {
  const out = [];
  kernel.forEach((row, i) => row.forEach((v, j) => { if (v) out.push({ dr: i - r0, dc: j - c0 }); }));
  return out;
}
// summedAreaTable(map) -> (H+1) x (W+1) prefix sums, S[r+1][c+1] = sum of map[0..r][0..c]
function summedAreaTable(map) {
  const H = map.length, W = H ? map[0].length : 0, S = Array.from({ length: H + 1 }, () => new Float64Array(W + 1));
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) S[r + 1][c + 1] = map[r][c] + S[r][c + 1] + S[r + 1][c] - S[r][c];
  return S;
}
// rectSum(sat, r0, c0, r1, c1): sum of map[r0..r1][c0..c1] (inclusive), clipped to the map; O(1)
function rectSum(sat, r0, c0, r1, c1) {
  const H = sat.length - 1, W = H >= 0 ? sat[0].length - 1 : 0;
  r0 = Math.max(0, r0); c0 = Math.max(0, c0); r1 = Math.min(H - 1, r1); c1 = Math.min(W - 1, c1);
  if (r0 > r1 || c0 > c1) return 0;
  return sat[r1 + 1][c1 + 1] - sat[r0][c1 + 1] - sat[r1 + 1][c0] + sat[r0][c0];
}

// ---------- ranges on the map ----------
// rotated(range, dir): CONTRACT 1 rotation (operators.rotate), duplicates removed; cached per range array
const ROT = new WeakMap();
function rotated(range, dir) {
  let m = ROT.get(range);
  if (!m) ROT.set(range, m = {});
  return m[dir] || (m[dir] = uniqueMask(O.rotate(range, dir)));
}
const maskKey = mask => mask.map(o => o.dr * 1000 + o.dc).sort((a, b) => a - b).join(',');
// tile ids of a rotated mask placed on (r, c), clipped to the map
function maskTiles(H, W, mask, r, c) {
  const out = [];
  for (const o of mask) { const y = r + o.dr, x = c + o.dc; if (y >= 0 && x >= 0 && y < H && x < W) out.push(y * W + x); }
  return out;
}
// profile-or-range argument: a CombatProfile ({range, canHitAir}) or a bare range array (canHitAir from the argument,
// default true: pure geometry)
const rangeArg = (p, air) => Array.isArray(p) ? { range: p, air: air !== false } : { range: p.range, air: air !== undefined ? air !== false : !!p.canHitAir };

// secondsInRange(stage, profileOrRange, r, c, dir, enemy, canHitAir?) -> seconds the enemy spends (walking unblocked)
// on the tiles of the range rotated to `dir` around (r, c); FLY enemies count only if canHitAir; hidden legs excluded.
function secondsInRange(stage, prof, r, c, dir, enemy, canHitAir) {
  const { range, air } = rangeArg(prof, canHitAir);
  if (enemy.motion === 'FLY' && !air) return 0;
  const bits = new Set(maskTiles(stage.H, stage.W, rotated(range, dir), r, c));
  let s = 0;
  for (const p of pieces(enemy.path, stage.H, stage.W)) if (bits.has(p.tile)) s += p.t1 - p.t0;
  return s;
}
// intervalsInRange(...same) -> [[t0, t1]] absolute times (spawn + path time) the enemy is in range, merged
function intervalsInRange(stage, prof, r, c, dir, enemy, canHitAir) {
  const { range, air } = rangeArg(prof, canHitAir), out = [];
  if (enemy.motion === 'FLY' && !air) return out;
  const bits = new Set(maskTiles(stage.H, stage.W, rotated(range, dir), r, c)), s0 = enemy.spawn || 0;
  for (const p of pieces(enemy.path, stage.H, stage.W)) {
    if (!bits.has(p.tile)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - (s0 + p.t0)) < EPS) last[1] = s0 + p.t1; else out.push([s0 + p.t0, s0 + p.t1]);
  }
  return out;
}
// placementHeatmap(stage, enemies, range, dir, {weight: 'hp'|'time', canHitAir}) = correlate2d(heatmap, rotated range)
function placementHeatmap(stage, enemies, range, dir, o = {}) {
  const hm = heatmaps(stage, enemies), w = o.weight === 'time' ? 'time' : 'hp';
  const map = o.canHitAir === false ? hm[w].map((row, r) => row.map((v, c) => v - hm[w === 'hp' ? 'airHp' : 'airTime'][r][c])) : hm[w];
  return correlate2d(map, rotated(range, dir));
}

// ---------- damage per second against one enemy ----------
// Enemy attacks at range (sim.js mode 2): what profile.dot.dpsVsRanged keys on.
function attacksAtRange(e) {
  const mode = e.attackMode || (!e.applyWay ? 'melee' : e.applyWay === 'NONE' ? 'none' : e.applyWay === 'MELEE' ? 'melee' : 'ranged');
  return mode === 'ranged' && e.rangeRadius > 0 && e.atk > 0 && e.interval > 0;
}
const typeScale = (p, e) => (p.atkScaleByType && (e.type === 'ELITE' || e.type === 'BOSS') ? p.atkScaleByType[e.type] ?? 1 : 1);
const resIgnored = (p, dtype, e) => (dtype === 'arts' && p.resIgnore > 0 ? { ...e, res: Math.max(0, (e.res || 0) - p.resIgnore) } : e);
function hitsPerTarget(p) {
  const hb = p.hitsByTarget, hits = p.hits ?? 1;
  if (!Array.isArray(hb) || !hb.length) return hits;
  if (HITS_BY_TARGET === 'first') return hb[0] ?? hits;
  const n = Math.max(1, Math.min(p.targets ?? 1, hb.length));
  let s = 0;
  for (let j = 0; j < n; j++) s += hb[j] ?? hits;
  return s / n;
}
const damaging = p => !!p && p.attacks !== false && p.interval > 0 && DAMAGE_TYPES.has(p.damageType);
// dpsVs(profile, enemy): sustained damage per second on ONE enemy it keeps attacking. operators.hitDamage (HANDOFF
// formulas, 5% floor, damageTaken) with the profile fields sim.js honours: atkScale, hits / hitsByTarget,
// atkScaleByType {ELITE, BOSS}, resIgnore, bonusHit, dot. Not included: IGNORED_FIELDS.
function dpsVs(p, e) {
  if (!damaging(p)) return 0;
  const m = typeScale(p, e);
  let d = hitsPerTarget(p) * O.hitDamage(p.atk * (p.atkScale ?? 1) * m, p.damageType, resIgnored(p, p.damageType, e));
  const bh = p.bonusHit;
  if (bh && bh.scale > 0) { const t = bh.damageType || 'arts'; d += O.hitDamage(p.atk * bh.scale * m, t, resIgnored(p, t, e)); }
  let dps = d / p.interval;
  const dot = p.dot;
  if (DOT_WHILE_IN_RANGE && dot && dot.dps > 0 && dot.duration > 0) dps += O.hitDamage(attacksAtRange(e) ? dot.dpsVsRanged ?? dot.dps : dot.dps, dot.damageType || 'arts', e);
  return dps;
}
// damage of one activation of instant skill damage (spec.instant.damage) on enemy e, ATK of profile p
function instantDamage(p, dm, e) {
  const t = dm.damageType || p.damageType;
  if (!DAMAGE_TYPES.has(t)) return 0;
  return (dm.hits || 1) * O.hitDamage(p.atk * (dm.scale ?? 1) * typeScale(p, e), t, resIgnored(p, t, e));
}

// ---------- skills: which profiles, mixed how ----------
// Spec and profiles as sim.js gets them: op.skillSpec / op.profiles when injected (CONTRACT 6), else skills.js.
// live = the skill can start (MANUAL/AUTO or an onDeploy passive) and is not 'unsupported'.
const KITS = new WeakMap();
function kitOf(op) {
  let k = KITS.get(op);
  if (k && k.specRef === op.skillSpec && k.profRef === op.profiles) return k;
  const spec = op.skillSpec !== undefined ? op.skillSpec : SK.compileSkill(op);
  const pr = op.profiles || (spec ? SK.profiles(op, spec) : null) || {};
  const fill = p => { if (!p || p === op) return op; const q = { ...p }; for (const f of ['atk', 'interval', 'damageType', 'range', 'canHitAir', 'targets']) if (q[f] == null) q[f] = op[f]; return q; };
  const base = fill(pr.base || op), active = fill(pr.active || pr.base || op);
  const live = !!spec && spec.fidelity !== 'unsupported' && (spec.trigger === 'MANUAL' || spec.trigger === 'AUTO' || !!spec.onDeploy);
  const stages = live && Array.isArray(pr.stages) && pr.stages.length ? pr.stages.map(fill) : null;
  k = { specRef: op.skillSpec, profRef: op.profiles, spec, base, active, stages, live };
  KITS.set(op, k);
  return k;
}
const activeStates = k => k.stages ? k.stages.map((p, j) => ({ kind: 'stage' + (j + 1), profile: p })) : [{ kind: 'active', profile: k.active }];
const instantOf = k => (k.live && k.spec.instant && k.spec.instant.damage && DAMAGE_TYPES.has(k.spec.instant.damage.damageType || k.active.damageType) ? k.spec.instant.damage : null);
// false = no profile of the operator deals damage and its skill has no instant damage (healers, pure supports)
function dealsDamage(op) {
  const k = kitOf(op);
  return damaging(k.base) || (k.live && (activeStates(k).some(s => damaging(s.profile)) || !!instantOf(k)));
}
// SP automaton run (see the ASSUMPTION at the top): seconds share of each state, number of activations
function automaton(k, horizon) {
  const spec = k.spec, st = SK.skillInit(spec), frac = {}, steps = Math.max(0, Math.round(horizon / AUTOMATON_DT));
  let uses = 0, clock = 0;
  const states = new Map([['base', k.base], ...activeStates(k).map(s => [s.kind, s.profile])]);
  for (let s = 0; s < steps; s++) {
    if (SK.skillReady(spec, st)) { SK.skillActivate(spec, st); uses++; }
    const kind = !st.active ? 'base' : k.stages ? 'stage' + Math.min(Math.max(st.uses, 1), k.stages.length) : 'active', cur = states.get(kind);
    frac[kind] = (frac[kind] || 0) + 1 / steps;
    if (cur.attacks !== false && cur.interval > 0) { clock += AUTOMATON_DT; while (clock >= cur.interval - EPS) { clock -= cur.interval; SK.skillOnAttack(spec, st); } }
    SK.skillTick(spec, st, AUTOMATON_DT);
  }
  return { frac: steps ? frac : { base: 1 }, uses };
}
const horizonOf = enemies => enemies.reduce((m, e) => Math.max(m, e.leaveAt ?? (e.spawn || 0) + e.path[e.path.length - 1].t), 0);

// skillMix(op, {potMode, horizon}) -> how the surrogate mixes the operator's profiles:
//   {mode, source: 'none'|'cycle'|'automaton', uptime, period, sum: [{kind, profile, weight}], max: [{kind, profile}],
//    instant: {damage, profile, rate} | null, ignored: [field]}
// pot = sum_k weight_k * pot(profile_k) + elementwise max over `max` + instant rate * damage while in instant range.
// 'base': the base profile only (skill never used). 'active': skill always on (optimistic: the best active state,
// plus instant damage at its steady rate). 'average': base and active states weighted by uptime (skills.cycle; the
// automaton when cycle is null) plus instant damage at its rate.
function skillMix(op, o = {}) {
  const k = kitOf(op), mode = o.potMode || POT_MODE_DEFAULT, ignored = new Set();
  if (!POT_MODES.includes(mode)) throw new Error('candidates: potMode must be one of ' + POT_MODES.join(', '));
  for (const p of [k.base, ...(k.live ? activeStates(k).map(s => s.profile) : [])]) for (const f of IGNORED_FIELDS) if (p[f] != null && p[f] !== false) ignored.add(f);
  const out = { mode, source: 'none', uptime: 0, period: null, sum: [], max: [], instant: null, ignored: [...ignored] };
  if (mode === 'base' || !k.live) { out.sum.push({ kind: 'base', profile: k.base, weight: 1 }); return out; }
  const cyc = SK.cycle(k.spec), dm = instantOf(k);
  let frac, rate;
  if (cyc) {
    out.source = 'cycle'; out.period = cyc.period;
    frac = { base: 1 - cyc.uptime, [activeStates(k)[0].kind]: cyc.uptime };
    rate = cyc.period > 0 && Number.isFinite(cyc.period) ? 1 / cyc.period : 0;
  } else {
    const h = o.horizon > 0 && UPTIME_FALLBACK === 'automaton' ? o.horizon : 0, a = automaton(k, h);
    out.source = 'automaton'; frac = a.frac; rate = h > 0 ? a.uses / h : 0; out.period = a.uses ? h / a.uses : null;
  }
  out.uptime = 1 - (frac.base || 0);
  if (mode === 'active') out.max = activeStates(k);
  else {
    if (frac.base > 0) out.sum.push({ kind: 'base', profile: k.base, weight: frac.base });
    for (const s of activeStates(k)) if (frac[s.kind] > 0) out.sum.push({ kind: s.kind, profile: s.profile, weight: frac[s.kind] });
  }
  if (INSTANT_AS_RATE && dm && rate > 0) out.instant = { damage: dm, profile: k.active, rate };
  return out;
}

// ---------- pot of one placement ----------
// Layers: one per mixed profile and one for instant damage: {group 'sum'|'max', weight, range, air, targets,
// perSec: Float64Array(nE) = damage per second while enemy i is in this layer's range}.
function layersOf(mix, enemies) {
  const L = [], per = f => Float64Array.from(enemies, f);
  for (const s of mix.sum) L.push({ group: 'sum', weight: s.weight, range: s.profile.range, air: !!s.profile.canHitAir, targets: s.profile.targets ?? 1, perSec: per(e => dpsVs(s.profile, e)) });
  for (const s of mix.max) L.push({ group: 'max', weight: 1, range: s.profile.range, air: !!s.profile.canHitAir, targets: s.profile.targets ?? 1, perSec: per(e => dpsVs(s.profile, e)) });
  const it = mix.instant;
  if (it) L.push({ group: 'sum', weight: 1, range: Array.isArray(it.damage.range) ? it.damage.range : it.profile.range, air: !!it.profile.canHitAir,
    targets: it.damage.targets || 1, perSec: per(e => it.rate * instantDamage(it.profile, it.damage, e)) });
  return L;
}
// seconds in range per enemy: independent (CONTRACT 7) or time-shared among the enemies present (targetShare)
function secondsFor(ctx, tiles, air, targets, share, out) {
  const n = ctx.n;
  if (!share) {
    const sp = new Float64Array(ctx.paths.length);
    for (let p = 0; p < sp.length; p++) { const T = ctx.paths[p].time; let s = 0; for (const t of tiles) s += T[t]; sp[p] = s; }
    for (let i = 0; i < n; i++) out[i] = air || !ctx.fly[i] ? sp[ctx.pathIdx[i]] : 0;
    return out;
  }
  // sweep line over absolute time: S(t) = integral of min(1, targets / n(t)) while n(t) > 0 enemies are in range;
  // an enemy present on [a, b] gets S(b) - S(a) "effective seconds" (each present enemy gets the same share).
  out.fill(0);
  const bits = new Set(tiles), ev = [], owner = [];
  for (let i = 0; i < n; i++) {
    if (ctx.fly[i] && !air) continue;
    const iv = [];
    for (const p of ctx.paths[ctx.pathIdx[i]].pieces) {
      if (!bits.has(p.tile)) continue;
      const a = ctx.spawn[i] + p.t0, b = ctx.spawn[i] + p.t1, last = iv[iv.length - 1];
      if (last && Math.abs(last[1] - a) < EPS) last[1] = b; else iv.push([a, b]);
    }
    for (const [a, b] of iv) { const k = owner.length; owner.push(i); ev.push([a, 1, k], [b, -1, k]); }
  }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const at = new Float64Array(owner.length);
  let S = 0, cnt = 0, tPrev = ev.length ? ev[0][0] : 0;
  for (const [t, d, k] of ev) {
    if (cnt > 0) S += (t - tPrev) * Math.min(1, targets / cnt);
    tPrev = t;
    if (d > 0) { at[k] = S; cnt++; } else { out[owner[k]] += S - at[k]; cnt--; }
  }
  return out;
}
function potOf(ctx, layers, r, c, dir, share) {
  const n = ctx.n, pot = new Float64Array(n), sec = new Float64Array(n);
  let mx = null;
  for (const L of layers) {
    secondsFor(ctx, maskTiles(ctx.H, ctx.W, rotated(L.range, dir), r, c), L.air, L.targets, share, sec);
    if (L.group === 'max') { mx = mx || new Float64Array(n); for (let i = 0; i < n; i++) mx[i] = Math.max(mx[i], L.perSec[i] * sec[i]); }
    else for (let i = 0; i < n; i++) pot[i] += L.weight * L.perSec[i] * sec[i];
  }
  if (mx) for (let i = 0; i < n; i++) pot[i] += mx[i];
  return pot;
}
// potentials(stage, op, r, c, dir, enemies, {potMode, targetShare, horizon}) -> Float64Array(nE): pot of one
// placement (no legality check), the same numbers buildInstance puts into a candidate.
function potentials(stage, op, r, c, dir, enemies, o = {}) {
  const ctx = contextOf(stage, enemies);
  if (!dealsDamage(op)) return new Float64Array(enemies.length);
  const mix = skillMix(op, { potMode: o.potMode, horizon: o.horizon ?? horizonOf(enemies) });
  return potOf(ctx, layersOf(mix, enemies), r, c, dir, !!(o.targetShare ?? TARGET_SHARE_DEFAULT));
}

// ---------- the instance ----------
// buildInstance(stage, ops, enemies, {K, potMode, opts, targetShare, limit, horizon, dedupeCoverage}) -> {inst, meta}
//   ops      operator objects (CONTRACT 2; op.skillSpec / op.profiles honoured); cand.op = index into ops
//   enemies  CONTRACT 5 list (null: sim.sampleEnemies(stage, opts))
//   opts     sim options: canDeploy {elite, rules}, deployLimit {secrecy, rules}, sampleEnemies
//   K        candidates kept per operator, by solo value (value of the singleton set), default K_DEFAULT; Infinity = all
// Per operator: legal tiles per sim.canDeploy x 4 directions -> one direction per rotation-symmetry class of its masks
// (all layers) -> directions whose masks cover no enemy path tile skipped -> directions covering exactly the same path
// tiles as an earlier one on the same tile skipped (dedupeCoverage, default true: their pots are identical) -> solo
// value 0 dropped -> top K. Operators that deal no damage (healers: damageType heal) get no candidates: their pot
// would be 0 everywhere, so the placement surrogate cannot value them; they are listed in meta.nonDamage with their
// legal tiles for timeline.js to place.
function buildInstance(stage, ops, enemies, o = {}) {
  const opts = o.opts || {}, K = o.K ?? K_DEFAULT, potMode = o.potMode || POT_MODE_DEFAULT, share = !!(o.targetShare ?? TARGET_SHARE_DEFAULT);
  const dedupe = o.dedupeCoverage !== false;
  if (!POT_MODES.includes(potMode)) throw new Error('candidates: potMode must be one of ' + POT_MODES.join(', '));
  if (!(K >= 0)) throw new Error('candidates: K must be >= 0');
  enemies = enemies || sim.sampleEnemies(stage, opts);
  const ctx = contextOf(stage, enemies), { H, W } = stage, nE = enemies.length, horizon = o.horizon ?? horizonOf(enemies);
  const hp = Float64Array.from(enemies, e => e.hp), w = new Float64Array(nE).fill(1);
  const cands = [], metaCands = [], perOp = [], nonDamage = [], log = [];
  const counts = { operators: ops.length, damageOps: 0, nonDamageOps: 0, legalTiles: 0, legal: 0, afterSymmetry: 0, afterEmpty: 0, afterCoverage: 0, nonZero: 0, kept: 0, dropped: 0 };
  ops.forEach((op, oi) => {
    const tiles = [];
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (sim.canDeploy(stage, op, r, c, null, opts)) tiles.push([r, c]);
    const row = { op: oi, opName: op.name, cost: op.cost, legalTiles: tiles.length, legal: 4 * tiles.length, afterSymmetry: 0, afterEmpty: 0, afterCoverage: 0, nonZero: 0, kept: 0, dropped: 0 };
    perOp.push(row);
    if (!dealsDamage(op)) {
      counts.nonDamageOps++;
      nonDamage.push({ op: oi, opName: op.name, damageType: op.damageType, cost: op.cost, tiles: tiles.map(([r, c]) => ({ r, c })),
        reason: 'deals no damage (' + op.damageType + '): pot would be 0, the placement surrogate cannot value it' });
      log.push(`${op.name}: no damage (${op.damageType}), ${tiles.length} legal tiles, not a candidate`);
      return;
    }
    counts.damageOps++;
    const mix = skillMix(op, { potMode, horizon }), layers = layersOf(mix, enemies);
    Object.assign(row, { uptime: mix.uptime, source: mix.source, ignored: mix.ignored });
    const dirs = [], sym = new Set();
    for (const d of DIRS) { const s = layers.map(L => maskKey(rotated(L.range, d))).join('|'); if (!sym.has(s)) { sym.add(s); dirs.push(d); } }
    row.afterSymmetry = tiles.length * dirs.length;
    const list = [];
    for (const [r, c] of tiles) {
      const seen = new Set();
      for (const d of dirs) {
        const cov = layers.map(L => maskTiles(H, W, rotated(L.range, d), r, c).filter(t => (L.air ? ctx.anyTile : ctx.groundTile)[t]).sort((a, b) => a - b));
        if (cov.every(x => !x.length)) continue;
        row.afterEmpty++;
        const key = cov.map(x => x.join(',')).join('|');
        if (dedupe && seen.has(key)) continue;
        seen.add(key); row.afterCoverage++;
        const pot = potOf(ctx, layers, r, c, d, share);
        let solo = 0;
        for (let i = 0; i < nE; i++) solo += w[i] * Math.min(hp[i], pot[i]);
        if (!(solo > 0)) continue;
        row.nonZero++;
        list.push({ r, c, dir: d, tile: r * W + c, pot, solo });
      }
    }
    list.sort((a, b) => b.solo - a.solo || a.tile - b.tile || DIRS.indexOf(a.dir) - DIRS.indexOf(b.dir));
    const keep = list.slice(0, K);
    row.kept = keep.length; row.dropped = list.length - keep.length;
    for (const x of keep) {
      const id = cands.length;
      cands.push({ id, op: oi, tile: x.tile, dir: x.dir, cost: op.cost, pot: x.pot });
      metaCands.push({ id, op: oi, opName: op.name, r: x.r, c: x.c, dir: x.dir, tile: x.tile, solo: x.solo, cost: op.cost });
    }
    log.push(`${op.name}: ${row.legal} legal placements (${tiles.length} tiles x 4), ${row.afterSymmetry} after symmetry, ${row.afterEmpty} cover a path, `
      + `${row.afterCoverage} distinct, ${row.nonZero} with value, kept ${row.kept}, dropped ${row.dropped}`);
  });
  for (const row of perOp) for (const f of ['legalTiles', 'legal', 'afterSymmetry', 'afterEmpty', 'afterCoverage', 'nonZero', 'kept', 'dropped']) counts[f] += row[f];
  const limit = o.limit ?? sim.deployLimit(stage, opts);
  return { inst: { limit, hp, w, cands },
    meta: { cands: metaCands, perOp, nonDamage, counts, log, potMode, targetShare: share, K, horizon, limit, H, W, nE,
      hpTotal: hp.reduce((a, b) => a + b, 0), ops: ops.map(op => op.name) } };
}

// planFromSet(inst, meta, set, ops) -> plan.deploys [{op, r, c, dir}] in set order, without t (timeline.js decides
// order and times). Throws on an unknown id or a set that is not feasible (CONTRACT 7).
function planFromSet(inst, meta, set, ops) {
  const by = new Map(inst.cands.map(c => [c.id, c])), usedOp = new Set(), usedTile = new Set(), W = meta.W;
  if (set.length > inst.limit) throw new Error(`candidates: ${set.length} placements exceed the limit ${inst.limit}`);
  return set.map(id => {
    const c = by.get(id);
    if (!c) throw new Error('candidates: unknown candidate id ' + id);
    if (usedOp.has(c.op) || usedTile.has(c.tile)) throw new Error('candidates: set uses an operator or a tile twice (id ' + id + ')');
    usedOp.add(c.op); usedTile.add(c.tile);
    return { op: ops[c.op], r: Math.floor(c.tile / W), c: c.tile % W, dir: c.dir };
  });
}

// ---------- ASCII map ----------
// stage_model CLI legend; placements [{r, c, dir, name|opName|op.name, letter?}] (plan.deploys work) are drawn as a
// letter (a, b, ...) and a facing arrow (> E, v S, < W, ^ N).
const LEGEND = 'legend: ^ high ground (deployable)  _ ground (deployable)  . walkable, not deployable  # blocked  O hole  S spawn  E exit  T teleport';
const tileSym = t => !t ? '?' : t.hole ? 'O' : t.key === 'tile_start' ? 'S' : t.key === 'tile_end' ? 'E' : String(t.key).startsWith('tile_tel') ? 'T' : t.high && t.deployable ? '^' : t.deployable ? '_' : t.walkable ? '.' : '#';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function asciiMap(stage, placements) {
  const { H, W } = stage, grid = stage.grid || Array.from({ length: H }, () => new Array(W).fill(null));   // no grid: '?' tiles
  const cells = grid.map(row => row.map(t => tileSym(t) + ' ')), legend = [];
  (placements || []).forEach((p, k) => {
    const L = p.letter || LETTERS[k % LETTERS.length], name = p.name || p.opName || (p.op && p.op.name) || '';
    if (p.r >= 0 && p.c >= 0 && p.r < H && p.c < W) cells[p.r][p.c] = L + (ARROW[p.dir] || ' ');
    legend.push(`${L}${ARROW[p.dir] || ' '} ${name} (${p.r},${p.c}) ${p.dir || ''}`.trimEnd());
  });
  const lines = [];
  if (stage.name) lines.push(`${stage.name}${stage.id ? ' (' + stage.id + ')' : ''}  ${H}x${W}`);
  lines.push(LEGEND);
  if (legend.length) lines.push('operators: letter + facing (> E, v S, < W, ^ N)');
  lines.push('    ' + Array.from({ length: W }, (_, c) => String(c % 10) + ' ').join('').trimEnd());
  cells.forEach((row, r) => lines.push(String(r).padStart(2) + '  ' + row.join('').trimEnd()));
  for (const l of legend) lines.push('  ' + l);
  return lines.join('\n');
}

module.exports = {
  heatmaps, correlate2d, maskToKernel, kernelToMask, summedAreaTable, rectSum, secondsInRange, intervalsInRange,
  placementHeatmap, buildInstance, planFromSet, asciiMap,
  // extras
  potentials, skillMix, dpsVs, instantDamage, hitsPerTarget, dealsDamage, rotated, maskTiles, pieces, tileTimes, horizonOf,
  DIRS, K_DEFAULT, POT_MODE_DEFAULT, POT_MODES, TARGET_SHARE_DEFAULT, DOT_WHILE_IN_RANGE, HITS_BY_TARGET, INSTANT_AS_RATE,
  UPTIME_FALLBACK, AUTOMATON_DT, IGNORED_FIELDS, IGNORED_WHY, LEGEND,
};

// ---------- CLI ----------
if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
  const sm = require('./stage_model.js'), Z = require('./optimize.js'), R = O.loadRoster();
  const stage = sm.loadStage(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '彼处水如酒');
  const opts = { secrecy: R.secrecy, floor: R.floor, rules: R.rules, seed: Number(arg('seed', 1)) };
  const enemies = sim.sampleEnemies(stage, opts), t0 = performance.now();
  const { inst, meta } = buildInstance(stage, R.operators, enemies, { K: Number(arg('K', K_DEFAULT)), potMode: arg('mode', POT_MODE_DEFAULT), targetShare: process.argv.includes('--share'), opts });
  const ms = performance.now() - t0;
  console.log(asciiMap(stage));
  console.log(`\n${enemies.length} enemies, ${Math.round(meta.hpTotal)} HP; potMode ${meta.potMode}${meta.targetShare ? ' (target share)' : ''}, K ${meta.K}, limit ${meta.limit}; built in ${ms.toFixed(0)} ms`);
  for (const l of meta.log) console.log('  ' + l);
  const best = Z.solve(inst);
  console.log(`\nbranch and bound: ${best.stats.explored} nodes, value ${(100 * best.value / meta.hpTotal).toFixed(1)}% of enemy HP (static surrogate)`);
  console.log(asciiMap(stage, best.set.map(id => meta.cands[id])));
}
