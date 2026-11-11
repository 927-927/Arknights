// v0 stage model: map -> tile tensor, waves -> enemy timeline, timeline -> space-time occupancy.
// Data: tomimi.dev stage files (research/sources/tomimi), enemy stats from ArknightsGameData.
// Usage: node combat/stage_model.js <stage name or tomimi index> [tilesPerSecondAtSpeed1]
'use strict';
const fs = require('fs');
const path = require('path');
const { decodeFile } = require('../research/scripts/tomimi_decode.js');

const ROOT = path.resolve(__dirname, '..');
const TDIR = path.join(ROOT, 'research', 'sources', 'tomimi');

// ---------- enemies ----------
let ENEMY_DB = null;
function enemyStats(key, level) {
  if (!ENEMY_DB) ENEMY_DB = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'sources', 'gamedata', 'enemy_database.json'), 'utf8')).enemies.map(e => [e.Key, e.Value]));
  const levels = ENEMY_DB.get(key);
  if (!levels) return null;
  const base = levels.find(l => l.level === 0) || levels[0];
  const lv = levels.find(l => l.level === level) || base;
  const a = n => { const x = lv.enemyData.attributes[n], b = base.enemyData.attributes[n]; return x && x.m_defined ? x.m_value : b ? b.m_value : 0; };
  const f = n => { const x = lv.enemyData[n], b = base.enemyData[n]; return x && x.m_defined ? x.m_value : b && typeof b === 'object' && 'm_value' in b ? b.m_value : b; };
  // d(): like f(), but a field that is not m_defined at either level is undefined (so the game default applies).
  const d = n => { const x = lv.enemyData[n], b = base.enemyData[n]; return x && x.m_defined ? x.m_value : b && b.m_defined ? b.m_value : undefined; };
  // life: lifePointReduce defaults to 1 when undefined (checked against tomimi's per-stage stats on all 77 stages).
  // Added for sim.js (extra fields only): baseAttackTime, attackSpeed, rangeRadius (raw m_value, as tomimi shows it;
  // <= 0 = none), applyWay ('MELEE'|'RANGED'|'ALL'|'NONE'|null), notCount (notCountInTotal), massLevel (= weight;
  // enemyTimeline reuses `weight` for the spawn share).
  return { key, name: f('name'), type: f('levelType') || 'NORMAL', motion: f('motion') || 'WALK', hp: a('maxHp'), atk: a('atk'), def: a('def'), res: a('magicResistance'), speed: a('moveSpeed'), interval: a('baseAttackTime') * 100 / Math.max(10, a('attackSpeed')), weight: a('massLevel'), life: d('lifePointReduce') ?? 1,
    baseAttackTime: a('baseAttackTime'), attackSpeed: a('attackSpeed'), rangeRadius: f('rangeRadius') ?? -1, applyWay: f('applyWay') || null, notCount: !!d('notCountInTotal'), massLevel: a('massLevel') };
}

