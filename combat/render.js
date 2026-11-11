// Viewer: one self-contained HTML page that replays a simulated combat timeline (map + timeline + summary).
//   renderHtml({stage, result, plan, meta}) -> string   (inline CSS and JS, no external requests, works from file://)
// The page embeds ONE JSON blob (<script type="application/json" id="bf-data">) holding the result unchanged.
// CLI: node combat/render.js <stage> [--out file] [--secrecy n] [--floor n] [--seed n] [--elite]
//   simulates a small legal plan from roster.example.json with trace:true and writes combat/out/<stage>.html.
'use strict';
const fs = require('fs');
const path = require('path');

// Tile categories (index = code stored in the page). Spawn/exit/teleport keys win over deployability.
const TILE_CATS = ['blocked', 'ground', 'high', 'walk', 'hole', 'spawn', 'exit', 'tel'];
function tileCat(t) {
  const k = String(t.key || '');
  if (t.hole || k === 'tile_hole') return 4;
  // ASSUMPTION (display only): tile_flystart (13 tiles in the 77 stages) and tile_ftstart (9) are spawn points, from the key names.
  if (/^tile_(fly|ft)?start/.test(k)) return 5;
  if (k === 'tile_end') return 6;
  if (k.startsWith('tile_tel')) return 7;                  // tile_telin / tile_telout
  if (t.deployable) return t.high ? 2 : 1;
  return t.walkable ? 3 : 0;
}

// ASSUMPTION (display only): an enemy that moved more than this many tiles (|dr| + |dc|) between two 0.5 s trace frames
// jumped (teleport) and is snapped; anything closer is drawn linearly interpolated, as if it walked in a straight line.
const INTERP_SNAP_TILES = 2;

// JSON that is safe inside <script>: '<', '>', '&', U+2028/9 only occur inside JSON strings, where \uXXXX is equivalent.
const safeJson = v => JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Range offsets (facing east) -> on-grid tiles [[r, c]] for an operator at (r, c) facing dir.
function rangeTiles(range, r, c, dir, H, W) {
  if (!Array.isArray(range)) return [];
  const out = [], seen = new Set();
  for (const o of require('./operators.js').rotate(range, dir || 'E')) {
    const rr = r + o.dr, cc = c + o.dc;
    if (rr < 0 || cc < 0 || rr >= H || cc >= W || seen.has(rr * W + cc)) continue;
    seen.add(rr * W + cc); out.push([rr, cc]);
  }
  return out;
}

// Per planned operator: tile, facing, base and skill range tiles, skill summary, deploy and loss from the result.
function opsInfo(stage, plan, result) {
  const deps = new Map((result.deploys || []).map(d => [d.name, d])), loss = new Map((result.losses || []).map(l => [l.name, l]));
  const out = [], seen = new Set(), H = stage.H, W = stage.W;
  const add = (op, d) => {
    const name = op.name || d.name;
    if (!name || seen.has(name)) return;
    seen.add(name);
    const dep = deps.get(name) || null, r = dep ? dep.r : d.r, c = dep ? dep.c : d.c, dir = dep ? dep.dir : d.dir;
    let base = op.range, active = null, skill = null;
    if (op.id) {
      try {   // profiles may change the range (talents, skills); a failure here only loses the range highlight
        const K = require('./skills.js'), spec = op.skillSpec || K.compileSkill(op), pr = op.profiles || K.profiles(op, spec);
        if (pr && pr.base && pr.base.range) base = pr.base.range;
        if (pr && pr.active && pr.active.range) active = pr.active.range;
        if (spec) skill = { name: spec.name, level: spec.level, index: op.skillIndex, trigger: spec.trigger, spType: spec.spType,
          spCost: spec.spCost, initSp: spec.initSp, duration: spec.duration, fidelity: spec.fidelity };
      } catch (e) { skill = { error: String(e.message || e) }; }
    }
    const bt = rangeTiles(base, r, c, dir, H, W);
    let at = active ? rangeTiles(active, r, c, dir, H, W) : null;
    if (at && at.length === bt.length && at.every(([a, b], k) => a === bt[k][0] && b === bt[k][1])) at = null;   // same as base
    out.push({ name, profession: op.profession || null, position: op.position || null, r, c, dir, planT: d.t || 0,
      dep: dep ? { t: dep.t, cost: dep.cost } : null, loss: loss.get(name) || null, skill, base: bt, active: at });
  };
  for (const d of (plan && plan.deploys) || []) add(d.op || {}, d);
  for (const d of result.deploys || []) add({}, d);         // deployed but missing from the plan given: no range
  return out;
}

// meta.heat: an H x W array of numbers, or stage_model.occupancy()'s {hp}; kept to 4 significant digits.
function heatGrid(heat, H, W) {
  const g = heat && !Array.isArray(heat) && Array.isArray(heat.hp) ? heat.hp : heat;
  if (!Array.isArray(g)) return null;
  return Array.from({ length: H }, (_, r) => Array.from({ length: W }, (_, c) => { const v = Number(g[r] && g[r][c]) || 0; return v > 0 ? Number(v.toPrecision(4)) : 0; }));
}

// HP-seconds per tile along the nominal (unblocked) enemy paths: the CLI's heat overlay.
function hpSeconds(stage, enemies) {
  const H = stage.H, W = stage.W, g = Array.from({ length: H }, () => new Array(W).fill(0));
  for (const e of enemies) for (let k = 1; k < e.path.length; k++) {
    const a = e.path[k - 1], b = e.path[k];
    if (a.hidden || a.r < 0 || a.c < 0 || a.r >= H || a.c >= W) continue;
    g[a.r][a.c] += (b.t - a.t) * e.hp;
  }
  return g;
}

function buildData({ stage, result, plan, meta } = {}) {
  if (!stage || !Array.isArray(stage.grid)) throw new Error('renderHtml: stage (stage_model.loadStage shape) is required');
  if (!result || typeof result !== 'object') throw new Error('renderHtml: result (sim.simulate) is required');
  const m = meta || {}, H = stage.H, W = stage.W;
  const enemies = {};
  for (const e of m.enemies || []) enemies[e.id] = [e.name || e.key || 'enemy', e.type || 'NORMAL', e.motion || 'WALK', Math.round(e.hp || 0)];
  return {
    v: 1,
    stage: { name: stage.name || '', id: stage.id || '', H, W, cat: stage.grid.map(row => row.map(tileCat)), keys: stage.grid.map(row => row.map(t => t.key)) },
    meta: { title: m.title || null, secrecy: m.secrecy ?? null, floor: m.floor ?? null, elite: !!m.elite, seed: m.seed ?? null, tps: m.tps ?? null,
      heatLabel: m.heatLabel || 'HP-seconds per tile', notes: (m.notes || []).map(String), snap: INTERP_SNAP_TILES },
    ops: opsInfo(stage, plan, result), enemies, heat: heatGrid(m.heat, H, W), result };
}

