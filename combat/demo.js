// End-to-end demo: stage + roster -> the best combat timeline found (who goes where, facing where, when it is
// deployed, when each skill starts), one labelled section per algorithm so a learner can follow the pipeline:
//   stage tensors -> heatmap (2D cross-correlation) -> candidates (top-K, dominance) -> placement surrogate (brute
//   force vs branch and bound, greedy, beam, local search) -> opening knapsack -> timeline search in the simulator
//   (permutations, coordinate descent, hill climbing) -> result -> Monte Carlo over spawn seeds.
// Usage: node combat/demo.js [stage=彼处水如酒] [--secrecy 15] [--floor 5] [--elite] [--roster combat/roster.example.json]
//        [--K 6|all] [--sims 3000] [--seed 1] [--html [file.html]] [--json [file.json]] [--quiet]
// Exit codes: 0 done; 1 a self-check failed (brute force != branch and bound, or the replay does not reproduce);
// 2 bad input (options, stage name, roster file or entry), with a one-line message; 3 internal error (stack trace).
// API: run(options) -> structured results (the same numbers the CLI prints); parseArgs(argv) -> options. Both throw
// an Error with .inputError = true for bad input.
// The search is deterministic: the same options give the same plan on any machine (no wall-clock budget).
'use strict';
const fs = require('fs');
const path = require('path');
const util = require('util');
const sm = require('./stage_model.js');
const O = require('./operators.js');
const SK = require('./skills.js');
const sim = require('./sim.js');
const C = require('./candidates.js');
const Z = require('./optimize.js');
const TL = require('./timeline.js');
const RD = require('./render.js');

// ---------- constants: search effort and presentation (none of them is a game fact) ----------
const STAGE_DEFAULT = '彼处水如酒';
const ROSTER_DEFAULT = path.join(__dirname, 'roster.example.json');
const OUT_DIR = path.join(__dirname, 'out');
const SIMS_DEFAULT = 3000;             // simulator calls for the timeline search (section 8)
// Section 8 times PROBE_RUNS simulate() calls (median) and prints a NOTE when sims x that time exceeds
// TIMELINE_SECONDS_TARGET. Display only: wall-clock time never changes the budget, so a run is reproducible.
const TIMELINE_SECONDS_TARGET = 60;
const PROBE_RUNS = 5;
const FULL_K_NODE_CAP = 20000;         // section 6 check: B&B nodes for the instance without the top-K cut (about 1 s at most)
const SMALL = { ops: 5, K: 3, limit: 3 };   // section 5: small enough for brute force
const BEAM_WIDTH = 8, SA_STEPS = 2000;
const TOP_POOL = 40;                   // branch-and-bound topN list the distinct surrogate sets are drawn from
// Section 8 screen: every pool set is simulated once per heuristic deploy order (timeline.heuristicOrders, in this
// preference order), all deploys asap, skills asap, within SCREEN_SHARE of the budget; the TOP_SETS best go to
// timeline.refine. One simulation separates sets the surrogate ties (it caps every enemy at its HP).
const SCREEN_SHARE = 0.15, SCREEN_ORDERS = ['contact', 'blockersFirst', 'cheapest', 'dpFirst', 'input'], SCREEN_SHOW = 8;
const TOP_SETS = 6;                    // screened sets played out in full by timeline.refine
const SATURATED = 0.999;               // section 6 note: optimum value >= this share of all enemy HP
const TIDY_WASTED_SKILLS = true;       // section 8e, a presentation step that never makes the result worse
const QUICK_DEATH_S = 10;              // plausibility flag: an operator down this soon after its deploy (display only)
// Search heuristic (not a game fact): the surrogate optimum often leaves deploy slots free, because once every
// enemy's HP is covered one more placement adds nothing (overkill), although in the simulator it also blocks, tanks
// and kills earlier. completeSet fills the free slots greedily (largest marginal surrogate gain, ties by solo
// value); the section 8 pool holds the optimum both as is and completed, and the simulator screen decides.
const FILL_FREE_SLOTS = true;
const MC_SEEDS = 20;

const now = () => performance.now();
const pct = (x, tot) => (tot > 0 ? (100 * x / tot).toFixed(1) + '%' : '-');         // '-': no total to take a share of
const hpPct = (x, tot) => (tot > 0 ? (100 * x / tot).toFixed(1) : '100.0') + '%';    // HP removed: no enemy HP = all removed
const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
const ms = x => (x < 10 ? x.toFixed(1) : String(Math.round(x))) + ' ms';
const wide = ch => /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch);   // East Asian wide: 2 columns
const width = s => [...String(s)].reduce((w, ch) => w + (wide(ch) ? 2 : 1), 0);
const padR = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + String(s);
// rows of cells -> aligned lines; `right` = indices of right-aligned columns
function table(head, rows, right = []) {
  const all = [head, ...rows].map(r => r.map(String)), w = head.map((_, j) => Math.max(...all.map(r => width(r[j] ?? ''))));
  return all.map(r => '  ' + r.map((x, j) => (right.includes(j) ? padL(x, w[j]) : padR(x, w[j]))).join('  ').trimEnd());
}
const shade = (v, max) => (v > 0 && max > 0 ? ' ' + Math.min(9, Math.max(1, Math.round(9 * v / max))) : ' ·');   // 1-9 of max, · = 0
const tileSym = t => t.hole ? 'O' : t.key === 'tile_start' ? 'S' : t.key === 'tile_end' ? 'E' : String(t.key).startsWith('tile_tel') ? 'T' : t.high && t.deployable ? '^' : t.deployable ? '_' : t.walkable ? '.' : '#';

// sim.scoreOf packs [lifeLost, HP removed in 1e-4, operators died, duration] into one number; unpack it for display.
function decodeScore(s) {
  if (s == null || !Number.isFinite(s)) return null;
  const L = Math.round((-s + 5e6) / 1e8) || 0, rest = s + L * 1e8, F = Math.ceil(rest / 1e3 - 1e-9) || 0, D = Math.floor((F * 1e3 - rest) / 10 + 1e-9) || 0;   // || 0: no -0
  return { lifeLost: L, hpFrac: F / 1e4, died: D };
}
const shortScore = s => { const d = decodeScore(s); return d ? `life ${d.lifeLost}/HP ${(100 * d.hpFrac).toFixed(2)}%/died ${d.died}` : 'n/a'; };
const died = r => r.losses.filter(l => l.cause === 'died').length;
const brief = r => (r ? `${r.win ? 'WIN' : 'LOSS'}: life lost ${r.lifeLost}, kills ${r.kills}/${r.totalEnemies}, leaks ${r.leaks}, HP removed ${hpPct(r.hpRemoved, r.hpTotal)}, died ${died(r)}, ${f1(r.duration)} s` : 'no result');

// operator kit (spec + profiles), honouring the op.skillSpec / op.profiles injection points like sim.js
const KITS = new WeakMap();
function kitOf(op) {
  let k = KITS.get(op);
  if (k) return k;
  const spec = op.skillSpec !== undefined ? op.skillSpec : SK.compileSkill(op);
  const pr = op.profiles || (spec ? SK.profiles(op, spec) : null) || {};
  const base = pr.base || op, active = (pr.stages && pr.stages[pr.stages.length - 1]) || pr.active || base;
  k = { spec, base, active, profiles: pr };
  KITS.set(op, k);
  return k;
}
const rangeOf = p => p.range || [];
const canAir = (p, op) => !!(p.canHitAir ?? op.canHitAir);

