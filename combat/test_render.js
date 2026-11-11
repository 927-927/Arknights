// Tests for render.js: the embedded data, no external references, script-injection safety, and the page script run
// against a small fake DOM (zero enemies, an operator that died, skill glow, interpolation, playback, keyboard).
// Run: node combat/test_render.js   (one line per passed check, non-zero exit on the first failure)
'use strict';
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const V = require('./render.js');
const O = require('./operators.js');
const sim = require('./sim.js');
const sm = require('./stage_model.js');

let passed = 0;
const ok = (name, fn) => { const info = fn(); console.log(`ok ${++passed} - ${name}${info ? '  [' + info + ']' : ''}`); };

// ---------- fixtures: 彼处水如酒 with the CLI's hand-written plan, N15 floor 5 ----------
const R = O.loadRoster(path.join(__dirname, 'roster.example.json'));
const by = Object.fromEntries(R.operators.map(o => [o.name, o]));
const ST = sm.loadStage('彼处水如酒');
const OPTS = { secrecy: R.secrecy, floor: R.floor, rules: R.rules };
const ENEMIES = sim.sampleEnemies(ST, OPTS);
const PLAN = V.HAND_PLANS['彼处水如酒'](by);
const RES = sim.simulate(ST, PLAN, { ...OPTS, enemies: ENEMIES, trace: true });
const META = { secrecy: 15, floor: 5, seed: 1, tps: sim.TPS_DEFAULT, enemies: ENEMIES, heat: V.hpSeconds(ST, ENEMIES), notes: ['a note'] };
const HTML = V.renderHtml({ stage: ST, result: RES, plan: PLAN, meta: META });

const dataOf = html => {
  const m = html.match(/<script type="application\/json" id="bf-data">([\s\S]*?)<\/script>/g);
  assert.ok(m && m.length === 1, 'exactly one data blob');
  return JSON.parse(m[0].replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
};
const codeOf = html => { const m = html.match(/<script>([\s\S]*?)<\/script>/g); assert.ok(m && m.length === 1, 'exactly one page script'); return m[0].slice(8, -9); };

// ---------- fake DOM: only the API surface the page script uses; any NaN / undefined written to it throws ----------
function runPage(html, { width = 800 } = {}) {
  const ids = new Map(), rafs = [];
  let now = 0;
  const bad = (v, what) => { if (/NaN|undefined|\[object /.test(String(v))) throw new Error(`${what} = ${v}`); };
  class N {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.style = {}; this.on = {}; this.text = ''; this.className = ''; this.w = width; }
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
    setAttribute(k, v) { bad(v, `${this.tagName}.${k}`); this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
    getAttribute(k) { return k === 'class' ? this.className : this.attrs[k]; }
    addEventListener(t, f) { (this.on[t] = this.on[t] || []).push(f); }
    fire(t, ev = {}) { for (const f of this.on[t] || []) f({ target: this, pointerId: 1, preventDefault() {}, ...ev }); }
    get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { bad(v, `${this.tagName}.textContent`); this.text = String(v); this.children = []; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.w, height: 400 }; }
    get clientWidth() { return this.w; }
    setPointerCapture() {}
    all(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) c.all(pred, out); return out; }
  }
  for (const m of html.matchAll(/<([a-zA-Z0-9]+)\b[^>]*\sid="([^"]+)"/g)) ids.set(m[2], new N(m[1]));
  ids.get('bf-data').text = html.match(/<script type="application\/json" id="bf-data">([\s\S]*?)<\/script>/)[1];
  const document = new N('#document');
  Object.assign(document, { getElementById: id => ids.get(id) || null, createElement: t => new N(t), createTextNode: t => { const n = new N('#text'); n.text = String(t); return n; },
    createElementNS: (ns, t) => { assert.strictEqual(ns, 'http://www.w3.org/2000/svg'); return new N(t); } });
  const window = new N('#window');
  new Function('document', 'window', 'requestAnimationFrame', 'performance', codeOf(html))(document, window, f => rafs.push(f), { now: () => now });
  const pump = (ms, steps) => { for (let k = 0; k < steps && rafs.length; k++) { now += ms; rafs.shift()(now); } };
  const map = ids.get('map'), [, , gT, , gR, gO, gE] = [null, ...map.children];
  return { ids, document, window, v: window.__bfViewer, pump, gT, gR, gO, gE, map };
}
const visible = g => g.children.filter(c => c.style.display === '').length;
const opG = (P, name) => P.v.ops.find(o => o.name === name).g;