const CSS = `
:root{color-scheme:light;--bg:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);
--t-blocked:#d3d1c9;--t-ground:#ece5d3;--t-high:#a9b9cb;--t-walk:#fefdfa;--t-hole:#3d3c38;--t-spawn:#efb0a5;--t-exit:#b7d3f6;--t-tel:#d3cdf5;
--e-normal:#2a78d6;--e-elite:#eb6834;--e-boss:#1baf7a;--skill:#6250d6;--hp:#0ca30c;--sp:#eda100;--dp:#c98500;--s1:#2a78d6;--crit:#d03b3b;--heat:#eb6834;--range:#2a78d6;--good:#006300}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
--t-blocked:#0f0f0e;--t-ground:#3d3a31;--t-high:#4b596a;--t-walk:#272725;--t-hole:#000;--t-spawn:#7a3530;--t-exit:#1c5cab;--t-tel:#4a4291;
--e-normal:#3987e5;--e-elite:#d95926;--e-boss:#199e70;--skill:#9085e9;--s1:#3987e5;--crit:#e66767;--heat:#d95926;--range:#3987e5;--good:#0ca30c}}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif}
main{max-width:1240px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:0;overflow-wrap:anywhere}h1 small{font-size:13px;color:var(--muted);font-weight:400}
h2{font-size:15px;margin:0 0 6px}h3{font-size:16px;margin:0 0 4px}
.sub,.hint,.foot{color:var(--ink2);font-size:13px}.sub{margin:2px 0 10px}.hint{margin:-2px 0 6px}
.kpis{display:flex;flex-wrap:wrap;gap:8px}
.kpi{background:var(--surface);border:1px solid var(--ring);border-radius:8px;padding:6px 10px;min-width:92px}
.kpi .k{display:block;font-size:12px;color:var(--muted)}.kpi .v{font-size:17px;font-weight:600}
.kpi .good{color:var(--good)}.kpi .bad{color:var(--crit)}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:12px;margin-top:12px;min-width:0}
.stage{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:14px;margin-top:6px}
.cols{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:12px}
.cols>.card{margin-top:12px}
@media (max-width:860px){.stage,.cols{grid-template-columns:minmax(0,1fr)}}
.player{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.player input[type=range]{flex:1 1 180px;min-width:0;accent-color:var(--range)}
button{font:inherit;font-size:13px;padding:4px 10px;border-radius:6px;border:1px solid var(--axis);background:var(--surface);color:var(--ink);cursor:pointer}
button.on{background:var(--ink);color:var(--surface);border-color:var(--ink)}
.speeds{display:inline-flex;gap:4px}
.tnow,.status{font-variant-numeric:tabular-nums}.tnow{min-width:6.5em}
.status{color:var(--ink2);font-size:13px;margin:6px 0 0}
svg#map{width:100%;height:auto;display:block;touch-action:manipulation;user-select:none}
.t-blocked{fill:var(--t-blocked);background:var(--t-blocked)}.t-ground{fill:var(--t-ground);background:var(--t-ground)}
.t-high{fill:var(--t-high);background:var(--t-high)}.t-walk{fill:var(--t-walk);background:var(--t-walk)}
.t-hole{fill:var(--t-hole);background:var(--t-hole)}.t-spawn{fill:var(--t-spawn);background:var(--t-spawn)}
.t-exit{fill:var(--t-exit);background:var(--t-exit)}.t-tel{fill:var(--t-tel);background:var(--t-tel)}
.tile{stroke:var(--ring);stroke-width:1}
.glyph{font-size:15px;font-weight:700;text-anchor:middle;dominant-baseline:central;fill:var(--ink2);pointer-events:none}
.heat{fill:var(--heat);pointer-events:none}
.rng{fill:var(--range);fill-opacity:.24;stroke:var(--range);stroke-width:1.5;pointer-events:none}
.rng2{fill:none;stroke:var(--skill);stroke-width:1.5;stroke-dasharray:4 3;pointer-events:none}
.op{cursor:pointer}.op .opbox{fill:var(--surface);stroke:var(--ink2);stroke-width:1.2}
.op.planned{opacity:.4}.op.planned .opbox{stroke-dasharray:3 2}.op.gone{opacity:.35}.op.hide{display:none}
.op.planned .bars,.op.gone .bars{display:none}.op .gonex{stroke:var(--crit);stroke-width:2.5;display:none}.op.gone .gonex{display:inline}
.op.sel .opbox{stroke:var(--range);stroke-width:2.5}
.op.active .opbox{stroke:var(--skill);stroke-width:3;filter:url(#glow)}
.opname{text-anchor:middle;dominant-baseline:central;fill:var(--ink);font-weight:600}
.arrow{fill:var(--ink2)}.barbg{fill:var(--grid)}.hp{fill:var(--hp)}.sp{fill:var(--sp)}
.en .ring{fill:var(--surface);fill-opacity:.85;stroke:var(--e-normal);stroke-width:2}.en .core{fill:var(--e-normal)}
.en-elite .ring{stroke:var(--e-elite)}.en-elite .core{fill:var(--e-elite)}.en-boss .ring{stroke:var(--e-boss)}.en-boss .core{fill:var(--e-boss)}
.en.fly .ring{stroke-dasharray:3 2}
.legend{display:flex;flex-wrap:wrap;gap:3px 12px;font-size:12px;color:var(--ink2);margin-top:8px}
.sw{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin-right:4px;border:1px solid var(--ring)}
.sw.e{border-radius:50%;border:2px solid var(--e-normal);background:var(--surface)}.sw.e-elite{border-color:var(--e-elite)}.sw.e-boss{border-color:var(--e-boss)}
.sw.fly{border-style:dashed}.sw.glow{border:2px solid var(--skill);box-shadow:0 0 4px var(--skill)}.sw.ghost{border:1px dashed var(--ink2);opacity:.6}
.sw.rng{background:var(--range);opacity:.35}.sw.rng2{border:1.5px dashed var(--skill);background:none}
aside{min-width:0}aside label{display:block;margin-bottom:8px;font-size:13px}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0 10px}
.info div{margin:2px 0;font-size:13px;color:var(--ink2)}.info .dyn{color:var(--ink);font-variant-numeric:tabular-nums}
#tl{width:100%;overflow:hidden}#tl svg{display:block;touch-action:none;user-select:none}
.tl-lbl{font-size:11px;fill:var(--ink2);dominant-baseline:central}.tl-sub{font-size:10px;fill:var(--muted);dominant-baseline:central}
.tl-op{cursor:pointer}.tl-tick{font-size:10px;fill:var(--muted);text-anchor:middle}
.tl-grid{stroke:var(--grid);stroke-width:1}.tl-base{stroke:var(--axis);stroke-width:1}.tl-wave{stroke:var(--axis);stroke-dasharray:3 3}
.tl-lane{stroke:var(--axis);stroke-width:2}.tl-skill{fill:var(--skill)}.tl-dep{fill:var(--ink)}.tl-loss{stroke:var(--crit);stroke-width:2;fill:none}
.tl-dp{fill:none;stroke:var(--dp);stroke-width:2}.tl-dpa{fill:var(--dp);fill-opacity:.15}
.tl-alive{fill:none;stroke:var(--s1);stroke-width:2}.tl-alivea{fill:var(--s1);fill-opacity:.12}
.tl-leak{fill:none;stroke:var(--crit);stroke-width:2}.tl-leaka{fill:var(--crit);fill-opacity:.1}
.tl-kt{stroke:var(--ink2);stroke-width:1}.tl-lt{stroke:var(--crit);stroke-width:1.5}
.tl-ph{stroke:var(--ink);stroke-width:1.5;pointer-events:none}.tl-rowsel{fill:var(--range);fill-opacity:.09}
.tbl{max-height:340px;overflow:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:3px 6px;border-bottom:1px solid var(--grid);vertical-align:top}th{color:var(--muted);font-weight:500;position:sticky;top:0;background:var(--surface)}
td.t{font-variant-numeric:tabular-nums;white-space:nowrap}tbody tr{cursor:pointer}tbody tr:hover{background:var(--grid)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:var(--ink2)}.dot.skill{background:var(--skill)}.dot.down{background:var(--crit)}
.bar{display:grid;grid-template-columns:5em minmax(0,1fr) auto;gap:8px;align-items:center;margin:5px 0;font-size:13px}
.bt{height:10px}.bf{display:block;height:100%;min-width:2px;background:var(--s1);border-radius:0 4px 4px 0}
.bv{font-variant-numeric:tabular-nums;color:var(--ink2);white-space:nowrap;font-size:12px}
details summary{cursor:pointer;font-weight:600}details ul{margin:8px 0 0;padding-left:20px;font-size:13px;color:var(--ink2)}details li{margin:2px 0;overflow-wrap:anywhere}
`;