// ---------- argument parsing ----------
const USAGE = 'usage: node combat/demo.js [stage=彼处水如酒] [--secrecy 15] [--floor 5] [--elite] [--roster combat/roster.example.json] [--K 6] [--sims 3000] [--seed 1] [--html [file.html]] [--json [file.json]] [--quiet]';
function parseArgs(argv) {
  const o = {}, num = { secrecy: 1, floor: 1, K: 1, sims: 1, seed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      if (o.stage !== undefined) throw new Error('demo: unexpected argument ' + a + '\n' + USAGE);
      o.stage = a.startsWith('stage=') ? a.slice(6) : a;
      continue;
    }
    const k = a.slice(2);
    if (k in num || k === 'roster') {
      const v = argv[++i];
      if (v === undefined) throw new Error('demo: --' + k + ' needs a value');
      o[k] = k === 'roster' ? v : Number(v);
      if (k !== 'roster' && !Number.isFinite(o[k])) throw new Error('demo: --' + k + ' must be a number, got ' + v);
    } else if (k === 'elite' || k === 'quiet' || k === 'help') o[k] = true;
    else if (k === 'html' || k === 'json') {     // optional file: only a next argument ending in .html / .json
      const v = argv[i + 1];
      if (v && !v.startsWith('--') && v.toLowerCase().endsWith('.' + k)) { o[k] = v; i++; } else o[k] = true;
    } else throw new Error('demo: unknown option ' + a + '\n' + USAGE);
  }
  return o;
}

// ---------- helpers for the sections ----------
function enemyRoster(enemies) {
  const by = new Map();
  for (const e of enemies) { const r = by.get(e.key) || { e, n: 0, first: e.spawn }; r.n++; r.first = Math.min(r.first, e.spawn); by.set(e.key, r); }
  return [...by.values()];
}
// completeSet: see FILL_FREE_SLOTS. Ids sorted ascending.
function completeSet(inst, set) {
  const by = new Map(inst.cands.map(c => [c.id, c])), S = set.slice(), tol = 1e-9 * Math.max(1, inst.hp.reduce((a, b) => a + b, 0));
  const usedOp = new Set(S.map(id => by.get(id).op)), usedTile = new Set(S.map(id => by.get(id).tile));
  while (S.length < inst.limit) {
    const v0 = Z.value(inst, S);
    let best = null;
    for (const c of inst.cands) {
      if (usedOp.has(c.op) || usedTile.has(c.tile)) continue;
      const g = Z.value(inst, S.concat(c.id)) - v0, solo = Z.value(inst, [c.id]);
      if (!best || g > best.g + tol || (g >= best.g - tol && solo > best.solo)) best = { c, g, solo };
    }
    if (!best) break;
    S.push(best.c.id); usedOp.add(best.c.op); usedTile.add(best.c.tile);
  }
  return S.sort((a, b) => a - b);
}
// first nominal time any enemy is inside the base range of any placement (absolute s; candidates.intervalsInRange)
function firstContact(stage, placements, enemies) {
  let t = Infinity, who = null;
  for (const p of placements) {
    const base = kitOf(p.op).base;
    for (const e of enemies) {
      const iv = C.intervalsInRange(stage, base, p.r, p.c, p.dir, e, canAir(base, p.op));
      if (iv.length && iv[0][0] < t) { t = iv[0][0]; who = { op: p.op.name, enemy: e.name, id: e.id }; }
    }
  }
  return { t, who };
}
// sum over enemies of the set's pot WITHOUT the min(HP, .) cap: total damage potential, overkill included
function rawPotential(inst, set) {
  const by = new Map(inst.cands.map(c => [c.id, c]));
  let s = 0;
  for (const id of set) { const c = by.get(id); for (let i = 0; i < c.pot.length; i++) s += (inst.w ? inst.w[i] : 1) * c.pot[i]; }
  return s;
}
// first nominal arrival of an enemy at a protection point (tile_end), walking unblocked (absolute s); every enemy's
// leaveAt when no path ends on a tile_end
function firstArrival(stage, enemies) {
  const atExit = e => { const p = e.path[e.path.length - 1], t = stage.grid[p.r] && stage.grid[p.r][p.c]; return !!t && t.key === 'tile_end'; };
  const list = enemies.some(atExit) ? enemies.filter(atExit) : enemies;
  let best = { t: Infinity, who: null };
  for (const e of list) if (e.leaveAt < best.t) best = { t: e.leaveAt, who: e };
  return Number.isFinite(best.t) ? best : { t: 0, who: null };
}
// Skill uses with no targetable enemy in the skill range (damage skills only; checked on the trace frame at or after
// the activation, positions rounded to tiles): [{name, skill, t, frameT, trigger}]
function wastedSkillUses(stage, plan, traced, enemies) {
  const H = stage.H, W = stage.W, byId = new Map(enemies.map(e => [e.id, e])), frames = traced.trace ? traced.trace.frames : [], out = [];
  const opBy = new Map(plan.deploys.map(d => [d.op.name, d]));
  const tileOf = (y, x) => { const ty = Math.round(y), tx = Math.round(x); return y > -0.5 && x > -0.5 && ty < H && tx < W ? ty * W + tx : -1; };
  for (const u of traced.skillUses) {
    const d = opBy.get(u.name);
    if (!d) continue;
    const k = kitOf(d.op), inst = k.spec && k.spec.instant;
    if (k.active.damageType === 'heal' || (inst && inst.heal && !inst.damage) || (k.active.attacks === false && !(inst && inst.damage))) continue;   // heal / support: no enemy needed
    const range = inst && inst.damage && inst.damage.range ? inst.damage.range : rangeOf(k.active);
    const set = new Set(C.maskTiles(H, W, C.rotated(range, d.dir), d.r, d.c)), hitsAir = canAir(k.active, d.op);
    const fr = frames.find(f => f.t >= u.t - 1e-9) || frames[frames.length - 1];
    if (!fr) continue;
    const n = fr.enemies.filter(([id, y, x]) => { const e = byId.get(id); return e && set.has(tileOf(y, x)) && (hitsAir || e.motion !== 'FLY'); }).length;
    if (!n) out.push({ name: u.name, skill: u.skill, t: u.t, frameT: fr.t, trigger: k.spec ? k.spec.trigger : null });
  }
  return out;
}
// MANUAL skills whose SP was full on some trace frame but that were never started: [{name, skill, t}]
function chargedUnused(plan, traced) {
  const frames = traced.trace ? traced.trace.frames : [], out = [];
  for (const d of plan.deploys) {
    const k = kitOf(d.op);
    if (!k.spec || k.spec.trigger !== 'MANUAL' || k.spec.fidelity === 'unsupported' || traced.skillUses.some(u => u.name === d.op.name)) continue;
    const full = frames.find(f => f.ops.some(x => x[0] === d.op.name && x[3] >= 1 - 1e-9));
    if (full) out.push({ name: d.op.name, skill: k.spec.name, t: full.t });
  }
  return out;
}
// Plausibility flags a player would raise: a range covering no enemy path, a damage dealer that dealt nothing, a
// damage skill started with no enemy in its range, a charged MANUAL skill never used, an operator down within
// QUICK_DEATH_S of its deploy, slots left empty by deaths (no redeploy in sim.js), DP at the cap at the end.
function plausibility(stage, plan, traced, enemies) {
  const H = stage.H, W = stage.W, hm = C.heatmaps(stage, enemies), flags = [], info = [];
  const ground = new Uint8Array(H * W), air = new Uint8Array(H * W);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { if (hm.time[r][c] - hm.airTime[r][c] > 1e-9) ground[r * W + c] = 1; if (hm.airTime[r][c] > 1e-9) air[r * W + c] = 1; }
  const frames = traced.trace ? traced.trace.frames : [], perOp = new Map(traced.perOp.map(p => [p.name, p]));
  for (const d of plan.deploys) {
    const k = kitOf(d.op), tiles = C.maskTiles(H, W, C.rotated(rangeOf(k.base), d.dir), d.r, d.c), hitsAir = canAir(k.base, d.op);
    const onPath = tiles.filter(t => ground[t] || (hitsAir && air[t])).length;
    const blocks = ground[d.r * W + d.c] ? ', stands on an enemy path' : '';
    info.push(`${d.op.name} (${d.r},${d.c}) ${d.dir}: base range ${tiles.length} tiles on the map, ${onPath} on an enemy path${blocks}`);
    if (!onPath) flags.push(`${d.op.name} at (${d.r},${d.c}) facing ${d.dir}: its base range covers no enemy path tile (faces a wall or empty ground)`);
    const s = perOp.get(d.op.name), dmg = C.dealsDamage(d.op);
    if (s && dmg && !(s.damage > 0)) flags.push(`${d.op.name}: a damage dealer that dealt 0 damage`);
    if (s && !dmg && !(s.healing > 0)) flags.push(`${d.op.name}: deals no damage and healed 0`);
  }
  for (const w of wastedSkillUses(stage, plan, traced, enemies))
    flags.push(`${w.name} started ${w.skill} at ${f1(w.t)} s with no enemy in its skill range (frame ${f1(w.frameT)} s)${w.trigger === 'AUTO' ? ': AUTO skill, it fires by itself when SP is full' : ''}`);
  for (const c of chargedUnused(plan, traced))
    flags.push(`${c.name}: MANUAL skill ${c.skill} was charged (SP full at ${f1(c.t)} s) but never started: the skill search found no use that scores better`);
  const depT = new Map(traced.deploys.map(d => [d.name, d.t])), downs = traced.losses.filter(l => l.cause === 'died');
  for (const l of downs) if (depT.has(l.name) && l.t - depT.get(l.name) < QUICK_DEATH_S) flags.push(`${l.name} went down ${f1(l.t - depT.get(l.name))} s after its deploy (${f1(depT.get(l.name))} -> ${f1(l.t)} s)`);
  if (downs.length && traced.leaks) flags.push(`${downs.length} operator(s) died and their slots stayed empty: the simulator has no redeploy (a player would redeploy them after the redeploy timer)`);
  if (traced.dp.endUnspent >= (stage.maxCost ?? 99) - 1e-6) flags.push(`DP sat at the cap (${stage.maxCost}) at the end: regeneration was wasted, nothing left to deploy`);
  return { flags, info };
}
// plan with operator names instead of objects (JSON output)
const planJson = (plan, R) => ({
  deploys: plan.deploys.map(d => ({ op: d.op.name, r: d.r, c: d.c, dir: d.dir, t: d.t ?? 0, config: (R.raw.operators || []).find(x => x.name === d.op.name) || null })),
  skills: plan.skills || {}, retreats: plan.retreats || [] });