// ---------- checks ----------
ok('renderHtml returns one HTML page whose embedded JSON blob parses back to the same result (deep-equal, trace included)', () => {
  assert.ok(HTML.startsWith('<!doctype html>') && HTML.trimEnd().endsWith('</html>'));
  const d = dataOf(HTML);
  assert.deepStrictEqual(d.result, RES);
  assert.deepStrictEqual(d.result, JSON.parse(JSON.stringify(RES)));
  assert.strictEqual(d.stage.H, ST.H); assert.strictEqual(d.stage.W, ST.W);
  assert.strictEqual(d.ops.length, PLAN.deploys.length);
  assert.strictEqual(Object.keys(d.enemies).length, ENEMIES.length);
  return `${HTML.length} chars, ${RES.trace.frames.length} frames, ${RES.trace.events.length} events`;
});

ok('no external resource references: no http(s) in src= / href= / url( / import, no <link>, no <script src>', () => {
  const bad = [/\b(?:src|href|action|poster|data)\s*=\s*["']?\s*(?:https?:)?\/\//i, /url\(\s*["']?\s*(?:https?:)?\/\//i, /@import/i, /\bimport\s*\(?\s*["']/i, /<link\b/i, /<script[^>]*\ssrc=/i, /<iframe\b/i];
  for (const re of bad) assert.ok(!re.test(HTML), `matches ${re}`);
  const urls = HTML.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  assert.deepStrictEqual([...new Set(urls)], ['http://www.w3.org/2000/svg'], 'the only URL is the SVG namespace string');
  return 'only URL: the SVG namespace in createElementNS';
});

ok('tile categories match stage_model\'s CLI symbols cell by cell on 彼处水如酒', () => {
  const sym = t => t.hole ? 'O' : t.key === 'tile_start' ? 'S' : t.key === 'tile_end' ? 'E' : t.key.startsWith('tile_tel') ? 'T' : t.high && t.deployable ? '^' : t.deployable ? '_' : t.walkable ? '.' : '#';
  const want = { O: 'hole', S: 'spawn', E: 'exit', T: 'tel', '^': 'high', _: 'ground', '.': 'walk', '#': 'blocked' }, n = {};
  for (const row of ST.grid) for (const t of row) { const c = V.TILE_CATS[V.tileCat(t)]; assert.strictEqual(c, want[sym(t)], t.key); n[c] = (n[c] || 0) + 1; }
  return Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ');
});

ok('script-injection safety: "</script>" in the stage name, a note, an enemy name and an operator name stays data', () => {
  const evil = 'x</script><script>alert(1)</script><!--';
  const st = { ...ST, name: evil, id: '</SCRIPT >' };
  const res = JSON.parse(JSON.stringify(RES));
  res.deploys[0].name = evil;
  const html = V.renderHtml({ stage: st, result: res, plan: null, meta: { notes: [evil], enemies: ENEMIES.map(e => ({ ...e, name: evil })), title: null } });
  assert.strictEqual((html.match(/<\/script/gi) || []).length, 2, 'only the two closing tags of the page');
  assert.ok(!/<!--/.test(html) && !/<script>alert/i.test(html));
  assert.ok(html.includes('<title>x&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;!-- · combat replay</title>'));
  const d = dataOf(html);
  assert.strictEqual(d.stage.name, evil); assert.strictEqual(d.meta.notes[0], evil); assert.strictEqual(d.result.deploys[0].name, evil);
  const P = runPage(html);
  assert.strictEqual(P.ids.get('title').textContent, evil, 'the page shows the name as text');
  return 'data blob escapes < > & as \\u003c \\u003e \\u0026';
});