const BODY = `<main>
<header><h1><span id="title"></span> <small id="sid"></small></h1><div class="sub" id="sub"></div><div class="kpis" id="kpis"></div></header>
<section class="card">
<div class="player"><button id="play" type="button">&#9654; Play</button><input id="scrub" type="range" min="0" max="1" step="0.5" value="0" aria-label="playhead time"><span class="tnow" id="tnow"></span><span class="speeds" id="speeds"></span></div>
<div class="status" id="status"></div>
<div class="stage"><div><svg id="map" role="img" aria-label="stage map at the playhead"></svg><div class="legend" id="legend"></div></div>
<aside><label id="heatbox" hidden><input type="checkbox" id="heatchk"> <span id="heatlbl"></span></label><div class="chips" id="chips"></div><div class="info" id="info"></div></aside></div>
</section>
<section class="card"><h2>Timeline</h2><div class="hint">Click or drag to scrub &middot; &larr; &rarr; step (Shift: 5 s) &middot; Space play/pause</div><div id="tl"></div><div class="legend" id="tllegend"></div></section>
<div class="cols"><section class="card"><h2>Deploy and skill times</h2><div class="tbl"><table><thead><tr><th>t (s)</th><th>Operator</th><th>Action</th><th>Detail</th></tr></thead><tbody id="rows"></tbody></table></div></section>
<section class="card"><h2>Damage by operator</h2><div id="dmg"></div></section></div>
<details class="card" id="notesbox"><summary id="notessum"></summary><ul id="notes"></ul></details>
<p class="foot" id="foot"></p>
</main>`;