// ---------- map ----------
// tomimi tile rows: [tileKey, isHighGround, blocksGroundMovement, effect, deployable]
// variant (optional, sim.js extension): index into the file's `stages` list (9 files carry 2-3 variants of one
// stage, e.g. the boss stages and their _dlc1 versions); omitted = the file's top-level mapConfig, as before.
function loadStage(which, variant) {
  const index = fs.readFileSync(path.join(TDIR, 'index.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t'));
  const hit = index.find(([i, slug]) => i === String(which) || slug.endsWith(which));
  if (!hit) throw new Error('stage not found: ' + which);
  const file = decodeFile(path.join(TDIR, hit[0] + '.json'));
  const entry = (file.stages || [])[variant || 0];
  if (variant && !entry) throw new Error('stage ' + which + ' has no variant ' + variant);
  const mc = variant ? entry.mapConfig : file.mapConfig;
  const md = mc.mapData;
  const H = md.map.length, W = md.map[0].length;
  const tile = (r, c) => md.tiles[md.map[r][c]];
  const grid = [];
  for (let r = 0; r < H; r++) {
    const row = [];
    for (let c = 0; c < W; c++) {
      const t = tile(r, c);
      const key = t[0];
      row.push({ key, high: !!t[1], walkable: !t[2] && key !== 'tile_hole' && key !== 'tile_forbidden', deployable: !!t[4], hole: key === 'tile_hole' });
    }
    grid.push(row);
  }
  // route positions count rows from the bottom; the grid counts from the top
  const toGrid = p => ({ r: H - 1 - p.row, c: p.col });
  // enemyInfo (sim.js extension): tomimi's per-stage enemy sheet keyed by the id used in spawn actions; carries
  // forms[0].normal_attack.atk_type (e.g. ["ranged","arts"]) and hits, which enemy_database does not have.
  const enemyInfo = new Map(((entry && entry.enemies) || []).map(e => [e.stageId || e.key, e]));
  return { mc, H, W, grid, toGrid, name: mc.name_zh, id: mc.id, deployLimit: mc.characterLimit, initialCost: mc.initialCost, costIncreaseTime: mc.costIncreaseTime, maxCost: mc.maxCost, enemyInfo };
}

// ---------- paths ----------
// Shortest path over walkable tiles, 8 directions without cutting corners (allowDiagonalMove).
function shortestPath(st, from, to, fly) {
  const { H, W, grid } = st;
  const ok = (r, c) => r >= 0 && c >= 0 && r < H && c < W && (fly || grid[r][c].walkable || grid[r][c].key.includes('tel') || grid[r][c].key === 'tile_start' || grid[r][c].key === 'tile_end');
  const dist = Array.from({ length: H }, () => new Array(W).fill(Infinity));
  const prev = Array.from({ length: H }, () => new Array(W).fill(null));
  dist[from.r][from.c] = 0;
  const open = [[0, from.r, from.c]];
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [d, r, c] = open.shift();
    if (d > dist[r][c]) continue;
    if (r === to.r && c === to.c) break;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (!ok(nr, nc)) continue;
      if (dr && dc && !(ok(r + dr, c) && ok(r, c + dc))) continue; // no corner cutting
      const nd = d + (dr && dc ? Math.SQRT2 : 1);
      if (nd < dist[nr][nc]) { dist[nr][nc] = nd; prev[nr][nc] = [r, c]; open.push([nd, nr, nc]); }
    }
  }
  if (dist[to.r][to.c] === Infinity) return null;
  const out = [];
  for (let cur = [to.r, to.c]; cur; cur = prev[cur[0]][cur[1]]) out.unshift({ r: cur[0], c: cur[1] });
  return out;
}

// Straight line between two tiles as king moves (one waypoint per tile), for legs shortestPath cannot solve.
function straightLine(a, b) {
  const n = Math.max(Math.abs(b.r - a.r), Math.abs(b.c - a.c)), out = [a];
  for (let k = 1; k <= n; k++) out.push({ r: Math.round(a.r + (b.r - a.r) * k / n), c: Math.round(a.c + (b.c - a.c) * k / n) });
  return out;
}