// ---------- run ----------
// run(options) -> results. options: {stage, secrecy, floor, elite, roster, K, sims, seed, html, json, quiet, log}
// html / json: true = combat/out/<stage>.<ext>, a string = that path, falsy = not written. log: line sink.
function run(options = {}) {
  const T0 = now(), lines = [], timings = [];
  const sink = options.log || (options.quiet ? null : console.log);
  const say = (...xs) => { for (const x of xs) for (const l of String(x).split('\n')) { lines.push(l); if (sink) sink(l); } };
  let tSec = now();
  const section = (n, title, algo) => { if (n > 1) timings.push({ n: n - 1, ms: now() - tSec }); tSec = now(); say('', `== ${n}. ${title}${algo ? ' [' + algo + ']' : ''} ==`); };
  const out = { options: null, sections: {} };

  // ---- 1. stage and enemies ----
  const rosterPath = path.resolve(options.roster || ROSTER_DEFAULT), R = O.loadRoster(rosterPath);
  const o = { stage: options.stage ?? STAGE_DEFAULT, secrecy: options.secrecy ?? R.secrecy, floor: options.floor ?? R.floor, elite: !!options.elite,
    roster: rosterPath, K: options.K ?? C.K_DEFAULT, sims: options.sims ?? SIMS_DEFAULT, seed: options.seed ?? 1, html: options.html || false, json: options.json || false };
  out.options = o;
  const stage = sm.loadStage(o.stage);
  const simOpts = { secrecy: o.secrecy, floor: o.floor, elite: o.elite, seed: o.seed, rules: R.rules };
  const enemies = sim.sampleEnemies(stage, simOpts), limit = sim.deployLimit(stage, simOpts), H = stage.H, W = stage.W;
  const hpTotal = enemies.reduce((s, e) => s + e.hp, 0), random = TL.hasRandomSpawns(stage, simOpts);
  section(1, 'Stage and enemies', 'tile tensor, timed paths');
  const count = f => enemies.filter(f).length, waves = new Set(enemies.map(e => e.wave)).size;
  const limitRules = R.rules.filter(r => r.rule === 'deployLimit').map(r => `${r.add > 0 ? '+' : ''}${r.add} ${String(r.source).replace('collectible ', '')}`);
  say(`${stage.name} (${stage.id})  ${H}x${W}  ${o.elite ? '紧急作战 (elite)' : 'normal'} mode, secrecy N${o.secrecy}, floor ${o.floor}, spawn seed ${o.seed}`,
    `deploy limit ${limit} (stage ${stage.deployLimit}${o.secrecy >= sim.SECRECY_LIMIT_LEVEL ? `, -1 secrecy N${sim.SECRECY_LIMIT_LEVEL}+` : ''}${limitRules.length ? ', ' + limitRules.join(', ') : ''}); DP: ${stage.initialCost} at start, +1 every ${stage.costIncreaseTime} s, max ${stage.maxCost}`,
    `${enemies.length} enemies in ${waves} wave(s), ${Math.round(hpTotal)} HP in total; FLY ${count(e => e.motion === 'FLY')}, ELITE ${count(e => e.type === 'ELITE')}, BOSS ${count(e => e.type === 'BOSS')}; `
      + `random spawn groups: ${random ? 'yes (one option per group drawn with seed ' + o.seed + ')' : 'no'}`);
  const meta = enemies.meta || {};
  if ([].concat(meta.hiddenGroups || []).length) say(`hidden spawn groups this mode enables: ${[].concat(meta.hiddenGroups).join(', ')}`);
  for (const s of meta.skipped || []) say(`left out: ${s.count} x ${s.key} (${s.reason})`);
  const baseline = sim.simulate(stage, { deploys: [] }, simOpts);
  say(`no defence at all: ${baseline.leaks} leaks, the script runs ${f1(baseline.duration)} s`, '', C.asciiMap(stage), '', 'enemies after secrecy, stage and elite mods:');
  say(...table(['enemy', 'n', 'HP', 'ATK', 'DEF', 'RES', 'speed', 'atk every', 'type', 'motion', 'attack', 'first'],
    enemyRoster(enemies).map(({ e, n, first }) => [e.name, n, Math.round(e.hp), Math.round(e.atk), Math.round(e.def), Math.round(e.res), e.speed, f1(e.interval) + ' s', e.type, e.motion,
      (e.attackMode || '?') + (e.attackMode && e.attackMode !== 'none' ? '/' + e.damageType : '') + (e.attackMode === 'ranged' ? ' r' + e.rangeRadius : ''), f1(first) + ' s']), [1, 2, 3, 4, 5, 6, 7, 11]));
  // the open assumptions that move these numbers, with their size where it can be measured
  const hpOf = list => list.reduce((s, e) => s + e.hp, 0);
  const plain = sim.sampleEnemies(stage, { ...simOpts, secrecy: 0, floor: 1 });
  const compound = o.secrecy > 0 && o.floor > 1 ? sim.sampleEnemies(stage, { ...simOpts, secrecyOpts: { perFloor: 'compound' } }) : null;
  const rate = O.SECRECY_RATE_PCT[o.secrecy] || 0, assumptions = [
    `ASSUMPTION (sim.TPS_DEFAULT): enemy move speed 1.0 = ${sim.TPS_DEFAULT} tiles/s (not calibrated in game); every path time scales with it.`,
    `ASSUMPTION (operators.SECRECY_PER_FLOOR_DEFAULT): +${rate}%/floor ATK and HP is '${O.SECRECY_PER_FLOOR_DEFAULT}' (1 + ${rate}% x (floor - 1), floor 1 = ${O.SECRECY_FLOOR_ONE_STEPS} steps), summed with the other secrecy % (${O.SECRECY_FLOOR_OP_DEFAULT}).`
      + ` Enemy HP here is x${(hpTotal / Math.max(1, hpOf(plain))).toFixed(2)} of secrecy 0${compound ? `; 'compound' would give x${(hpOf(compound) / Math.max(1, hpOf(plain))).toFixed(2)}` : ''}.`,
    `ASSUMPTION (sim.LIFE_POINTS_DEFAULT): ${sim.LIFE_POINTS_DEFAULT} life point(s); the fight is not stopped at defeat, so lives lost can exceed it.`,
    `ASSUMPTION (sim.FRAGMENT_TIMING_DEFAULT): a fragment's preDelay counts from the end of the previous fragment ('${sim.FRAGMENT_TIMING_DEFAULT}'); a wave starts once the one before is cleared.`,
    `ASSUMPTION (sim.BLOCK_PER_ENEMY): every enemy takes ${sim.BLOCK_PER_ENEMY} block; time limit = no-defence duration x ${sim.MAXTIME_FACTOR} + ${sim.MAXTIME_PAD} s.`];
  for (const [lv, txt] of Object.entries(O.SECRECY_UNMODELLED)) {
    if (o.secrecy < Number(lv)) continue;
    const here = [...new Set(enemies.map(e => e.name))].filter(n => n && txt.includes(n.replace(/[“”]/g, '')));
    assumptions.push(`NOT MODELLED (secrecy N${lv}): ${txt}${here.length ? ` (ON THIS STAGE: ${here.join(', ')})` : ' (no enemy named there is on this stage)'}.`);
  }
  say('', ...assumptions);
  out.sections.stage = { name: stage.name, id: stage.id, H, W, limit, initialCost: stage.initialCost, enemies: enemies.length, hpTotal, random, baseline: { leaks: baseline.leaks, duration: baseline.duration }, assumptions };

  // ---- 2. operators ----
  section(2, 'Operators', 'stat vectors + skill state machines');
  const ops = R.operators;
  say(`roster ${path.relative(path.resolve(__dirname, '..'), rosterPath)}${R.raw.example ? ' (EXAMPLE roster, not the user\'s)' : ''}; collectibles: ${(R.raw.collectibles || []).map(c => c.name).join(', ') || 'none'} (stat mods already applied)`);
  if (R.dynamicMods.length) say(`conditional collectible mods NOT applied: ${R.dynamicMods.map(m => m.source + ' ' + m.stat).join(', ')}`);
  say(...table(['operator', 'class', 'pos', 'cost', 'block', 'HP', 'ATK', 'DEF', 'RES', 'interval', 'damage', 'skill (trigger, SP, effect) [fidelity]'],
    ops.map(op => [op.name, op.subProfession, op.position[0], op.cost, op.block, Math.round(op.hp), Math.round(op.atk), Math.round(op.def), op.res, op.interval.toFixed(2) + ' s',
      op.damageType + (op.targets > 1 ? ' x' + op.targets : ''), SK.describeSkill(op).replace(op.name + ' ', '')]), [3, 4, 5, 6, 7, 8, 9]));
  out.sections.operators = ops.map(op => ({ name: op.name, cost: op.cost, block: op.block, atk: op.atk, interval: op.interval, damageType: op.damageType, skill: SK.describeSkill(op), fidelity: kitOf(op).spec ? kitOf(op).spec.fidelity : null }));

  // ---- 3. heatmap ----
  section(3, 'Heatmap', '2D cross-correlation');
  const hm = C.heatmaps(stage, enemies), maxHp = Math.max(...hm.hp.flat());
  say(`HP-seconds per tile = sum over enemies of (seconds on the tile, walking unblocked) x max HP: where damage is worth most. Scale 1-9, max ${Math.round(maxHp)} HP-s, · = no enemy.`);
  say('    ' + Array.from({ length: W }, (_, c) => String(c % 10)).join(' '), ...hm.hp.map((row, r) => String(r).padStart(2) + ' ' + row.map(v => shade(v, maxHp)).join('')));
  const dmgOps = ops.filter(op => C.dealsDamage(op));
  const ex = dmgOps.filter(op => op.position === 'RANGED').sort((a, b) => rangeOf(kitOf(b).base).length - rangeOf(kitOf(a).base).length)[0] || dmgOps[0];
  if (ex) {
    const exBase = kitOf(ex).base, legal = (r, c) => sim.canDeploy(stage, ex, r, c, null, simOpts);
    let pick = null;
    for (const dir of C.DIRS) {
      const m = C.placementHeatmap(stage, enemies, rangeOf(exBase), dir, { weight: 'hp', canHitAir: canAir(exBase, ex) });
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (legal(r, c) && (!pick || m[r][c] > pick.v)) pick = { dir, r, c, v: m[r][c], m };
    }
    if (pick) {
      const { kernel, r0, c0 } = C.maskToKernel(C.rotated(rangeOf(exBase), pick.dir));
      const maxL = Math.max(0, ...pick.m.flatMap((row, r) => row.filter((_, c) => legal(r, c))));
      say('', `placement heatmap of ${ex.name} (base range ${rangeOf(exBase).length} tiles) facing ${pick.dir}: out[r][c] = sum over the rotated range mask of HP-s[r+dr][c+dc]`,
        `(digits on the tiles ${ex.name} may stand on, 1-9 of max ${Math.round(maxL)}; the map symbols elsewhere). Mask (o = own tile):`);
      kernel.forEach((row, i) => say('      ' + row.map((v, j) => (i === r0 && j === c0 ? 'o' : v ? '#' : '.')).join(' ')));
      say('    ' + Array.from({ length: W }, (_, c) => String(c % 10)).join(' '),
        ...pick.m.map((row, r) => String(r).padStart(2) + ' ' + row.map((v, c) => (legal(r, c) ? shade(v, maxL) : ' ' + tileSym(stage.grid[r][c]))).join('')));
      say(`best legal tile for ${ex.name}: (${pick.r},${pick.c}) facing ${pick.dir}, ${Math.round(pick.v)} HP-s under the mask (${pct(pick.v, hm.hp.flat().reduce((a, b) => a + b, 0))} of the map total)`);
      out.sections.heatmap = { maxHp, example: { op: ex.name, dir: pick.dir, r: pick.r, c: pick.c, value: pick.v } };
    }
  }

  // ---- 4. candidates ----
  section(4, 'Candidates', 'top-K + dominance pruning');
  const built = C.buildInstance(stage, ops, enemies, { K: o.K, opts: simOpts }), inst = built.inst, bm = built.meta;
  const dom = Z.dominancePrune(inst, { mode: 'safe' }), survivors = new Map();
  for (const c of dom.inst.cands) survivors.set(c.op, (survivors.get(c.op) || 0) + 1);
  const soloBest = new Map();
  for (const c of bm.cands) soloBest.set(c.op, Math.max(soloBest.get(c.op) || 0, c.solo));
  say(`pot[p][i] = damage placement p could deal enemy i walking unblocked = dps vs i x seconds i spends in range (potMode '${bm.potMode}': base/skill profiles weighted by skill uptime).`,
    `legal = tiles x 4 facings; facings that give the same masks are merged (rotation symmetry); a facing covering no path, or the same path tiles as another facing on that tile, is skipped;`,
    `then the K = ${o.K} best by solo value (the placement alone) are kept, and safe dominance drops a facing whose pot is <= another facing's on the same tile for every enemy.`);
  const rows = bm.perOp.map(p => [p.opName, p.cost, p.legal, p.afterSymmetry, p.afterEmpty, p.afterCoverage, p.nonZero, p.kept, survivors.get(p.op) || 0,
    soloBest.has(p.op) ? pct(soloBest.get(p.op), hpTotal) : '-', p.source === undefined ? 'no damage: not a candidate' : (p.uptime != null ? `uptime ${Math.round(100 * p.uptime)}% (${p.source})` : p.source) + (p.ignored && p.ignored.length ? '; ignores ' + p.ignored.join(', ') : '')]);
  const tc = bm.counts;
  rows.push(['total', '', tc.legal, tc.afterSymmetry, tc.afterEmpty, tc.afterCoverage, tc.nonZero, tc.kept, dom.inst.cands.length, '', '']);
  say(...table(['operator', 'cost', 'legal', 'symmetry', 'on path', 'distinct', 'value>0', 'top-K', 'dominance', 'best solo', 'skill mix / left out'], rows, [1, 2, 3, 4, 5, 6, 7, 8, 9]));
  say(`${inst.cands.length} candidates -> ${dom.inst.cands.length} after dominance (${dom.removed} removed); deploy limit ${inst.limit}. Solo % = share of all enemy HP the placement alone could remove.`);
  for (const n of bm.nonDamage) say(`${n.opName}: ${n.reason}; ${n.tiles.length} legal tiles (offered to the timeline search as a swap-in)`);
  out.sections.candidates = { counts: tc, kept: inst.cands.length, afterDominance: dom.inst.cands.length, perOp: bm.perOp.map(p => ({ op: p.opName, legal: p.legal, afterSymmetry: p.afterSymmetry, kept: p.kept, afterDominance: survivors.get(p.op) || 0 })) };

  // ---- 5. small instance: brute force vs branch and bound ----
  section(5, 'Small instance', 'brute force vs branch and bound');
  const smallOps = [...soloBest.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, SMALL.ops).map(([i]) => ops[i]);
  const sb = C.buildInstance(stage, smallOps, enemies, { K: SMALL.K, limit: SMALL.limit, opts: simOpts }), sInst = sb.inst;
  const bf = Z.bruteForce(sInst), bb = Z.branchAndBound(sInst);
  const tolEq = 1e-9 * Math.max(1, Math.abs(bf.value)), equal = Math.abs(bf.value - bb.value) <= tolEq;
  const nameSet = (m, set) => set.map(id => { const c = m.cands[id]; return `${c.opName}(${c.r},${c.c})${c.dir}`; }).join(' ');
  say(`${smallOps.map(op => op.name).join(', ')} (the ${SMALL.ops} best by solo value), K = ${SMALL.K}, limit ${SMALL.limit}: ${sInst.cands.length} candidates.`,
    `brute force over combinations (ids increasing, so each set once): ${bf.stats.explored} nodes, ${bf.stats.evals} gain evaluations, ${ms(bf.stats.timeMs)};`
      + ` a search over ordered sequences would visit ${bf.permutationSequences} nodes (${bf.permutationSequences - bf.stats.explored} avoided).`,
    `branch and bound (bound: v + the r largest current gains, capped at all HP): ${bb.stats.explored} nodes, ${bb.stats.pruned.bound} children cut by the bound, ${bb.stats.pruned.infeasible} infeasible,`
      + ` ${bb.permutationsAvoided} permutation nodes avoided, ${bb.stats.evals} evaluations, ${ms(bb.stats.timeMs)}, proven ${bb.proven}.`,
    `optimum: brute force ${pct(bf.value, hpTotal)} {${nameSet(sb.meta, bf.set)}}; B&B ${pct(bb.value, hpTotal)} {${nameSet(sb.meta, bb.set)}}  ->  ${equal ? 'EQUAL' : 'MISMATCH (exit code 1)'}`);
  out.small = { ops: smallOps.map(op => op.name), n: sInst.cands.length, bf: { value: bf.value, set: bf.set, nodes: bf.stats.explored, evals: bf.stats.evals, permutationSequences: bf.permutationSequences, ms: bf.stats.timeMs },
    bb: { value: bb.value, set: bb.set, nodes: bb.stats.explored, prunedBound: bb.stats.pruned.bound, infeasible: bb.stats.pruned.infeasible, permutationsAvoided: bb.permutationsAvoided, evals: bb.stats.evals, proven: bb.proven, ms: bb.stats.timeMs }, equal };

  // ---- 6. full instance ----
  section(6, 'Full instance', 'greedy, lazy greedy, beam, B&B, local search');
  const algs = [];
  const g = Z.greedy(inst); algs.push(['greedy', g, `${g.stats.explored} sets on the path`]);
  const lg = Z.lazyGreedy(inst); algs.push(['lazy greedy (heap)', lg, `${lg.stats.evalsSaved} evaluations saved vs greedy`]);
  const bs = Z.beamSearch(inst, BEAM_WIDTH); algs.push([`beam (width ${BEAM_WIDTH})`, bs, `${bs.stats.pruned.symmetry} duplicate sets merged, ${bs.stats.pruned.beam} dropped`]);
  const opt = Z.solve(inst); algs.push(['B&B (+ safe dominance)', opt, `${opt.proven ? 'PROVED optimal' : 'hit the node cap (' + Z.NODE_CAP_DEFAULT + '): best known'}; cut ${opt.stats.pruned.bound} by bound, ${opt.stats.pruned.dominance} by dominance`]);
  const ls = Z.localSearch(inst, g.set); algs.push(['local search from greedy', ls, `moves add ${ls.stats.moves.add}, replace ${ls.stats.moves.replace}, swap ${ls.stats.moves.swap}`]);
  const sa = Z.simulatedAnnealing(inst, g.set, { seed: o.seed, steps: SA_STEPS }); algs.push([`simulated annealing (${SA_STEPS} steps)`, sa, `${sa.stats.accepted} accepted, ${sa.stats.worseAccepted} of them worse`]);
  say(`value(S) = sum over enemies of min(HP, sum of pot of S): the share of enemy HP the set could remove if nothing were blocked. ${inst.cands.length} candidates, limit ${inst.limit}.`);
  say(...table(['algorithm', 'value', 'size', 'evaluations', 'nodes', 'time', 'note'],
    algs.map(([n, r, note]) => [n, pct(r.value, hpTotal), r.set.length, r.stats.evals, r.stats.explored, ms(r.stats.timeMs), note]), [1, 2, 3, 4, 5]));
  const ratio = opt.value > 0 ? g.value / opt.value : 1;
  say(`greedy / optimum = ${ratio.toFixed(4)} (guarantee for this constraint system: >= 1/3; coverage is submodular, so greedy is usually close)`,
    `optimum: ${nameSet(bm, opt.set)}${opt.set.length < inst.limit ? `  (${inst.limit - opt.set.length} slot(s) left free: one more placement adds no surrogate value)` : ''}`);
  if (opt.value >= SATURATED * hpTotal) say(`the surrogate is SATURATED here (${pct(opt.value, hpTotal)} with ${opt.set.length} placement(s)): on paper the enemies die many times over, so every algorithm ties and the ranking must come from the simulator.`);
  out.full = Object.fromEntries(algs.map(([n, r]) => [n, { value: r.value, frac: r.value / hpTotal, size: r.set.length, evals: r.stats.evals, nodes: r.stats.explored, ms: r.stats.timeMs }]));
  out.full.proven = opt.proven; out.full.greedyRatio = ratio; out.full.optimumSet = opt.set;

  // ---- 7. opening knapsack ----
  section(7, 'Opening', '0/1 knapsack');
  // ASSUMPTION: "the defended area" = the protection points (tile_end); the opening budget is the stage's initial DP
  // plus 1 per costIncreaseTime until the first nominal (unblocked, back-to-back spawn) arrival there; squad
  // initialDp bonuses and DP skills are left out. A teaching estimate only: the timeline search does not use it.
  const optPlacements = opt.set.length ? C.planFromSet(inst, bm, opt.set, ops) : [];
  const contact = firstContact(stage, optPlacements, enemies), arrival = firstArrival(stage, enemies);
  const T = arrival.t, dpStep = stage.costIncreaseTime > 0 ? stage.costIncreaseTime : 1;
  const budget = Math.min(stage.maxCost, stage.initialCost + Math.floor(T / dpStep));
  const items = [...soloBest.entries()].sort((a, b) => a[0] - b[0]).map(([i, v]) => ({ op: ops[i], cost: ops[i].cost, value: v }));
  const ks = Z.knapsack01(items, budget, limit), kb = items.length <= 24 ? Z.knapsackBrute(items, budget, limit) : null;
  const ksSame = kb ? Math.abs(kb.value - ks.value) <= 1e-9 * Math.max(1, ks.value) : null;
  say(`first enemy inside a range of the section 6 optimum: ${Number.isFinite(contact.t) ? f1(contact.t) + ' s' : 'never'}${contact.who ? ` (${contact.who.enemy} #${contact.who.id}, ${contact.who.op})` : ''};`
      + ` first enemy at the protection point (blue door, walking unblocked): ${f1(T)} s${arrival.who ? ` (${arrival.who.name} #${arrival.who.id})` : ''}.`,
    `DP by then = ${stage.initialCost} + floor(${f1(T)} / ${dpStep}) = ${budget} (squad DP bonuses and DP skills not counted). Items: damage dealers, value = best solo value, at most ${limit}.`,
    `best[k][b] = max(best[k][b], best[k-1][b - cost] + value): ${ks.chosen.length ? ks.chosen.map(i => `${items[i].op.name} (${items[i].cost} DP, ${pct(items[i].value, hpTotal)})`).join(' + ') : 'nothing affordable'}`
      + ` = ${ks.cost} DP, summed solo ${pct(ks.value, hpTotal)}${kb ? `; brute force over 2^${items.length} subsets: ${ksSame ? 'same value' : 'DIFFERENT value ' + kb.value}` : ''}.`,
    `(solo values add up in the knapsack although operators share enemies: it says what can be paid for before the first leak, not the final team.)`);
  out.knapsack = { t: T, contactT: contact.t, budget, chosen: ks.chosen.map(i => items[i].op.name), cost: ks.cost, value: ks.value, bruteEqual: ksSame };

  // ---- 8. timeline search ----
  section(8, 'Timeline search', 'permutation/hill climbing, event-point coordinate descent');
  // 8a. pool: distinct sets from the surrogate's top list (completed, see FILL_FREE_SLOTS; the optimum also as is)
  const top = opt.set.length ? Z.solve(inst, { topN: TOP_POOL }).top : [], pool = [], seen = new Set();
  const addSet = (set, rank, tag) => { const key = set.join(','); if (!set.length || seen.has(key)) return; seen.add(key); pool.push({ set, rank, tag, value: Z.value(inst, set) }); };
  for (let i = 0; i < top.length && pool.length < TOP_POOL; i++) {
    const set = top[i].set;
    if (i === 0) addSet(set, 1, 'as is');
    if (FILL_FREE_SLOTS) addSet(completeSet(inst, set), i + 1, set.length < inst.limit ? 'slots filled' : '');
  }
  pool.forEach((e, i) => { e.index = i; e.placements = C.planFromSet(inst, bm, e.set, ops); });
  // budget: cut when one simulate() is slow (median of PROBE_RUNS calls on the first set)
  let sims = Math.max(0, Math.floor(o.sims)), scaledNote = '', perSim = 0;
  if (pool.length) {
    const probe = { deploys: pool[0].placements.map(p => ({ ...p, t: 0 })), skills: {} }, tt = [];
    for (let k = 0; k < PROBE_RUNS; k++) { const t0 = now(); sim.simulate(stage, probe, simOpts); tt.push(now() - t0); }
    perSim = tt.sort((a, b) => a - b)[Math.floor(tt.length / 2)];
    const cap = Math.floor(TIMELINE_SECONDS_TARGET * 1000 / Math.max(1e-3, perSim));
    if (sims > cap) { scaledNote = `budget cut from ${sims} to ${cap} simulator calls: one simulate() takes ${perSim.toFixed(1)} ms here (target ${TIMELINE_SECONDS_TARGET} s)`; sims = cap; }
  }
  // 8b. screen: each pool set once or a few times in the simulator (heuristic deploy orders, all at once, skills asap)
  const cache = TL.newCache(), screenBudget = Math.max(1, Math.floor(sims * SCREEN_SHARE)), screened = pool.slice(0, Math.min(pool.length, screenBudget));
  const perSet = Math.max(1, Math.min(SCREEN_ORDERS.length, Math.floor(screenBudget / Math.max(1, screened.length))));
  for (const e of screened) {
    const hs = TL.heuristicOrders(stage, e.placements, simOpts, cache).sort((a, b) => SCREEN_ORDERS.indexOf(a.name) - SCREEN_ORDERS.indexOf(b.name));
    for (const h of hs.slice(0, perSet)) {
      const pl = h.order.map(k => e.placements[k]), r = TL.evaluate(stage, { deploys: pl.map(p => ({ ...p, t: 0 })), skills: {} }, simOpts, cache);
      if (r && (!e.screen || sim.compareResults(r, e.screen.result) < 0)) e.screen = { result: r, placements: pl, order: h.name };
    }
  }
  const scr = screened.filter(e => e.screen);
  const rhoScreen = TL.spearman(scr.map(e => e.value), scr.map(e => e.screen.result.score));
  for (const e of pool) e.raw = rawPotential(inst, e.set);
  const rhoRaw = TL.spearman(scr.map(e => e.raw), scr.map(e => e.screen.result.score));
  const tied = scr.length > 1 && Math.max(...scr.map(e => e.value)) - Math.min(...scr.map(e => e.value)) <= 1e-9 * hpTotal;
  const byScreen = scr.slice().sort((a, b) => sim.compareResults(a.screen.result, b.screen.result) || a.index - b.index);
  const chosen = byScreen.slice(0, TOP_SETS), screenSims = cache.sims;
  const setText = pl => pl.map(p => `${p.op.name}(${p.r},${p.c})${p.dir}`).join(' ');
  say(`8a. surrogate pool: ${pool.length} distinct sets from the branch-and-bound top ${TOP_POOL} (surrogate value ${pool.length ? pct(Math.min(...pool.map(e => e.value)), hpTotal) + ' to ' + pct(Math.max(...pool.map(e => e.value)), hpTotal) : 'n/a'})${FILL_FREE_SLOTS ? '; free deploy slots filled greedily, the optimum also kept as is' : ''}.`,
    `8b. screen: ${screened.length} sets x up to ${perSet} heuristic deploy order(s) (${SCREEN_ORDERS.slice(0, perSet).join(', ')}), all deploys asap, skills asap: ${screenSims} simulator calls.`
      + ` one simulate() ~ ${perSim.toFixed(1)} ms (median of ${PROBE_RUNS}).${scaledNote ? ' NOTE: ' + scaledNote + '.' : ''}`,
    `    Spearman(surrogate value, screen score) over the ${scr.length} sets = ${rhoScreen != null ? rhoScreen.toFixed(3) : tied ? 'undefined: the surrogate gives every set the same value (each enemy it can reach is already covered up to its HP), so it cannot rank them' : 'undefined (fewer than 2 sets or a constant score)'}.`,
    `    Spearman(uncapped potential = sum of pot without the min(HP, .) cap, screen score) = ${rhoRaw == null ? 'undefined' : rhoRaw.toFixed(3)} (does more overkill margin predict the simulator?).`);
  say(...table(['screen', 'surrogate', 'value', 'uncapped', 'order', 'one-run result', 'set'],
    byScreen.slice(0, SCREEN_SHOW).map((e, i) => [`#${i + 1}`, `#${e.rank}${e.tag ? ' ' + e.tag : ''}`, pct(e.value, hpTotal), pct(e.raw, hpTotal), e.screen.order, brief(e.screen.result), setText(e.screen.placements)]), [2, 3]));
  if (byScreen.length > SCREEN_SHOW) say(`  ... ${byScreen.length - SCREEN_SHOW} more`);
  // 8c. refine: the best screened sets get the full timeline search, then local placement moves on the winner
  say(`8c. timeline.refine on the ${chosen.length} best screened sets with the remaining ${Math.max(0, sims - screenSims)} simulator calls: ${Math.round(100 * TL.REFINE_SET_SHARE)}% split over the sets for optimizeTimeline`,
    `    (deploy order search -> skill timing -> deploy delays -> skill timing, then rounds until nothing improves), the rest for local placement moves on the best set.`);
  const ref = chosen.length ? TL.refine(stage, chosen.map(e => e.screen.placements), simOpts, { maxSims: Math.max(0, sims - screenSims), cache, swapPool: ops, top: chosen.length })
    : { plan: { deploys: [], skills: {} }, result: sim.simulate(stage, { deploys: [] }, simOpts), ranked: [], spearman: null, stats: { sims: 1, moves: [], exhausted: false, timeMs: 0 } };
  const byRank = [...ref.ranked].sort((a, b) => a.surrogateRank - b.surrogateRank);
  for (const x of byRank) {
    let prev = x.startScore;
    const trail = (x.phases || []).map(p => { const s = `${p.phase} ${p.sims}${p.score != null && p.score !== prev ? ' -> ' + shortScore(p.score) : ' ='}`; if (p.score != null) prev = p.score; return s; });
    say(`  screen #${x.surrogateRank + 1}: start ${shortScore(x.startScore)}; phases (sims, score after): ${trail.join(', ') || 'none'}`,
      `    after ${x.sims} sims${x.exhausted ? ' (cut by the budget)' : ' (converged)'}${x.refined ? ' and the local moves below' : ''}: ${brief(x.result)}`);
  }
  const mv = ref.stats.moves || [];
  say(`  simulator ranking: ${ref.ranked.map(x => 'screen #' + (x.surrogateRank + 1)).join(' > ')}; Spearman(screen rank, refined score) = ${ref.spearman == null ? 'undefined' : ref.spearman.toFixed(3)}`,
    `  local moves on the best set (rotate / step to a neighbour tile / swap in an unused operator, a short skill search after each): ${mv.length ? mv.map(m => `${m.move} ${m.op} -> ${Array.isArray(m.to) ? '(' + m.to.join(',') + ')' : m.to} (${shortScore(m.score)})`).join('; ') : 'none improved'}`,
    `Honest note: the surrogate scores damage on unblocked nominal paths only; it does not see blocking (held enemies take more hits and do not leak), when DP pays for each deploy, healing or tanking, team buffs, or when skills fire, so its ranking of near-equal sets is close to noise and the simulator decides.`,
    `refine: ${ref.stats.sims} simulator calls, ${ms(ref.stats.timeMs || 0)}${ref.stats.exhausted ? ', at least one search cut by its budget share' : ', converged before its budget ran out'}.`);
  let plan = ref.plan, result = ref.result, polish = null;
  // 8d. polish: the short skill search after a placement move is budget-bound (timeline.REFINE_SKILL_SIMS), so the
  // winner gets optimizeTimeline once more, started from its refined timeline (a memo hit), with what is left.
  const leftover = sims - cache.sims;
  if (leftover > 1 && plan && plan.deploys.length && ref.ranked.length && ref.ranked[0].refined) {
    const pol = TL.optimizeTimeline(stage, plan.deploys.map(d => ({ op: d.op, r: d.r, c: d.c, dir: d.dir, t: d.t })), simOpts, { cache, maxSims: leftover, skills: plan.skills });
    const gain = pol.result && sim.compareResults(pol.result, result) < 0;
    polish = { sims: pol.stats.sims, improved: !!gain, exhausted: pol.stats.exhausted, before: result.score, after: pol.result ? pol.result.score : null };
    say(`8d. polish: optimizeTimeline again on the winner after its placement moves, ${pol.stats.sims} simulator calls${pol.stats.exhausted ? ' (budget-bound)' : ''}: ${gain ? brief(result) + '  ->  ' + brief(pol.result) : 'no improvement'}`);
    if (gain) { plan = pol.plan; result = pol.result; }
  }
  // 8e. tidy (never worse): a MANUAL skill started with no enemy in its skill range, or charged and never used, looks
  // wrong to a player even when the score cannot tell (a tie: e.g. a clean win, or a use that changes nothing scored). Each such operator gets the policy
  // {minEnemiesInRange: 1} (sim: counted in the active range) if the result is not worse; then the concrete timeline.
  let tidy = null;
  if (TIDY_WASTED_SKILLS && plan && plan.deploys.length && cache.sims < sims) {
    const s0 = cache.sims, tr0 = sim.simulate(stage, plan, { ...simOpts, trace: true });
    const wasted = [...new Set(wastedSkillUses(stage, plan, tr0, enemies).filter(w => w.trigger === 'MANUAL').map(w => w.name).concat(chargedUnused(plan, tr0).map(c => c.name)))];
    if (wasted.length) {
      let p = plan, r = result;
      const kept = [];
      for (const name of wasted) {
        const p2 = { ...p, skills: { ...p.skills, [name]: { minEnemiesInRange: 1 } } }, r2 = TL.evaluate(stage, p2, simOpts, cache);
        if (r2 && sim.compareResults(r2, r) <= 0) { p = p2; r = r2; kept.push(name); }
      }
      let note = 'no change kept';
      if (kept.length) {
        const c = TL.concreteTimeline(stage, p, simOpts, { cache });
        if (c.canonical && sim.compareResults(c.result, result) <= 0) { plan = c.plan; result = c.result; note = `policy kept for ${kept.join(', ')}: ${brief(result)}`; } else kept.length = 0;
      }
      tidy = { wasted, kept, sims: cache.sims - s0 + 1 };
      say(`8e. tidy: ${wasted.join(', ')} started a MANUAL skill with no enemy in its skill range or never used a charged one; tried {minEnemiesInRange: 1} (${tidy.sims} sims): ${note}.`);
    }
  }
  say(`search total: ${cache.sims} simulator calls (budget ${sims}), ${cache.hits} memo hits.`);
  out.timeline = { sims: cache.sims, maxSims: sims, screenSims, scaled: !!scaledNote, scaledNote, perSimMs: perSim, hits: cache.hits, pool: pool.length, tied, rhoScreen, rhoRaw, spearman: ref.spearman, moves: mv, polish, tidy,
    screen: byScreen.map(e => ({ rank: e.rank, value: e.value, order: e.screen.order, score: e.screen.result.score })),
    sets: byRank.map(x => ({ screenRank: x.surrogateRank, startScore: x.startScore, phases: x.phases, sims: x.sims, exhausted: x.exhausted, result: x.result && { lifeLost: x.result.lifeLost, kills: x.result.kills, hpFrac: x.result.hpRemoved / x.result.hpTotal, score: x.result.score } })) };

  // ---- 9. result ----
  section(9, 'RESULT', 'the chosen combat timeline');
  const traced = sim.simulate(stage, plan, { ...simOpts, trace: true });
  const replay = sim.simulate(stage, plan, simOpts), reproduces = util.isDeepStrictEqual(replay, result);
  const enemyBy = new Map(enemies.map(e => [e.id, e])), autoOps = new Set(plan.deploys.filter(d => kitOf(d.op).spec && kitOf(d.op).spec.trigger === 'AUTO').map(d => d.op.name));
  say(C.asciiMap(stage, plan.deploys), '');
  const tlText = TL.formatTimeline({ ...traced, skillUses: traced.skillUses.filter(u => !autoOps.has(u.name)) })
    .replace(/leak: enemy #(\d+)/g, (m, id) => `leak: enemy #${id} ${enemyBy.has(Number(id)) ? enemyBy.get(Number(id)).name : ''}`.trimEnd());
  say(tlText);
  for (const name of autoOps) {
    const u = traced.skillUses.filter(x => x.name === name);
    say(`${name}: AUTO skill ${u.length ? u[0].skill : ''} fired ${u.length} time(s) on its own${u.length ? ` (first ${f1(u[0].t)} s, last ${f1(u[u.length - 1].t)} s)` : ''}; not a decision, so not listed above`);
  }
  say(`re-simulating this plan reproduces the reported result: ${reproduces ? 'yes' : 'NO'}`, '');
  const dmgTotal = traced.perOp.reduce((s, p) => s + p.damage, 0), depT = new Map(traced.deploys.map(d => [d.name, d.t])), lossT = new Map(traced.losses.map(l => [l.name, l.t]));
  say(...table(['operator', 'deployed', 'damage', 'share', 'healing', 'kills', 'blocked', 'dmg taken', 'skill uses', 'skill uptime', 'down'],
    traced.perOp.map(p => {
      const t0 = depT.get(p.name), onField = t0 == null ? 0 : (lossT.get(p.name) ?? traced.duration) - t0;
      return [p.name, t0 == null ? 'never' : f1(t0) + ' s', Math.round(p.damage), pct(p.damage, dmgTotal), Math.round(p.healing), p.kills, f1(p.blockedSeconds) + ' e-s', Math.round(p.damageTaken),
        traced.skillUses.filter(u => u.name === p.name).length, `${f1(p.skillUptime)} s (${pct(p.skillUptime, onField)})`, p.died ? f1(lossT.get(p.name)) + ' s' : ''];
    }), [2, 3, 4, 5, 6, 7, 8, 9]));
  const dp = traced.dp;
  say(`DP: ${dp.initial} at start + ${f1(dp.generated)} generated (regeneration and DP skills) = ${f1(dp.initial + dp.generated)}; spent ${dp.spent} on deploys, refunded ${dp.refunded}, ${f1(dp.endUnspent)} unspent at the end`);
  const leakIds = traced.trace.events.filter(e => e.type === 'leak').map(e => e.id), leakBy = new Map();
  for (const id of leakIds) { const n = (enemyBy.get(id) || { name: '#' + id }).name; leakBy.set(n, (leakBy.get(n) || 0) + 1); }
  const leakList = [...leakBy.entries()].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${k} x ${n}`).join(', ');
  const verdict = result.win ? `The plan HOLDS the stage in the model: no life lost, all ${result.totalEnemies} enemies dead in ${f1(result.duration)} s.`
    : `The roster as placed does NOT hold this stage in the model: ${result.lifeLost} life lost (life points ${result.lifePoints}), ${result.leaks} of ${result.totalEnemies} enemies leaked${leakList ? ' (' + leakList + ')' : ''}, ${result.alive || 0} still alive at the end${result.timedOut ? ' (time limit)' : ''}; ${pct(result.hpRemoved, result.hpTotal)} of enemy HP removed.`;
  say(verdict);
  const pl = plausibility(stage, plan, traced, enemies);
  say('', 'plausibility checks (what a player would question):', ...pl.info.map(l => '  ' + l), ...(pl.flags.length ? pl.flags.map(l => '  FLAG: ' + l) : ['  no flag raised']));
  const warnings = [];
  for (const d of plan.deploys) {
    const k = kitOf(d.op), s = k.spec;
    if (!s) { warnings.push(`${d.op.name}: no skill`); continue; }
    warnings.push(`${d.op.name}: S${d.op.skillIndex + 1} ${s.name} Lv${s.level} ${s.trigger}/${s.spType}, fidelity ${s.fidelity}${s.notes.length ? ': ' + s.notes.join('; ') : ''}`);
    const ign = ['atkScaleMelee', 'proc', 'onHitDebuff'].filter(f => [k.base, k.active].some(p => p && p[f] != null));
    if (s.squad && s.squad.redeployPct) ign.push('squad.redeployPct');
    if (ign.length) warnings.push(`${d.op.name}: the simulator does not honour ${ign.join(', ')}`);
  }
  say('', 'skill fidelity warnings for the operators used:', ...warnings.map(w => '  ' + w));
  out.plan = plan; out.result = result; out.traced = traced; out.reproduces = reproduces; out.verdict = verdict; out.leaks = leakList; out.plausibility = pl; out.warnings = warnings; out.timelineText = tlText;

  // ---- 10. robustness ----
  section(10, 'Robustness', 'Monte Carlo');
  if (random) {
    const mc = TL.monteCarlo(stage, plan, simOpts, MC_SEEDS), tot = mc.perSeed.map(x => x.totalEnemies);
    say(`the same timeline replayed on spawn seeds 1-${mc.n} (tuned on seed ${o.seed}; explicit skill and deploy times are replayed as is, not re-optimised per seed):`,
      `life lost mean ${mc.lifeLost.mean.toFixed(2)} [${mc.lifeLost.min}, ${mc.lifeLost.max}], HP removed mean ${(100 * mc.hpFrac.mean).toFixed(1)}% [${(100 * mc.hpFrac.min).toFixed(1)}, ${(100 * mc.hpFrac.max).toFixed(1)}], win rate ${(100 * mc.winRate).toFixed(0)}%, enemies per run ${Math.min(...tot)}-${Math.max(...tot)}, ${ms(mc.timeMs)}`);
    const stalls = mc.perSeed.filter(x => !x.win && x.lifeLost === 0).length;
    if (stalls) say(`${stalls} seed(s) lost no life but were not cleared: enemies still alive at the time limit (a stall, not a win).`);
    out.mc = mc;
  } else { say('deterministic stage: no random spawn groups in this mode, one run is exact.'); out.mc = { n: 1, deterministic: true }; }

  // ---- outputs ----
  const fileOf = (v, ext) => (v === true ? path.join(OUT_DIR, stage.name + '.' + ext) : path.resolve(String(v)));
  if (o.html) {
    const notes = [`Plan: combat/demo.js: candidates.js + optimize.js surrogate (K ${o.K}), screened in the simulator, then timeline.refine on the ${chosen.length} best; ${out.timeline.sims} simulator calls in all.`,
      `Roster: ${path.basename(rosterPath)}${R.raw.example ? ' (example, not the user\'s)' : ''}; collectibles: ${(R.raw.collectibles || []).map(c => c.name).join(', ') || 'none'}.`,
      verdict, ...assumptions, ...pl.flags.map(f => 'Plausibility flag: ' + f), ...warnings,
      'Heat overlay: enemy HP x seconds per tile along the nominal unblocked paths (candidates.heatmaps).'];
    const html = RD.renderHtml({ stage, result: traced, plan, meta: { title: `${stage.name}: best timeline found`, secrecy: o.secrecy, floor: o.floor, elite: o.elite, seed: o.seed, tps: sim.TPS_DEFAULT,
      enemies, heat: hm.hp, heatLabel: 'HP-seconds per tile on the nominal paths', notes } });
    out.html = fileOf(o.html, 'html');
    fs.mkdirSync(path.dirname(out.html), { recursive: true });
    fs.writeFileSync(out.html, html);
  }
  if (o.json) {
    const { trace, ...plainResult } = result;
    out.json = fileOf(o.json, 'json');
    fs.mkdirSync(path.dirname(out.json), { recursive: true });
    fs.writeFileSync(out.json, JSON.stringify({ stage: { name: stage.name, id: stage.id }, options: { ...o, roster: path.basename(rosterPath) }, plan: planJson(plan, R), result: plainResult, verdict, assumptions }, null, 1));
  }

  // ---- 11. timings ----
  section(11, 'Timings', '');
  const names = ['stage and enemies', 'operators', 'heatmap', 'candidates', 'small instance', 'full instance', 'opening', 'timeline search', 'result', 'robustness + outputs'];
  const total = now() - T0;
  say(...table(['section', 'time'], timings.map(t => [`${t.n}. ${names[t.n - 1]}`, ms(t.ms)]).concat([['total', (total / 1000).toFixed(1) + ' s']]), [1]));
  if (out.html) say(`wrote ${out.html} (${fs.statSync(out.html).size} bytes)`);
  if (out.json) say(`wrote ${out.json} (${fs.statSync(out.json).size} bytes)`);
  out.timings = { sections: timings, totalMs: total };
  out.text = lines.join('\n');
  out.stage = stage; out.simOpts = simOpts; out.limit = limit; out.enemies = enemies; out.ops = ops;
  return out;
}

module.exports = { run, parseArgs, completeSet, rawPotential, firstContact, firstArrival, plausibility, decodeScore,
  STAGE_DEFAULT, SIMS_DEFAULT, TIMELINE_SECONDS_TARGET, PROBE_RUNS, SMALL, TOP_POOL, SCREEN_SHARE, SCREEN_ORDERS, TOP_SETS, FILL_FREE_SLOTS, TIDY_WASTED_SKILLS, MC_SEEDS, QUICK_DEATH_S, USAGE, wastedSkillUses, chargedUnused };

if (require.main === module) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help) { console.log(USAGE); process.exit(0); }
  const res = run(opts);
  if (!res.small.equal) { console.error('section 5: brute force and branch and bound disagree'); process.exitCode = 1; }
  if (!res.reproduces) { console.error('section 9: re-simulating the final plan did not reproduce the result'); process.exitCode = 1; }
}