// Runs in the browser (serialised with Function.prototype.toString): no access to this module's scope.
function client() {
  'use strict';
  const D = JSON.parse(document.getElementById('bf-data').textContent);
  const R = D.result, S = D.stage, M = D.meta || {}, OPS = D.ops || [], EN = D.enemies || {};
  const TR = R.trace || { sampleDt: 0.5, frames: [], events: [] }, FR = TR.frames || [], EV = TR.events || [];
  const DT = TR.sampleDt || 0.5, DUR = Math.max(R.duration || 0, FR.length ? FR[FR.length - 1].t : 0, 1), TS = 40, ER = 9;
  const NS = 'http://www.w3.org/2000/svg', $ = id => document.getElementById(id);
  const el = (tag, attrs, parent, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e; };
  const h = (tag, cls, parent, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e; };
  const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const big = x => (x = Math.round(x || 0)) >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e4 ? (x / 1e3).toFixed(1) + 'k' : String(x);
  const upTo = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= t + 1e-9) lo = m + 1; else hi = m; } return lo; };
  for (const f of FR) { f.em = new Map(f.enemies.map(e => [e[0], e])); f.om = new Map(f.ops.map(o => [o[0], o])); }
  const killT = EV.filter(e => e.type === 'kill').map(e => e.t), leakT = EV.filter(e => e.type === 'leak').map(e => e.t);
  const perOp = new Map((R.perOp || []).map(p => [p.name, p]));
  for (const o of OPS) o.uses = (R.skillUses || []).filter(u => u.name === o.name);
  let T = 0, playing = false, speed = 1, hover = null, sel = null, rangeKey = null, infoKey = null, ph = null, tlX = t => t, tlW = 0;

  // ---- header ----
  $('title').textContent = M.title || S.name || S.id || 'stage';
  $('sid').textContent = S.id && S.id !== S.name ? S.id : '';
  const sub = [];
  if (M.secrecy != null) sub.push('保密等级 N' + M.secrecy);
  if (M.floor != null) sub.push('floor ' + M.floor);
  sub.push(M.elite ? 'elite mode (紧急)' : 'normal mode');
  if (M.seed != null) sub.push('seed ' + M.seed);
  if (M.tps != null) sub.push(M.tps + ' tiles/s at speed 1');
  $('sub').textContent = sub.join(' · ');
  const verdict = R.win ? ['✓ Win', 'good'] : R.lifeLeft <= 0 ? ['✗ Defeat', 'bad'] : R.timedOut ? ['✗ Timed out', 'bad'] : ['✗ Not cleared', 'bad'];
  const kpis = [['Result', verdict[0], verdict[1]], ['Lives lost', R.lifeLost + ' / ' + (R.lifePoints != null ? R.lifePoints : '?')], ['Kills', R.kills + ' / ' + R.totalEnemies],
    ['Leaks', R.leaks], ['HP removed', (R.hpTotal ? 100 * R.hpRemoved / R.hpTotal : 0).toFixed(1) + '%'], ['Duration', f1(R.duration || 0) + ' s'], ['Operators lost', (R.losses || []).filter(l => l.cause === 'died').length]];
  for (const [k, v, cls] of kpis) { const d = h('div', 'kpi', $('kpis')); h('span', 'k', d, k); h('span', 'v' + (cls ? ' ' + cls : ''), d, String(v)); }

  // ---- map ----
  const map = $('map');
  map.setAttribute('viewBox', '0 0 ' + S.W * TS + ' ' + S.H * TS);
  const fl = el('filter', { id: 'glow', x: '-40%', y: '-40%', width: '180%', height: '180%' }, el('defs', {}, map));
  el('feGaussianBlur', { stdDeviation: 2.5, result: 'b' }, fl);
  const mg = el('feMerge', {}, fl); el('feMergeNode', { in: 'b' }, mg); el('feMergeNode', { in: 'SourceGraphic' }, mg);
  const gT = el('g', {}, map), gH = el('g', {}, map), gR = el('g', {}, map), gO = el('g', {}, map), gE = el('g', {}, map);
  const CATS = ['blocked', 'ground', 'high', 'walk', 'hole', 'spawn', 'exit', 'tel'], GLYPH = { 5: 'S', 6: 'E', 7: 'T' }, present = new Set();
  for (let r = 0; r < S.H; r++) for (let c = 0; c < S.W; c++) {
    const k = S.cat[r][c], x = c * TS, y = r * TS;
    present.add(k);
    const t = el('rect', { x: x, y: y, width: TS, height: TS, class: 'tile t-' + CATS[k] }, gT);
    el('title', {}, t, 'r' + r + ' c' + c + ' · ' + S.keys[r][c]);
    if (GLYPH[k]) el('text', { x: x + TS / 2, y: y + TS / 2, class: 'glyph' }, gT, GLYPH[k]);
  }
  if (D.heat) {
    let mx = 0;
    for (const row of D.heat) for (const v of row) mx = Math.max(mx, v);
    if (mx > 0) for (let r = 0; r < S.H; r++) for (let c = 0; c < S.W; c++) {
      const v = D.heat[r][c];
      if (v > 0) el('rect', { x: c * TS, y: r * TS, width: TS, height: TS, class: 'heat', 'fill-opacity': (0.08 + 0.72 * v / mx).toFixed(3) }, gH);
    }
    $('heatbox').hidden = false;
    $('heatlbl').textContent = 'Heat: ' + (M.heatLabel || 'HP-seconds per tile') + ' (max ' + big(mx) + ')';
    gH.style.display = 'none';
    $('heatchk').addEventListener('change', () => { gH.style.display = $('heatchk').checked ? '' : 'none'; });
  }
  const ARROW = { E: 'M38,20L32,15.5L32,24.5Z', S: 'M20,38L15.5,32L24.5,32Z', W: 'M2,20L8,15.5L8,24.5Z', N: 'M20,2L15.5,8L24.5,8Z' };
  for (const o of OPS) {
    o.g = el('g', { class: 'op planned', transform: 'translate(' + o.c * TS + ',' + o.r * TS + ')' }, gO);
    el('title', {}, o.g, o.name + (o.skill && o.skill.name ? ' · ' + o.skill.name : ''));
    el('rect', { x: 3, y: 3, width: TS - 6, height: TS - 6, rx: 5, class: 'opbox' }, o.g);
    el('path', { d: ARROW[o.dir] || ARROW.E, class: 'arrow' }, o.g);
    o.tx = el('text', { x: TS / 2, y: 15, class: 'opname' }, o.g, o.name);
    const bars = el('g', { class: 'bars' }, o.g);
    el('rect', { x: 7, y: 25, width: TS - 14, height: 3.5, class: 'barbg' }, bars);
    o.hpb = el('rect', { x: 7, y: 25, width: TS - 14, height: 3.5, class: 'hp' }, bars);
    el('rect', { x: 7, y: 30.5, width: TS - 14, height: 3.5, class: 'barbg' }, bars);
    o.spb = el('rect', { x: 7, y: 30.5, width: 0, height: 3.5, class: 'sp' }, bars);
    el('path', { d: 'M9,9L31,31M31,9L9,31', class: 'gonex' }, o.g);
    o.g.addEventListener('pointerenter', () => { hover = o; refreshSel(); });
    o.g.addEventListener('pointerleave', () => { if (hover === o) { hover = null; refreshSel(); } });
    o.g.addEventListener('click', () => select(o));
    const chip = h('button', '', $('chips'), o.name); chip.type = 'button'; o.chip = chip;
    chip.addEventListener('click', () => select(o));
  }
  const pool = new Map();
  const enemyEl = id => {
    let p = pool.get(id);
    if (p) return p;
    const info = EN[id] || ['enemy', 'NORMAL', 'WALK', 0];
    const g = el('g', { class: 'en en-' + String(info[1]).toLowerCase() + (info[2] === 'FLY' ? ' fly' : '') }, gE);
    el('circle', { r: ER, class: 'ring' }, g);
    p = { g, core: el('circle', { r: ER, class: 'core' }, g) };
    el('title', {}, g, '#' + id + ' ' + info[0] + ' · ' + info[1] + (info[2] === 'FLY' ? ' · FLY' : '') + (info[3] ? ' · max HP ' + info[3] : ''));
    pool.set(id, p);
    return p;
  };
  // legend
  const LG = $('legend'), item = (cls, text, parent) => { const s = h('span', '', parent || LG); h('span', 'sw ' + cls, s); s.appendChild(document.createTextNode(text)); };
  const TNAME = { 0: 'blocked', 1: 'ground (melee)', 2: 'high ground (ranged)', 3: 'walkable, not deployable', 4: 'hole', 5: 'spawn S', 6: 'exit E', 7: 'teleport T' };
  for (let k = 0; k < 8; k++) if (present.has(k)) item('t-' + CATS[k], TNAME[k]);
  item('e', 'normal'); item('e e-elite', 'elite'); item('e e-boss', 'boss'); item('e fly', 'flying (dashed)');
  h('span', '', LG, '● fill = HP left · ▸ facing');
  item('glow', 'skill active'); item('ghost', 'not yet deployed'); item('rng', 'range now'); item('rng2', 'other range (base / skill)');
  const TL = $('tllegend');
  item('glow', 'skill active (bar; ◆ = instant)', TL); h('span', '', TL, '▼ deploy · ✗ down · dashed line = wave start · DP, enemies on field and cumulative leaks each on their own scale · bottom row: kill ticks (up), leak ticks (down, red)');

  // ---- per-frame rendering ----
  const frameAt = t => { let lo = 0, hi = FR.length - 1; if (hi < 0) return -1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (FR[m].t <= t + 1e-9) lo = m; else hi = m - 1; } return lo; };
  function renderAt(t) {
    const k = frameAt(t), a0 = k >= 0 ? FR[k] : null, a1 = k >= 0 ? FR[k + 1] : null;
    const a = a0 && a1 && a1.t > a0.t ? Math.min(1, Math.max(0, (t - a0.t) / (a1.t - a0.t))) : 0;
    const seen = new Set();
    if (a0) for (const e of a0.enemies) {
      const n = a1 && a1.em.get(e[0]);
      let r = e[1], c = e[2], hp = e[3];
      if (n && Math.abs(n[1] - r) + Math.abs(n[2] - c) <= (M.snap || 2)) { r += (n[1] - r) * a; c += (n[2] - c) * a; hp += (n[3] - hp) * a; }
      const p = enemyEl(e[0]);
      seen.add(e[0]);
      p.g.setAttribute('transform', 'translate(' + ((c + 0.5) * TS).toFixed(1) + ',' + ((r + 0.5) * TS).toFixed(1) + ')');
      p.core.setAttribute('r', (ER * Math.sqrt(Math.max(0, Math.min(1, hp)))).toFixed(2));
      p.g.style.display = '';
    }
    for (const [id, p] of pool) if (!seen.has(id)) p.g.style.display = 'none';
    const busy = new Set();
    for (const o of OPS) {
      const s = a0 && a0.om.get(o.name), n = a1 && a1.om.get(o.name);
      o.hp = 1; o.sp = 0; o.activeNow = false;
      if (s) { o.state = 'on'; o.hp = s[1]; o.sp = s[3]; o.activeNow = !!s[2]; if (n) { o.hp += (n[1] - o.hp) * a; o.sp = n[3] >= o.sp ? o.sp + (n[3] - o.sp) * a : o.sp; } }
      else if (o.loss && o.loss.t <= t + 1e-9) o.state = 'gone';
      else if (o.dep && o.dep.t <= t + 1e-9) o.state = 'on';         // deployed after the last frame: fresh
      else o.state = 'planned';
      if (o.state === 'on') busy.add(o.r * S.W + o.c);
    }
    for (const o of OPS) {
      const hidden = o.state !== 'on' && busy.has(o.r * S.W + o.c);   // a ghost under an operator on the same tile
      o.g.setAttribute('class', 'op ' + o.state + (o.activeNow ? ' active' : '') + (sel === o ? ' sel' : '') + (hidden ? ' hide' : ''));
      o.hpb.setAttribute('width', ((TS - 14) * Math.max(0, Math.min(1, o.hp))).toFixed(2));
      o.spb.setAttribute('width', ((TS - 14) * Math.max(0, Math.min(1, o.sp))).toFixed(2));
    }
    refreshSel();
    const onF = OPS.filter(o => o.state === 'on').length, nE = a0 ? a0.enemies.length : 0;
    $('status').textContent = 't ' + f1(t) + ' s · DP ' + (a0 ? Math.floor(a0.dp) : '–') + ' · on field: ' + nE + ' enemies, ' + onF + ' operators · kills ' + upTo(killT, t) + ' / ' + R.totalEnemies + ' · leaks ' + upTo(leakT, t);
  }

  // ---- selection: range highlight and info panel ----
  function refreshSel() {
    const o = hover || sel, rk = o ? o.name + '|' + o.activeNow : '';
    if (rk !== rangeKey) {
      rangeKey = rk;
      gR.textContent = '';
      if (o) {
        const cur = o.activeNow && o.active ? o.active : o.base, other = cur === o.base ? o.active : o.base;
        if (other) for (const [r, c] of other) el('rect', { x: c * TS + 4, y: r * TS + 4, width: TS - 8, height: TS - 8, rx: 4, class: 'rng2' }, gR);
        for (const [r, c] of cur) el('rect', { x: c * TS + 1, y: r * TS + 1, width: TS - 2, height: TS - 2, rx: 3, class: 'rng' }, gR);
      }
    }
    const info = $('info');
    if ((o ? o.name : '') !== infoKey) {
      infoKey = o ? o.name : '';
      info.textContent = '';
      if (!o) { h('div', '', info, 'Hover or tap an operator (map or chips) to see its range; click to pin it.'); }
      else {
        h('h3', '', info, o.name);
        const p = perOp.get(o.name), sk = o.skill;
        h('div', '', info, [o.profession, o.position].filter(Boolean).join(' · ') + ' · tile r' + o.r + ' c' + o.c + ' facing ' + o.dir);
        h('div', '', info, o.dep ? 'deployed at ' + f1(o.dep.t) + ' s for ' + o.dep.cost + ' DP' + (o.loss ? ' · ' + (o.loss.cause === 'retreat' ? 'retreated' : 'down') + ' at ' + f1(o.loss.t) + ' s' : '') : 'not deployed in this run (planned not before ' + f1(o.planT) + ' s)');
        if (sk && sk.name) h('div', '', info, 'Skill: S' + ((sk.index != null ? sk.index : -1) + 1) + ' ' + sk.name + ' Lv' + sk.level + ' · ' + sk.trigger + ' · ' + sk.spType + ' SP ' + sk.spCost + ' (initial ' + sk.initSp + ') · ' + (sk.duration > 0 ? sk.duration + ' s' : sk.duration < 0 ? 'until retreat' : 'instant') + ' · fidelity ' + sk.fidelity);
        else if (sk && sk.error) h('div', '', info, 'Skill: not compiled (' + sk.error + ')');
        h('div', '', info, 'Uses: ' + (o.uses.length ? o.uses.map(u => f1(u.t) + (u.end > u.t ? '–' + f1(u.end) : '')).join(', ') : 'none'));
        h('div', '', info, 'Range: base ' + o.base.length + ' tiles' + (o.active ? ', skill ' + o.active.length + ' tiles' : ' (the skill does not change it)'));
        if (p) h('div', '', info, 'Damage ' + big(p.damage) + (R.hpRemoved ? ' (' + (100 * p.damage / R.hpRemoved).toFixed(1) + '% of all)' : '') + ' · kills ' + p.kills + (p.healing ? ' · healing ' + big(p.healing) : '') + ' · damage taken ' + big(p.damageTaken) + ' · skill uptime ' + f1(p.skillUptime || 0) + ' s');
        o.dyn = h('div', 'dyn', info, '');
      }
    }
    if (o && o.dyn) o.dyn.textContent = 'At ' + f1(T) + ' s: ' + (o.state === 'on' ? 'HP ' + Math.round(100 * o.hp) + '% · SP ' + Math.round(100 * o.sp) + '% · ' + (o.activeNow ? 'skill ACTIVE (showing the skill range)' : 'skill not active') : o.state === 'gone' ? 'off the field' : 'not deployed yet');
    for (const x of OPS) x.chip.className = x === sel ? 'on' : '';
  }
  function select(o) { sel = sel === o ? null : o; rangeKey = null; refreshSel(); renderAt(T); drawTimeline(); }

  // ---- timeline ----
  const tl = $('tl');
  const niceStep = (span, n) => { for (const s of [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600]) if (span / s <= n) return s; return 1200; };
  function drawTimeline() {
    const W = Math.max(260, Math.floor(tl.clientWidth || 800)), narrow = W < 560, LW = narrow ? 58 : 100, PW = W - LW - 10;
    const AX = 30, RH = 22, CH = 40, Ht = AX + OPS.length * RH + 3 * CH + RH + 8;
    const X = t => LW + PW * Math.max(0, Math.min(DUR, t)) / DUR;
    tlW = W; tlX = X;
    tl.textContent = '';
    const svg = el('svg', { width: W, height: Ht, viewBox: '0 0 ' + W + ' ' + Ht, role: 'img', 'aria-label': 'timeline' }, tl);
    const step = niceStep(DUR, Math.max(2, PW / 64));
    for (let t = 0; t <= DUR + 1e-9; t += step) { el('line', { x1: X(t), x2: X(t), y1: AX - 6, y2: Ht - 4, class: 'tl-grid' }, svg); el('text', { x: X(t), y: 11, class: 'tl-tick' }, svg, t + 's'); }
    let lastWx = -1e9;
    for (const e of EV) if (e.type === 'wave' && e.t > 0) {
      el('line', { x1: X(e.t), x2: X(e.t), y1: AX - 6, y2: Ht - 4, class: 'tl-wave' }, svg);
      if (X(e.t) - lastWx > 26) { el('text', { x: X(e.t), y: 24, class: 'tl-tick' }, svg, 'W' + (e.id + 1)); lastWx = X(e.t); }
    }
    let y = AX;
    for (const o of OPS) {
      const cy = y + RH / 2;
      if (o === sel) el('rect', { x: 0, y: y, width: W, height: RH, class: 'tl-rowsel' }, svg);
      const lb = el('text', { x: 4, y: cy, class: 'tl-lbl tl-op' }, svg, narrow ? o.name.slice(0, 4) : o.name);
      lb.addEventListener('click', () => select(o));
      if (o.dep) {
        el('line', { x1: X(o.dep.t), x2: X(o.loss ? o.loss.t : DUR), y1: cy, y2: cy, class: 'tl-lane' }, svg);
        for (const u of o.uses) {
          const x0 = X(u.t), x1 = X(u.end), lab = o.name + ' ' + u.skill + ' ' + f1(u.t) + (u.end > u.t ? '–' + f1(u.end) + ' s' : ' s (instant)');
          const m = u.end > u.t ? el('rect', { x: x0, y: cy - 5, width: Math.max(2, x1 - x0), height: 10, rx: 2, class: 'tl-skill' }, svg)
            : el('path', { d: 'M' + x0 + ',' + (cy - 5) + 'l4,5l-4,5l-4,-5z', class: 'tl-skill' }, svg);
          el('title', {}, m, lab);
        }
        el('title', {}, el('path', { d: 'M' + (X(o.dep.t) - 5) + ',' + (cy - 9) + 'h10l-5,7z', class: 'tl-dep' }, svg), o.name + ' deployed at ' + f1(o.dep.t) + ' s');
        if (o.loss) { const lx = X(o.loss.t); el('title', {}, el('path', { d: 'M' + (lx - 4) + ',' + (cy - 4) + 'l8,8m0,-8l-8,8', class: 'tl-loss' }, svg), o.name + ' ' + o.loss.cause + ' at ' + f1(o.loss.t) + ' s'); }
      } else el('text', { x: LW + 4, y: cy, class: 'tl-sub' }, svg, 'not deployed');
      y += RH;
    }
    const chart = (label, pts, cls, stepped) => {
      const top = y + 5, bot = y + CH - 4, mx = Math.max(1, ...pts.map(p => p[1])), Y = v => bot - (bot - top) * v / mx;
      el('line', { x1: LW, x2: LW + PW, y1: bot, y2: bot, class: 'tl-base' }, svg);
      el('text', { x: 4, y: y + CH / 2 - 6, class: 'tl-lbl' }, svg, label);
      el('text', { x: 4, y: y + CH / 2 + 8, class: 'tl-sub' }, svg, 'max ' + big(mx));
      if (pts.length) {
        let d = '';
        pts.forEach(([t, v], i) => { const x = X(t).toFixed(1); if (stepped && i) d += 'L' + x + ',' + Y(pts[i - 1][1]).toFixed(1); d += (i ? 'L' : 'M') + x + ',' + Y(v).toFixed(1); });
        el('path', { d: d + 'L' + X(pts[pts.length - 1][0]).toFixed(1) + ',' + bot + 'L' + X(pts[0][0]).toFixed(1) + ',' + bot + 'Z', class: cls + 'a' }, svg);
        el('path', { d: d, class: cls }, svg);
      }
      y += CH;
    };
    chart('DP', FR.map(f => [f.t, f.dp]), 'tl-dp');
    chart(narrow ? 'Enemies' : 'Enemies on field', FR.map(f => [f.t, f.enemies.length]), 'tl-alive');
    chart(narrow ? 'Leaks' : 'Leaks (total)', [[0, 0]].concat(leakT.map((t, i) => [t, i + 1]), [[DUR, leakT.length]]), 'tl-leak', true);
    el('text', { x: 4, y: y + RH / 2, class: 'tl-lbl' }, svg, narrow ? 'Kill/leak' : 'Kills / leaks');
    for (const e of EV) {
      if (e.type === 'kill') el('title', {}, el('line', { x1: X(e.t), x2: X(e.t), y1: y + 2, y2: y + RH / 2, class: 'tl-kt' }, svg), 'kill #' + e.id + ' ' + ((EN[e.id] || [])[0] || '') + (e.name ? ' by ' + e.name : '') + ' at ' + f1(e.t) + ' s');
      else if (e.type === 'leak') el('title', {}, el('line', { x1: X(e.t), x2: X(e.t), y1: y + RH / 2, y2: y + RH - 2, class: 'tl-lt' }, svg), 'leak #' + e.id + ' ' + ((EN[e.id] || [])[0] || '') + ' at ' + f1(e.t) + ' s');
    }
    ph = el('line', { x1: X(T), x2: X(T), y1: 0, y2: Ht, class: 'tl-ph' }, svg);
    let drag = false;
    const toT = ev => (ev.clientX - svg.getBoundingClientRect().left - LW) / PW * DUR;
    svg.addEventListener('pointerdown', ev => { if (ev.clientX - svg.getBoundingClientRect().left < LW) return; drag = true; if (svg.setPointerCapture) svg.setPointerCapture(ev.pointerId); setT(toT(ev)); });
    svg.addEventListener('pointermove', ev => { if (drag) setT(toT(ev)); });
    svg.addEventListener('pointerup', () => { drag = false; });
    svg.addEventListener('pointercancel', () => { drag = false; });
  }

  // ---- playback ----
  const scrub = $('scrub');
  scrub.max = String(DUR); scrub.step = String(DT);
  scrub.addEventListener('input', () => setT(Number(scrub.value)));
  function setT(t) {
    T = Math.max(0, Math.min(DUR, Number(t) || 0));
    scrub.value = String(T);
    $('tnow').textContent = f1(T) + ' / ' + f1(DUR) + ' s';
    if (ph) { ph.setAttribute('x1', tlX(T)); ph.setAttribute('x2', tlX(T)); }
    renderAt(T);
  }
  let last = 0;
  const tick = now => { if (!playing) return; const d = Math.min(0.25, Math.max(0, (now - last) / 1000)); last = now; setT(T + d * speed); if (T >= DUR) pause(); else requestAnimationFrame(tick); };
  function play() { if (T >= DUR) T = 0; playing = true; last = performance.now(); $('play').textContent = '❚❚ Pause'; requestAnimationFrame(tick); }
  function pause() { playing = false; $('play').textContent = '▶ Play'; }
  const toggle = () => (playing ? pause() : play());
  $('play').addEventListener('click', toggle);
  const SPEEDS = [1, 2, 4, 8], sbtn = [];
  for (const s of SPEEDS) {
    const b = h('button', s === speed ? 'on' : '', $('speeds'), 'x' + s);
    b.type = 'button';
    b.addEventListener('click', () => { speed = s; sbtn.forEach((x, i) => { x.className = SPEEDS[i] === s ? 'on' : ''; }); });
    sbtn.push(b);
  }
  document.addEventListener('keydown', e => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { setT(T + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : DT)); e.preventDefault(); }
    else if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'SUMMARY') { toggle(); e.preventDefault(); }
    else if (e.key === 'Home') { setT(0); e.preventDefault(); }
    else if (e.key === 'End') { setT(DUR); e.preventDefault(); }
  });

  // ---- text timeline, damage bars, notes ----
  const rows = [];
  for (const d of R.deploys || []) rows.push([d.t, d.name, 'deploy', 'tile r' + d.r + ' c' + d.c + ' facing ' + d.dir + ' · cost ' + d.cost]);
  for (const u of R.skillUses || []) rows.push([u.t, u.name, 'skill', u.skill + (u.end > u.t ? ' · until ' + f1(u.end) + ' s (' + f1(u.end - u.t) + ' s)' : ' · instant')]);
  for (const l of R.losses || []) rows.push([l.t, l.name, 'down', l.cause]);
  rows.sort((a, b) => a[0] - b[0]);
  for (const [t, name, kind, detail] of rows) {
    const tr = h('tr', '', $('rows'));
    h('td', 't', tr, f1(t));
    h('td', '', tr, name);
    const td = h('td', '', tr); h('span', 'dot ' + kind, td); td.appendChild(document.createTextNode(kind === 'down' ? (detail === 'retreat' ? 'retreat' : 'down') : kind));
    h('td', '', tr, kind === 'down' ? '' : detail);
    tr.addEventListener('click', () => { setT(t); const o = OPS.find(x => x.name === name); if (o && sel !== o) select(o); });
  }
  if (!rows.length) h('td', '', h('tr', '', $('rows')), 'no deploys');
  const per = (R.perOp || []).slice().sort((a, b) => b.damage - a.damage), mxd = Math.max(1, ...per.map(p => p.damage));
  for (const p of per) {
    const row = h('div', 'bar', $('dmg'));
    h('span', '', row, p.name);
    h('span', 'bf', h('span', 'bt', row)).style.width = (100 * p.damage / mxd).toFixed(1) + '%';
    h('span', 'bv', row, big(p.damage) + (R.hpRemoved ? ' · ' + (100 * p.damage / R.hpRemoved).toFixed(0) + '%' : '') + ' · ' + p.kills + ' kills' + (p.healing ? ' · heal ' + big(p.healing) : '') + (p.died ? ' · down' : ''));
  }
  if (!per.length) h('div', '', $('dmg'), 'no operators');
  const notes = M.notes || [];
  $('notessum').textContent = 'Notes, assumptions and skill fidelity (' + notes.length + ')';
  for (const n of notes) h('li', '', $('notes'), n);
  $('notesbox').hidden = !notes.length;
  $('foot').textContent = 'Replay of sim.simulate (trace every ' + DT + ' s, ' + FR.length + ' frames, ' + EV.length + ' events). Enemy positions are interpolated between frames; jumps over ' + (M.snap || 2) + ' tiles (teleports) snap.' + (R.trace ? '' : ' This result has no trace: run sim.simulate with opts.trace = true for the replay.');

  // ---- start ----
  drawTimeline();
  const fitNames = () => {   // short names when a tile is small on screen
    const px = (map.getBoundingClientRect().width || 800) / S.W, short = px < 46;
    for (const o of OPS) { const s = short ? o.name.slice(0, 2) : o.name; o.tx.textContent = s; o.tx.setAttribute('font-size', (short ? 14 : Math.min(11.5, 35 / Math.max(1, s.length))).toFixed(1)); }
  };
  fitNames();
  const onResize = () => { if (Math.floor(tl.clientWidth || 800) !== tlW) drawTimeline(); fitNames(); };
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver === 'function') new ResizeObserver(onResize).observe(tl);   // panes and splits resize without a window resize
  setT(0);
  window.__bfViewer = { setT, play, pause, select: name => select(OPS.find(o => o.name === name) || null), get t() { return T; }, ops: OPS, drawTimeline };
}