// A route becomes a list of timed waypoints: [{r, c, t}] relative to spawn, given tiles per second.
// opts (optional, sim.js extension; without it the output is exactly the v0 one):
//   straightFallback  a MOVE leg with no walkable path (123 legs in the 77 stages: enemies crossing tile_hole,
//                     e.g. the 8 parrots circling in 彼处水如酒) is walked in a straight line tile by tile instead
//                     of jumping there in one step.
//   strictHidden      every waypoint between DISAPPEAR and APPEAR_AT_POS is flagged hidden (v0 flags only the first,
//                     which un-hides the enemy when two waits or a MOVE follow the DISAPPEAR).
//   fragOffset        seconds between the start of the enemy's fragment and its spawn. With it,
//                     WAIT_CURRENT_FRAGMENT_TIME waits UNTIL the fragment clock reaches cp.time (v0: waits cp.time).
//                     ASSUMPTION: "current fragment" = the fragment the enemy spawned in, unblocked walking.
function routeTimeline(st, route, tps, fly, opts) {
  const o = opts || {};
  const pts = [];
  let t = 0, hide = false;
  let pos = st.toGrid(route.startPosition);
  const push = p => pts.push(hide && o.strictHidden ? { ...p, hidden: true } : p);
  pts.push({ ...pos, t });
  const walkTo = target => {
    const p = shortestPath(st, pos, target, fly) || (o.straightFallback ? straightLine(pos, target) : [pos, target]);
    for (let k = 1; k < p.length; k++) {
      const step = (p[k].r !== p[k - 1].r && p[k].c !== p[k - 1].c) ? Math.SQRT2 : 1;
      t += step / tps;
      push({ ...p[k], t });
    }
    pos = target;
  };
  for (const cp of route.checkpoints || []) {
    if (cp.type === 'MOVE') walkTo(st.toGrid(cp.position));
    else if (cp.type === 'WAIT_CURRENT_FRAGMENT_TIME' && o.fragOffset != null) { t = Math.max(t, (cp.time || 0) - o.fragOffset); push({ ...pos, t }); }
    else if (cp.type === 'WAIT_FOR_SECONDS' || cp.type === 'WAIT_FOR_PLAY_TIME' || cp.type === 'WAIT_CURRENT_FRAGMENT_TIME') { t += cp.time || 0; push({ ...pos, t }); }
    else if (cp.type === 'DISAPPEAR') { pts.push({ ...pos, t, hidden: true }); hide = true; }
    else if (cp.type === 'APPEAR_AT_POS') { hide = false; pos = st.toGrid(cp.position); pts.push({ ...pos, t }); }
  }
  walkTo(st.toGrid(route.endPosition));
  return pts;
}

// ---------- waves -> enemy instances ----------
// Waves are treated as back to back (lower bound: the game waits for each wave to be cleared).
// Spawns in a hiddenGroup only fire when a stage mechanic or mode triggers them; pass includeHidden to add them.
function enemyTimeline(st, tps, includeHidden) {
  const mc = st.mc;
  const out = [];
  let waveStart = 0;
  for (const wave of mc.waves) {
    let waveEnd = waveStart;
    let fragStart = waveStart + (wave.preDelay || 0);
    for (const frag of wave.fragments) {
      fragStart += frag.preDelay || 0;
      // random spawn groups: keep every option, weighted by its share
      const groupWeight = {};
      for (const a of frag.actions) if (a.randomSpawnGroupKey) groupWeight[a.randomSpawnGroupKey] = (groupWeight[a.randomSpawnGroupKey] || 0) + (a.weight || 0);
      let fragEnd = fragStart;
      for (const a of frag.actions) {
        if (a.actionType !== 'SPAWN') continue;
        if (a.hiddenGroup && !includeHidden) continue;
        const share = a.randomSpawnGroupKey && groupWeight[a.randomSpawnGroupKey] ? a.weight / groupWeight[a.randomSpawnGroupKey] : 1;
        const lvl = (mc.enemies || []).find(e => (e.prefabKey || e.id) === a.key);
        const stats = enemyStats(a.key, lvl ? lvl.level : 0);
        const route = mc.routes[a.routeIndex];
        if (!stats || !route) continue;
        const fly = stats.motion === 'FLY' || route.motionMode === 'FLY';
        const path = routeTimeline(st, route, tps * Math.max(0.05, stats.speed), fly);
        for (let k = 0; k < a.count; k++) {
          const spawn = fragStart + (a.preDelay || 0) + k * (a.interval || 0);
          out.push({ ...stats, spawn, weight: share, path, leaveAt: spawn + path[path.length - 1].t });
          fragEnd = Math.max(fragEnd, spawn);
        }
      }
      waveEnd = Math.max(waveEnd, fragEnd);
    }
    waveStart = waveEnd + (wave.postDelay || 0);
  }
  return out.sort((a, b) => a.spawn - b.spawn);
}