ok('page script on the full result: builds the map, runs every 5 s of the fight without NaN/undefined, interpolates enemies', () => {
  const P = runPage(HTML);
  assert.strictEqual(P.gT.children.filter(c => c.tagName === 'RECT').length, ST.H * ST.W);
  for (let t = 0; t <= RES.duration + 5; t += 5) {
    P.v.setT(t);
    const f = RES.trace.frames.filter(x => x.t <= t + 1e-9).pop();
    assert.strictEqual(visible(P.gE), f.enemies.length, `enemies drawn at ${t}`);
  }
  // halfway between two frames, an enemy that walks is drawn halfway (no teleport between them)
  const fr = RES.trace.frames, k = fr.findIndex((f, i) => i + 1 < fr.length && f.enemies.some(e => { const n = fr[i + 1].enemies.find(x => x[0] === e[0]); return n && n[2] !== e[2] && Math.abs(n[2] - e[2]) < 1; }));
  const e0 = fr[k].enemies.find(e => { const n = fr[k + 1].enemies.find(x => x[0] === e[0]); return n && n[2] !== e[2] && Math.abs(n[2] - e[2]) < 1; }), e1 = fr[k + 1].enemies.find(x => x[0] === e0[0]);
  P.v.setT((fr[k].t + fr[k + 1].t) / 2);
  const idx = fr[k].enemies.indexOf(e0), g = P.gE.children.find(c => c.children[2].text.startsWith('#' + e0[0] + ' '));
  const x = Number(g.attrs.transform.match(/translate\(([-\d.]+),/)[1]);
  assert.ok(Math.abs(x - ((e0[2] + e1[2]) / 2 + 0.5) * 40) < 0.11, `x ${x}`);
  assert.ok(idx >= 0);
  return `${Math.ceil((RES.duration + 5) / 5) + 1} playhead positions; enemy #${e0[0]} at c ${e0[2]} -> ${e1[2]} drawn at c ${(x / 40 - 0.5).toFixed(3)}`;
});

ok('an operator that died: planned ghost before deploy, on the field, then marked down; timeline and table show the loss', () => {
  const P = runPage(HTML), loss = RES.losses.find(l => l.cause === 'died'), dep = RES.deploys.find(d => d.name === loss.name);
  assert.ok(loss && dep, 'the fixture has a death');
  P.v.setT(Math.max(0, dep.t - 1)); if (dep.t >= 1) assert.ok(/\bplanned\b/.test(opG(P, loss.name).className));
  P.v.setT((dep.t + loss.t) / 2); assert.ok(/\bon\b/.test(opG(P, loss.name).className));
  P.v.setT(loss.t + 1); assert.ok(/\bgone\b/.test(opG(P, loss.name).className), opG(P, loss.name).className);
  const tl = P.ids.get('tl').all(n => n.className === 'tl-loss');
  assert.strictEqual(tl.length, RES.losses.length);
  assert.ok(P.ids.get('rows').children.some(tr => tr.textContent.includes(loss.name) && tr.textContent.includes('down')));
  assert.ok(P.ids.get('kpis').textContent.includes('Operators lost' + RES.losses.filter(l => l.cause === 'died').length));
  return `${loss.name} deployed ${dep.t} s, down ${loss.t} s; ${RES.losses.length} loss markers`;
});

ok('skill active: glow class during a skill window, range overlay switches from base to the skill range', () => {
  const P = runPage(HTML), u = RES.skillUses.find(x => x.name === '银灰'), o = P.v.ops.find(x => x.name === '银灰');
  assert.ok(u && o.active, '银灰 S3 has a different skill range');
  P.v.select('银灰');
  P.v.setT(u.t - 1);
  assert.ok(!/\bactive\b/.test(o.g.className));
  const cur = () => P.gR.children.filter(c => c.className === 'rng').length;
  assert.strictEqual(cur(), o.base.length);
  P.v.setT((u.t + u.end) / 2);
  assert.ok(/\bactive\b/.test(o.g.className) && /\bsel\b/.test(o.g.className));
  assert.strictEqual(cur(), o.active.length);
  assert.ok(P.ids.get('info').textContent.includes('skill ACTIVE'));
  assert.strictEqual(P.ids.get('tl').all(n => n.className === 'tl-skill').length, RES.skillUses.length, 'one timeline mark per skill use');
  return `银灰 ${u.skill} ${u.t}-${u.end} s: range ${o.base.length} -> ${o.active.length} tiles`;
});

ok('playback: play at x1 and x8, pause at the end, arrow keys step by the frame spacing, resize redraws the timeline', () => {
  const P = runPage(HTML);
  P.v.setT(10); P.v.play(); P.pump(100, 10);
  assert.ok(Math.abs(P.v.t - 11) < 1e-6, `x1: ${P.v.t}`);
  P.ids.get('speeds').children[3].fire('click'); P.pump(100, 10);
  assert.ok(Math.abs(P.v.t - 19) < 1e-6, `x8: ${P.v.t}`);
  P.v.setT(RES.duration - 0.1); P.pump(100, 5);
  assert.strictEqual(P.v.t, RES.duration); assert.ok(P.ids.get('play').textContent.includes('Play'), 'paused at the end');
  P.v.setT(50); P.document.fire('keydown', { key: 'ArrowRight', target: P.document });
  assert.strictEqual(P.v.t, 50 + RES.trace.sampleDt);
  P.document.fire('keydown', { key: 'ArrowLeft', shiftKey: true, target: P.document });
  assert.strictEqual(P.v.t, 45.5);
  P.ids.get('tl').w = 390; P.window.fire('resize');
  assert.strictEqual(P.ids.get('tl').children[0].attrs.width, '390');
  return 'x1 +1 s, x8 +8 s per second, Shift+Left -5 s';
});

ok('zero enemies in the trace (opts.enemies = []): page renders, no enemy drawn, kills 0', () => {
  const res = sim.simulate(ST, PLAN, { ...OPTS, enemies: [], trace: true });
  assert.ok(res.trace.frames.every(f => f.enemies.length === 0));
  const html = V.renderHtml({ stage: ST, result: res, plan: PLAN, meta: { enemies: [] } });
  assert.deepStrictEqual(dataOf(html).result, res);
  const P = runPage(html, { width: 390 });
  for (const t of [0, res.duration / 2, res.duration]) { P.v.setT(t); assert.strictEqual(P.gE.children.length, 0); }
  assert.ok(P.ids.get('status').textContent.includes('kills 0 / 0'));
  // the same with operators on the field: the real trace with every enemy removed from every frame
  const r2 = JSON.parse(JSON.stringify(RES));
  r2.trace.frames.forEach(f => { f.enemies = []; });
  r2.trace.events = r2.trace.events.filter(e => e.type !== 'kill' && e.type !== 'leak');
  const Q = runPage(V.renderHtml({ stage: ST, result: r2, plan: PLAN, meta: {} }));
  for (let t = 0; t <= r2.duration; t += 7) { Q.v.setT(t); assert.strictEqual(Q.gE.children.length, 0); }
  assert.ok(Q.v.ops.some(o => o.state === 'on' || o.state === 'gone'));
  return `simulated: duration ${res.duration} s, ${res.trace.frames.length} frame, ${res.deploys.length} deploys; stripped trace: ${r2.trace.frames.length} frames, ${r2.deploys.length} deploys`;
});

ok('no trace and no plan: the page still renders (operators from result.deploys, no range), and says the trace is missing', () => {
  const res = sim.simulate(ST, PLAN, { ...OPTS, enemies: ENEMIES });
  const html = V.renderHtml({ stage: ST, result: res, plan: null });
  const P = runPage(html);
  P.v.setT(res.duration);
  assert.strictEqual(P.v.ops.length, res.deploys.length);
  assert.ok(P.v.ops.every(o => o.base.length === 0 && o.active === null));
  assert.ok(P.ids.get('foot').textContent.includes('no trace'));
  assert.throws(() => V.renderHtml({ stage: ST }), /result/);
  return 'renderHtml without stage or result throws';
});

ok('CLI: node combat/render.js 彼处水如酒 --out <tmp> writes the page for the hand-written plan', () => {
  const out = path.join(os.tmpdir(), 'bf_render_test_' + process.pid + '.html');
  const log = console.log; let lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { V.main(['彼处水如酒', '--out', out]); } finally { console.log = log; }
  const html = fs.readFileSync(out, 'utf8'), d = dataOf(html), size = fs.statSync(out).size;
  fs.unlinkSync(out);
  assert.ok(d.result.trace && d.result.trace.frames.length > 0 && d.heat && d.meta.notes.length > 5);
  assert.strictEqual(d.result.deploys.length, 6);
  return `${size} bytes; ${lines[1]}`;
});

console.log(`\n${passed} checks passed`);