function renderHtml(args) {
  const data = buildData(args || {}), s = data.stage;
  const title = (data.meta.title || s.name || s.id || 'stage') + ' · combat replay';
  return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + '</title><style>' + CSS + '</style></head><body>\n' + BODY + '\n'
    + '<script type="application/json" id="bf-data">' + safeJson(data) + '</script>\n'
    + '<script>(' + client.toString() + ')();</script>\n</body></html>\n';
}

// ---------- CLI ----------
// Hand-written legal plans (r from the top, c from the left; verified legal with the example roster's rules).
const HAND_PLANS = {
  // 彼处水如酒 (ro6_n_5_5): the test_integration.js plan. 桃金娘 first for DP at the head of the 历险水手 lane, the two
  // casters on the high ground between the loop and that lane, 星熊 holds the lane, 银灰 on high ground above the loop
  // (MELEE on high ground: 漆黑的舞鞋 rule), 塞雷娅 holds row 1. 6 = characterLimit 6 - 1 (N10) + 1 (地形图).
  彼处水如酒: by => ({ deploys: [
    { op: by['桃金娘'], r: 6, c: 9, dir: 'E' }, { op: by['艾雅法拉'], r: 5, c: 6, dir: 'E' }, { op: by['星熊'], r: 6, c: 5, dir: 'E' },
    { op: by['逻各斯'], r: 5, c: 7, dir: 'N' }, { op: by['银灰'], r: 2, c: 7, dir: 'S' }, { op: by['塞雷娅'], r: 1, c: 6, dir: 'E' },
  ], skills: { 银灰: { minEnemiesInRange: 2 } } }),
};
const FALLBACK_SQUAD = ['德克萨斯', '能天使', '星熊', '艾雅法拉', '银灰', '夜莺'];