// ---------- occupancy: enemy-seconds (and HP-seconds) spent on each tile ----------
function occupancy(st, enemies) {
  const time = Array.from({ length: st.H }, () => new Array(st.W).fill(0));
  const hp = Array.from({ length: st.H }, () => new Array(st.W).fill(0));
  for (const e of enemies) {
    for (let k = 1; k < e.path.length; k++) {
      const a = e.path[k - 1], b = e.path[k];
      if (a.hidden) continue;
      const dt = b.t - a.t;
      time[a.r][a.c] += e.weight * dt;
      hp[a.r][a.c] += e.weight * dt * e.hp;
    }
  }
  return { time, hp };
}

module.exports = { loadStage, enemyStats, shortestPath, routeTimeline, enemyTimeline, occupancy };

// ---------- CLI: print the tensors for one stage ----------
if (require.main === module) {
  const st = loadStage(process.argv[2] || '彼处水如酒');
  const tps = Number(process.argv[3] || 1);
  const sym = t => t.hole ? 'O' : t.key === 'tile_start' ? 'S' : t.key === 'tile_end' ? 'E' : t.key.startsWith('tile_tel') ? 'T' : t.high && t.deployable ? '^' : t.deployable ? '_' : t.walkable ? '.' : '#';
  console.log(`${st.name} (${st.id})  ${st.H}x${st.W}  deploy limit ${st.deployLimit}, cost ${st.initialCost}`);
  console.log('legend: ^ high ground (deployable)  _ ground (deployable)  . walkable, not deployable  # blocked  O hole  S spawn  E exit  T teleport');
  st.grid.forEach(row => console.log('  ' + row.map(sym).join(' ')));
  const en = enemyTimeline(st, tps);
  const hidden = enemyTimeline(st, tps, true).length - en.length;
  if (hidden) console.log('(' + hidden + ' conditional spawns in hidden groups left out)');
  const occ = occupancy(st, en);
  const shade = (v, max) => (v <= 0 ? ' ·' : String(Math.min(9, Math.round(9 * v / max))).padStart(2));
  const maxT = Math.max(...occ.time.flat()), maxH = Math.max(...occ.hp.flat());
  console.log('\nenemy-seconds per tile (0-9 scale, max ' + maxT.toFixed(1) + ' s):');
  occ.time.forEach(row => console.log(' ' + row.map(v => shade(v, maxT)).join('')));
  console.log('\nHP-seconds per tile (0-9 scale): where damage dealt is worth most');
  occ.hp.forEach(row => console.log(' ' + row.map(v => shade(v, maxH)).join('')));
  const byName = {};
  for (const e of en) { const k = e.name; byName[k] = byName[k] || { n: 0, hp: e.hp, def: e.def, res: e.res, speed: e.speed, type: e.type, first: e.spawn }; byName[k].n += e.weight; }
  console.log('\nroster (expected count):');
  for (const [k, v] of Object.entries(byName)) console.log(`  ${k.padEnd(12, '　')} x${v.n.toFixed(1).padStart(4)}  HP ${String(v.hp).padStart(6)}  DEF ${String(v.def).padStart(4)}  RES ${String(v.res).padStart(3)}  speed ${v.speed}  ${v.type}  first at ${v.first.toFixed(0)}s`);
  const T = Math.ceil(Math.max(...en.map(e => e.leaveAt)));
  const buckets = new Array(Math.ceil(T / 10)).fill(0);
  for (const e of en) for (let t = Math.floor(e.spawn / 10); t <= Math.min(buckets.length - 1, Math.floor(e.leaveAt / 10)); t++) buckets[t] += e.weight;
  console.log('\nenemies on the field per 10 s (if nobody dies):');
  console.log('  ' + buckets.map((b, i) => `${i * 10}s:${b.toFixed(0)}`).join(' '));
}