// Other stages: each operator in turn takes the free legal tile and facing whose range covers the most HP-seconds
// it can hit (FLY counted only for canHitAir). Not an optimiser: just a legal plan to look at.
function autoPlan(sim, O, st, ops, opts, enemies) {
  const H = st.H, W = st.W, wG = new Float64Array(H * W), wA = new Float64Array(H * W);
  for (const e of enemies) for (let k = 1; k < e.path.length; k++) {
    const a = e.path[k - 1], b = e.path[k];
    if (a.hidden || a.r < 0 || a.c < 0 || a.r >= H || a.c >= W) continue;
    (e.motion === 'FLY' ? wA : wG)[a.r * W + a.c] += (b.t - a.t) * e.hp;
  }
  const occ = new Set(), deploys = [];
  for (const op of ops.slice(0, sim.deployLimit(st, opts))) {
    let best = null;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      if (!sim.canDeploy(st, op, r, c, occ, opts)) continue;
      for (const dir of ['E', 'S', 'W', 'N']) {
        let s = 0;
        for (const o of O.rotate(op.range, dir)) { const rr = r + o.dr, cc = c + o.dc; if (rr >= 0 && cc >= 0 && rr < H && cc < W) s += wG[rr * W + cc] + (op.canHitAir ? wA[rr * W + cc] : 0); }
        if (!best || s > best.s) best = { r, c, dir, s };
      }
    }
    if (!best) continue;
    occ.add(best.r * W + best.c);
    deploys.push({ op, r: best.r, c: best.c, dir: best.dir });
  }
  return { deploys };
}

function main(argv) {
  const O = require('./operators.js'), K = require('./skills.js'), sim = require('./sim.js'), sm = require('./stage_model.js');
  const VALUED = ['out', 'secrecy', 'floor', 'seed'];
  const flag = (name, dflt) => { const k = argv.indexOf('--' + name); return k < 0 ? dflt : argv[k + 1]; };
  const which = argv.find((a, k) => !a.startsWith('--') && !(k > 0 && VALUED.includes(argv[k - 1].slice(2)))) || '彼处水如酒';
  const R = O.loadRoster(path.join(__dirname, 'roster.example.json')), by = Object.fromEntries(R.operators.map(o => [o.name, o]));
  const st = sm.loadStage(which);
  const opts = { secrecy: Number(flag('secrecy', R.secrecy)), floor: Number(flag('floor', R.floor)), elite: argv.includes('--elite'), seed: Number(flag('seed', 1)), rules: R.rules };
  const enemies = sim.sampleEnemies(st, opts);
  const hand = HAND_PLANS[st.name];
  const plan = hand ? hand(by) : autoPlan(sim, O, st, FALLBACK_SQUAD.map(n => by[n]), opts, enemies);
  const t0 = Date.now(), result = sim.simulate(st, plan, { ...opts, enemies, trace: true }), ms = Date.now() - t0;
  const notes = [hand ? 'Plan: hand-written for this stage in combat/render.js (a legal example, not optimised).'
    : 'Plan: automatic fallback in combat/render.js (each operator takes the legal tile and facing covering the most HP-seconds; not optimised).',
  'Roster: combat/roster.example.json (example, not the user\'s), collectibles: ' + ((R.raw.collectibles || []).map(c => c.name).join(', ') || 'none') + '.'];
  for (const d of plan.deploys) {
    const s = K.compileSkill(d.op), pol = plan.skills && plan.skills[d.op.name];
    notes.push(d.op.name + ': S' + (d.op.skillIndex + 1) + ' ' + s.name + ' Lv' + s.level + ', ' + s.trigger + '/' + s.spType + ', fidelity ' + s.fidelity + ', skill timing ' + (pol ? JSON.stringify(pol) : 'asap'));
    for (const n of s.notes || []) notes.push(d.op.name + ': ' + n);
  }
  notes.push('ASSUMPTION (sim.js TPS_DEFAULT): enemy move speed 1.0 = ' + sim.TPS_DEFAULT + ' tiles per second, not calibrated in game.');
  notes.push('ASSUMPTION (sim.js LIFE_POINTS_DEFAULT): ' + result.lifePoints + ' life point(s); the fight is not stopped at defeat, so lives lost can exceed it.');
  notes.push('Heat overlay: enemy HP x seconds per tile along the nominal unblocked paths (the time the HP is exposed, before any damage).');
  for (const s of enemies.meta.skipped || []) notes.push('Left out by sim.sampleEnemies: ' + s.count + ' x ' + s.key + ' (' + s.reason + ').');
  if ((enemies.meta.hiddenGroups || []).length) notes.push('Hidden spawn groups enabled: ' + enemies.meta.hiddenGroups.join(', ') + '.');
  const html = renderHtml({ stage: st, result, plan, meta: { secrecy: opts.secrecy, floor: opts.floor, elite: opts.elite, seed: opts.seed, tps: sim.TPS_DEFAULT,
    enemies, heat: hpSeconds(st, enemies), heatLabel: 'HP-seconds per tile on the nominal paths', notes } });
  const out = path.resolve(flag('out', path.join(__dirname, 'out', st.name + '.html')));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(st.name + ' (' + st.id + '): ' + plan.deploys.map(d => d.op.name + '(' + d.r + ',' + d.c + ')' + d.dir).join(' ') + (hand ? '  [hand-written plan]' : '  [auto plan]'));
  console.log('result: kills ' + result.kills + '/' + result.totalEnemies + ', leaks ' + result.leaks + ', HP removed ' + (100 * result.hpRemoved / result.hpTotal).toFixed(1) + '%, duration ' + result.duration + ' s, ' + result.trace.frames.length + ' frames (simulated in ' + ms + ' ms)');
  console.log('wrote ' + out + ' (' + Buffer.byteLength(html) + ' bytes)');
  return out;
}

module.exports = { renderHtml, buildData, tileCat, hpSeconds, safeJson, rangeTiles, autoPlan, HAND_PLANS, TILE_CATS, INTERP_SNAP_TILES, main };

if (require.main === module) main(process.argv.slice(2));
