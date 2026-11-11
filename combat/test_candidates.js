// Tests for combat/candidates.js. Run: node combat/test_candidates.js  (one line per passed check, non-zero exit on
// the first failure; the instance size table is printed at the end as '#' lines)
'use strict';
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('./candidates.js');
const O = require('./operators.js');
const sim = require('./sim.js');
const sm = require('./stage_model.js');
const Z = require('./optimize.js');

let passed = 0;
const ok = (name, fn) => {
  try { const info = fn(); console.log(`ok ${++passed} - ${name}${info ? '  [' + info + ']' : ''}`); }
  catch (e) { console.log(`not ok ${passed + 1} - ${name}`); console.error(e); process.exit(1); }
};
const near = (x, want, tol, what) => assert.ok(Math.abs(x - want) <= tol * Math.max(1, Math.abs(want)), `${what}: got ${x}, want ${want}`);
const rng = Z.mulberry32(20261111);
const randInt = (a, b) => a + Math.floor(rng() * (b - a + 1));

// ---------- synthetic fixtures (same tile encoding as test_sim.js) ----------
function mkStage(rows) {
  const grid = rows.map(row => [...row].map(ch => ({ key: ch === '^' ? 'tile_wall' : ch === '#' ? 'tile_forbidden' : ch === '_' ? 'tile_road' : 'tile_floor',
    high: ch === '^', walkable: ch === '_' || ch === '.', deployable: ch === '^' || ch === '_', hole: false })));
  const H = rows.length;
  return { H, W: rows[0].length, grid, name: 'synthetic', id: 'syn', deployLimit: 6, initialCost: 99, toGrid: p => ({ r: H - 1 - p.row, c: p.col }) };
}
const mkEnemy = (pth, o = {}) => ({ id: o.id ?? 0, key: 'syn', name: 'dummy', type: 'NORMAL', motion: o.motion || 'WALK', hp: o.hp ?? 1e9, atk: 0, def: 0, res: 0,
  speed: 1, interval: 1, life: 1, rangeRadius: -1, applyWay: 'MELEE', damageTaken: 1, wave: 0, frag: 0, group: null, spawn: o.spawn ?? 0, path: pth });
// row 1 walked east, one tile per 2 s: tile c is entered at x = c - 0.5, i.e. t = 2c - 1
const straight = n => Array.from({ length: n }, (_, c) => ({ r: 1, c, t: 2 * c }));

// ---------- real fixtures ----------
const R = O.loadRoster(path.join(__dirname, 'roster.example.json'));
const by = Object.fromEntries(R.operators.map(o => [o.name, o]));
const BASE = { secrecy: R.secrecy, floor: R.floor, rules: R.rules };     // N15 floor 5, 地形图 + 舞鞋 rules
const ST = sm.loadStage('彼处水如酒');
const E = sim.sampleEnemies(ST, BASE);
const HORIZON = C.horizonOf(E);

// ---------- 1. correlation, kernels, summed-area tables ----------
const randMap = (H, W, int) => Array.from({ length: H }, () => Array.from({ length: W }, () => (int ? randInt(0, 9) : rng() * 100)));
const randMask = () => Array.from({ length: randInt(1, 12) }, () => ({ dr: randInt(-4, 4), dc: randInt(-4, 4) }));   // may repeat offsets
// the textbook definition on a dense kernel: out[r][c] = sum_{i,j} K[i][j] * map[r + i - r0][c + j - c0]
function bruteCorrelate(map, kern) {
  const H = map.length, W = map[0].length, { kernel, r0, c0 } = kern;
  return map.map((row, r) => row.map((_, c) => {
    let s = 0;
    for (let i = 0; i < kernel.length; i++) for (let j = 0; j < kernel[i].length; j++) {
      const y = r + i - r0, x = c + j - c0;
      if (kernel[i][j] && y >= 0 && x >= 0 && y < H && x < W) s += kernel[i][j] * map[y][x];
    }
    return s;
  }));
}

ok('correlate2d equals the dense-kernel definition on 300 random maps and masks (offsets past the edges, repeated offsets)', () => {
  let cells = 0;
  for (let t = 0; t < 300; t++) {
    const H = randInt(1, 9), W = randInt(1, 14), map = randMap(H, W, t % 2 === 0), mask = randMask();
    const got = C.correlate2d(map, mask), want = bruteCorrelate(map, C.maskToKernel(mask));
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { near(got[r][c], want[r][c], 1e-12, `cell ${r},${c} trial ${t}`); cells++; }
    const back = C.kernelToMask(C.maskToKernel(mask)), key = m => new Set(m.map(o => o.dr + ',' + o.dc));
    assert.deepStrictEqual(key(back), key(mask), 'kernelToMask(maskToKernel(m)) is the offset set of m');
  }
  return `${cells} cells`;
});

ok('correlate2d with a rectangular mask equals rectSum of the summed-area table at every cell (edge clipping), 200 random cases', () => {
  let cells = 0;
  for (let t = 0; t < 200; t++) {
    const H = randInt(1, 10), W = randInt(1, 14), int = t % 2 === 0, map = randMap(H, W, int), sat = C.summedAreaTable(map);
    const a = randInt(-4, 2), b = a + randInt(0, 4), p = randInt(-4, 2), q = p + randInt(0, 4), mask = [];
    for (let dr = a; dr <= b; dr++) for (let dc = p; dc <= q; dc++) mask.push({ dr, dc });
    const got = C.correlate2d(map, mask);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const s = C.rectSum(sat, r + a, c + p, r + b, c + q);
      if (int) assert.strictEqual(got[r][c], s, `integer map: exact at ${r},${c}`); else near(got[r][c], s, 1e-9, `float map at ${r},${c}`);
      cells++;
    }
    assert.strictEqual(C.rectSum(sat, 0, 0, H - 1, W - 1), sat[H][W]);
    assert.strictEqual(C.rectSum(sat, H, 0, H + 3, W), 0, 'a rectangle entirely outside the map sums to 0');
  }
  return `${cells} cells`;
});

// ---------- 2. seconds in range ----------
ok('secondsInRange on synthetic paths equals the hand values (rounded-position tile, rotation, edges, wait, diagonal, hidden leg, FLY)', () => {
  const st = { H: 3, W: 10 }, e = mkEnemy(straight(10)), line3 = [{ dr: 0, dc: 0 }, { dr: 0, dc: 1 }, { dr: 0, dc: 2 }];
  // tiles 3..5 are occupied for x in [2.5, 5.5), i.e. t in [5, 11)
  assert.strictEqual(C.secondsInRange(st, line3, 1, 3, 'E', e), 6);
  // facing W from (1,6): tiles 6, 5, 4 -> x in [3.5, 6.5) -> t in [7, 13)
  assert.strictEqual(C.secondsInRange(st, line3, 1, 6, 'W', e), 6);
  // facing N from (2,4): tiles (2,4), (1,4), (0,4); only (1,4) is on the path: t in [7, 9)
  assert.strictEqual(C.secondsInRange(st, line3, 2, 4, 'N', e), 2);
  // facing S from (0,4): tiles (0,4), (1,4), (2,4)
  assert.strictEqual(C.secondsInRange(st, line3, 0, 4, 'S', e), 2);
  // start edge: tiles 0..2 from t = 0 (spawn on tile 0) to x = 2.5 -> 5 s; end edge: tiles 8, 9 (10 is off the map) from
  // t = 15 to the exit at t = 18 -> 3 s
  assert.strictEqual(C.secondsInRange(st, line3, 1, 0, 'E', e), 5);
  assert.strictEqual(C.secondsInRange(st, line3, 1, 8, 'E', e), 3);
  // a wait of 4 s on tile 1: [1, 2) walking in + 4 s waiting + [6, 7) walking out = 6 s
  const wait = mkEnemy([{ r: 1, c: 0, t: 0 }, { r: 1, c: 1, t: 2 }, { r: 1, c: 1, t: 6 }, { r: 1, c: 2, t: 8 }]);
  assert.strictEqual(C.secondsInRange(st, [{ dr: 0, dc: 0 }], 1, 1, 'E', wait), 6);
  // diagonal steps (0,0) -> (1,1) -> (2,2), 2 s each: both coordinates round over at half way, tile (1,1) for t in [1, 3)
  const diag = mkEnemy([{ r: 0, c: 0, t: 0 }, { r: 1, c: 1, t: 2 }, { r: 2, c: 2, t: 4 }]);
  assert.strictEqual(C.secondsInRange(st, [{ dr: 0, dc: 0 }], 1, 1, 'E', diag), 2);
  assert.strictEqual(C.secondsInRange(st, [{ dr: 0, dc: 0 }], 1, 0, 'E', diag), 0, 'a diagonal never stands on the corner tile');
  // a leg that starts at a hidden waypoint is off the map: the 3 s wait at (1,1) does not count
  const hid = mkEnemy([{ r: 1, c: 0, t: 0 }, { r: 1, c: 1, t: 2, hidden: true }, { r: 1, c: 1, t: 5 }, { r: 1, c: 2, t: 7 }]);
  assert.strictEqual(C.secondsInRange(st, [{ dr: 0, dc: 0 }], 1, 1, 'E', hid), 2);
  // FLY: counted only with canHitAir (profile flag, or the 7th argument for a bare range)
  const fly = mkEnemy(straight(10), { motion: 'FLY' });
  assert.strictEqual(C.secondsInRange(st, { range: line3, canHitAir: false }, 1, 3, 'E', fly), 0);
  assert.strictEqual(C.secondsInRange(st, { range: line3, canHitAir: true }, 1, 3, 'E', fly), 6);
  assert.strictEqual(C.secondsInRange(st, line3, 1, 3, 'E', fly, false), 0);
  // intervals are absolute (spawn + path time)
  assert.deepStrictEqual(C.intervalsInRange(st, line3, 1, 3, 'E', mkEnemy(straight(10), { spawn: 100 })), [[105, 111]]);
  return '11 hand values';
});

ok('secondsInRange agrees with what sim.simulate sees: a 1-damage true-damage operator hitting every 0.1 s deals ~10 x seconds in range', () => {
  const st = mkStage(['^^^^^^^^^^', '__________']);
  const op = { id: 'char_probe', name: 'probe', position: 'RANGED', cost: 1, block: 0, hp: 1e6, atk: 1, def: 0, res: 0, interval: 0.1, damageType: 'true',
    targets: 1, canHitAir: true, range: [{ dr: 1, dc: 0 }, { dr: 1, dc: 1 }], skillSpec: null };
  const cases = [
    [mkEnemy([...straight(3), { r: 1, c: 2, t: 7 }, ...straight(10).slice(3).map(p => ({ ...p, t: p.t + 3 }))]), 0, 2, 'E', 7],   // wait 3 s on tile 2
    [mkEnemy(straight(10)), 0, 5, 'E', 4],
    [mkEnemy(straight(10)), 0, 0, 'E', 3],
  ];
  const out = [];
  for (const [e, r, c, dir, hand] of cases) {
    const s = C.secondsInRange(st, op, r, c, dir, e);
    assert.strictEqual(s, hand, 'hand value');
    const res = sim.simulate(st, { deploys: [{ op, r, c, dir }] }, { enemies: [e] });
    near(res.hpRemoved * op.interval, s, 0.25 / Math.max(1, s), 'simulated damage x interval vs seconds in range');
    out.push(`${s} s -> ${res.hpRemoved} hits`);
  }
  return out.join(', ');
});

// ---------- 3. heatmaps ----------
const visible = e => { let s = 0; for (let k = 0; k + 1 < e.path.length; k++) if (!e.path[k].hidden) s += e.path[k + 1].t - e.path[k].t; return s; };
ok('heatmaps: sum over tiles of time = summed (visible) path durations, of hp = sum of HP x duration; FLY share on 物欲遮天', () => {
  const info = [];
  for (const name of ['彼处水如酒', '物欲遮天', '虫虫游戏厅']) {
    const st = name === '彼处水如酒' ? ST : sm.loadStage(name), en = name === '彼处水如酒' ? E : sim.sampleEnemies(st, BASE), hm = C.heatmaps(st, en);
    const sum = m => m.flat().reduce((a, b) => a + b, 0);
    const dur = en.reduce((s, e) => s + visible(e), 0), all = en.reduce((s, e) => s + e.path[e.path.length - 1].t, 0);
    near(sum(hm.time), dur, 1e-9, name + ' time');
    near(sum(hm.hp), en.reduce((s, e) => s + e.hp * visible(e), 0), 1e-9, name + ' hp');
    near(sum(hm.airTime), en.filter(e => e.motion === 'FLY').reduce((s, e) => s + visible(e), 0), 1e-9, name + ' air time');
    for (let r = 0; r < st.H; r++) for (let c = 0; c < st.W; c++) assert.ok(hm.time[r][c] >= 0 && hm.airTime[r][c] <= hm.time[r][c] + 1e-9);
    info.push(`${name}: ${en.length} enemies, ${dur.toFixed(1)} enemy-s on the map (${(all - dur).toFixed(1)} hidden), FLY ${(100 * sum(hm.airTime) / dur).toFixed(0)}%`);
  }
  return info.join('; ');
});

ok('placement heatmap = exact sum: correlate2d(heatmap, rotated range)[r][c] = sum over enemies of secondsInRange (time and HP-seconds)', () => {
  const hm = C.heatmaps(ST, E);
  let n = 0, best = { v: -1 };
  for (const name of ['艾雅法拉', '银灰', '能天使']) for (const dir of C.DIRS) {
    const range = by[name].range, ct = C.correlate2d(hm.time, C.rotated(range, dir)), ch = C.placementHeatmap(ST, E, range, dir);
    for (let r = 0; r < ST.H; r++) for (let c = 0; c < ST.W; c++) {
      if ((r * 7 + c * 3) % 4) continue;                         // every 4th tile keeps the check fast
      let s = 0, h = 0;
      for (const e of E) { const x = C.secondsInRange(ST, range, r, c, dir, e); s += x; h += x * e.hp; }
      near(ct[r][c], s, 1e-9, `${name} ${dir} (${r},${c}) seconds`); near(ch[r][c], h, 1e-9, `${name} ${dir} (${r},${c}) HP-seconds`);
      if (name === '艾雅法拉' && h > best.v) best = { v: h, r, c, dir };
      n++;
    }
  }
  return `${n} placements; 艾雅法拉's best of them by HP-seconds (${best.r},${best.c}) ${best.dir}`;
});

// ---------- 4. buildInstance on 彼处水如酒 ----------
const t0 = performance.now();
const ALL = C.buildInstance(ST, R.operators, E, { K: Infinity, opts: BASE });
const msAll = performance.now() - t0;
const t1 = performance.now();
const K4 = C.buildInstance(ST, R.operators, E, { K: 4, opts: BASE });
const msK4 = performance.now() - t1;

function checkInstance({ inst, meta }, K, ops) {
  assert.strictEqual(inst.limit, sim.deployLimit(ST, BASE));
  assert.strictEqual(inst.hp.length, E.length); assert.strictEqual(inst.w.length, E.length);
  const perOp = new Map(), keys = new Set();
  inst.cands.forEach((cd, k) => {
    const m = meta.cands[cd.id], op = ops[cd.op];
    assert.strictEqual(cd.id, k, 'ids are 0..n-1 in order'); assert.strictEqual(m.id, cd.id);
    const r = Math.floor(cd.tile / ST.W), c = cd.tile % ST.W;
    assert.ok(sim.canDeploy(ST, op, r, c, null, BASE), `${op.name} (${r},${c}) is legal per sim.canDeploy`);
    assert.deepStrictEqual([m.r, m.c, m.dir, m.opName, m.cost, m.op], [r, c, cd.dir, op.name, op.cost, cd.op]);
    assert.strictEqual(cd.cost, op.cost); assert.ok(C.DIRS.includes(cd.dir));
    assert.ok(cd.pot instanceof Float64Array && cd.pot.length === E.length);
    for (const v of cd.pot) assert.ok(Number.isFinite(v) && v >= 0, 'pot is finite and >= 0');
    near(Z.value(inst, [cd.id]), m.solo, 1e-12, 'meta solo = value of the singleton (capped at enemy HP)');
    const key = cd.op + '|' + cd.tile + '|' + cd.dir;
    assert.ok(!keys.has(key), 'no duplicate placement'); keys.add(key);
    perOp.set(cd.op, (perOp.get(cd.op) || 0) + 1);
  });
  for (const [, n] of perOp) assert.ok(n <= K);
  const sum = f => meta.perOp.reduce((s, x) => s + x[f], 0);
  for (const row of meta.perOp) {
    const chain = ['legal', 'afterSymmetry', 'afterEmpty', 'afterCoverage', 'nonZero', 'kept'].map(f => row[f]);
    for (let j = 1; j < chain.length; j++) assert.ok(chain[j] <= chain[j - 1], `${row.opName}: counts shrink along the pipeline`);
    assert.strictEqual(row.nonZero - row.kept, row.dropped);
    assert.strictEqual(row.kept, perOp.get(row.op) || 0);
  }
  for (const f of ['legal', 'afterSymmetry', 'afterEmpty', 'afterCoverage', 'nonZero', 'kept', 'dropped']) assert.strictEqual(meta.counts[f], sum(f));
  assert.strictEqual(meta.counts.kept, inst.cands.length);
}

ok('buildInstance(彼处水如酒, example roster, K = Infinity and 4): every candidate legal per sim.canDeploy, pot finite >= 0, meta consistent, 夜莺 (heal) only in meta.nonDamage', () => {
  checkInstance(ALL, Infinity, R.operators); checkInstance(K4, 4, R.operators);
  for (const x of [ALL, K4]) {
    assert.deepStrictEqual(x.meta.nonDamage.map(n => n.opName), ['夜莺']);
    assert.ok(!x.inst.cands.some(cd => R.operators[cd.op].name === '夜莺'));
    assert.strictEqual(x.meta.nonDamage[0].tiles.length, x.meta.perOp.find(p => p.opName === '夜莺').legalTiles);
  }
  // K = 4 keeps exactly the 4 best of the K = Infinity list of each operator
  for (let oi = 0; oi < R.operators.length; oi++) {
    const top = ALL.meta.cands.filter(m => m.op === oi).slice(0, 4).map(m => [m.tile, m.dir, m.solo]);
    assert.deepStrictEqual(K4.meta.cands.filter(m => m.op === oi).map(m => [m.tile, m.dir, m.solo]), top);
  }
  const over = ALL.inst.cands.filter(cd => cd.pot.some((v, i) => v > ALL.inst.hp[i])).length;
  return `${ALL.inst.cands.length} candidates with K = Infinity (built in ${msAll.toFixed(0)} ms), ${K4.inst.cands.length} with K = 4 (${msK4.toFixed(0)} ms), limit ${K4.inst.limit}; `
    + `${over} candidates have pot > enemy HP somewhere (allowed: value() caps it)`;
});

ok("potMode 'base' is exactly CONTRACT 7: pot[i] = dpsVs(base profile, enemy i) x secondsInRange, and dpsVs = operators.dpsAgainst for plain profiles", () => {
  const B = C.buildInstance(ST, R.operators, E, { K: 3, potMode: 'base', opts: BASE });
  let n = 0, plain = 0;
  for (const cd of B.inst.cands) {
    const m = B.meta.cands[cd.id], prof = C.skillMix(R.operators[cd.op], { potMode: 'base' }).sum[0].profile;
    E.forEach((e, i) => { near(cd.pot[i], C.dpsVs(prof, e) * C.secondsInRange(ST, prof, m.r, m.c, m.dir, e), 1e-12, `${m.opName} enemy ${i}`); n++; });
    const extras = ['atkScaleByType', 'bonusHit', 'hitsByTarget', 'dot', 'resIgnore'].some(f => prof[f] != null);
    if (!extras) { for (const e of E) near(C.dpsVs(prof, e), O.dpsAgainst(prof, e), 1e-12, 'plain profile'); plain++; }
  }
  return `${n} (candidate, enemy) pairs; ${plain} candidates with a plain profile`;
});

// an operator whose skill only increases damage: every active state covers the base range, keeps canHitAir and has at
// least the base DPS against every enemy of the stage (instant damage only adds)
const superset = (big, small) => { const s = new Set(big.map(o => o.dr + ',' + o.dc)); return small.every(o => s.has(o.dr + ',' + o.dc)); };
function onlyIncreases(op) {
  const base = C.skillMix(op, { potMode: 'base' }).sum[0].profile, act = C.skillMix(op, { potMode: 'active', horizon: HORIZON });
  return act.max.every(({ profile: p }) => superset(p.range, base.range) && (p.canHitAir || !base.canHitAir) && E.every(e => C.dpsVs(p, e) >= C.dpsVs(base, e) - 1e-9));
}
ok("potMode 'active' >= 'average' >= 'base' elementwise on every legal placement of every operator whose skill only increases damage", () => {
  const ops = R.operators.filter(op => C.dealsDamage(op)), mono = ops.filter(onlyIncreases), info = [];
  assert.ok(mono.length >= 6, 'most of the roster qualifies');
  let n = 0;
  for (const op of mono) {
    let up = 0;
    for (let r = 0; r < ST.H; r++) for (let c = 0; c < ST.W; c++) {
      if (!sim.canDeploy(ST, op, r, c, null, BASE)) continue;
      for (const dir of C.DIRS) {
        const [b, a, x] = ['base', 'average', 'active'].map(potMode => C.potentials(ST, op, r, c, dir, E, { potMode, horizon: HORIZON }));
        for (let i = 0; i < E.length; i++) {
          assert.ok(x[i] >= a[i] - 1e-9 * Math.max(1, a[i]), `${op.name} (${r},${c}) ${dir} enemy ${i}: active ${x[i]} < average ${a[i]}`);
          assert.ok(a[i] >= b[i] - 1e-9 * Math.max(1, b[i]), `${op.name} (${r},${c}) ${dir} enemy ${i}: average ${a[i]} < base ${b[i]}`);
          if (a[i] > b[i] * (1 + 1e-9)) up++;
        }
        n++;
      }
    }
    const mix = C.skillMix(op, { potMode: 'average', horizon: HORIZON });
    info.push(`${op.name} ${mix.source} ${(100 * mix.uptime).toFixed(0)}%${up ? '' : ' (=)'}`);
  }
  const out = ops.filter(op => !mono.includes(op)).map(op => op.name);
  return `${n} placements of ${mono.length} operators: ${info.join(', ')}; not monotone (skipped): ${out.join(', ') || 'none'}`;
});

// ---------- 5. the optimizer on the built instances ----------
ok('optimize.branchAndBound on the K = 4 instance: feasible, proven, >= greedy; planFromSet gives legal deploys that sim.simulate runs', () => {
  const { inst, meta } = K4, bb = Z.branchAndBound(inst), gr = Z.greedy(inst);
  assert.ok(Z.feasible(inst, bb.set) && bb.proven, 'proven optimum');
  assert.ok(bb.value >= gr.value - 1e-6 * gr.value);
  const so = Z.solve(inst);
  near(so.value, bb.value, 1e-9, 'solve (dominance pruning + B&B) = B&B');
  const deploys = C.planFromSet(inst, meta, bb.set, R.operators), occ = new Set();
  for (const d of deploys) { assert.ok(sim.canDeploy(ST, d.op, d.r, d.c, occ, BASE)); occ.add(d.r * ST.W + d.c); }
  assert.throws(() => C.planFromSet(inst, meta, [0, 1], R.operators), /twice/, 'two candidates of one operator are rejected');
  const res = sim.simulate(ST, { deploys: deploys.slice().sort((a, b) => a.op.cost - b.op.cost) }, BASE);
  assert.strictEqual(res.kills + res.leaks + res.alive, res.totalEnemies);
  return `${inst.cands.length} candidates, limit ${inst.limit}: optimum ${(100 * bb.value / meta.hpTotal).toFixed(1)}% of enemy HP (surrogate) with ${bb.set.length} placements, `
    + `B&B ${bb.stats.explored} nodes, greedy ${(gr.value / bb.value).toFixed(4)} of optimum; ${deploys.map(d => `${d.op.name}(${d.r},${d.c})${d.dir}`).join(' ')} `
    + `simulated (cost order, no timeline yet): kills ${res.kills}/${res.totalEnemies}, HP removed ${(100 * res.hpRemoved / res.hpTotal).toFixed(1)}%`;
});

ok('branchAndBound = bruteForce on a reduced instance (5 operators, K = 3, limit 3)', () => {
  const ops = ['艾雅法拉', '逻各斯', '银灰', '能天使', '史尔特尔'].map(n => by[n]);
  const { inst } = C.buildInstance(ST, ops, E, { K: 3, limit: 3, opts: BASE });
  assert.strictEqual(inst.cands.length, 15); assert.strictEqual(inst.limit, 3);
  const bb = Z.branchAndBound(inst), bf = Z.bruteForce(inst);
  near(bb.value, bf.value, 1e-9, 'B&B value = brute force value');
  assert.ok(bb.proven && Z.feasible(inst, bb.set));
  near(Z.value(inst, bb.set), bf.value, 1e-9, 'the B&B set is worth the brute-force optimum');
  return `value ${bf.value.toFixed(0)}, set ${bb.set.join(',')}; B&B ${bb.stats.explored} nodes vs brute force ${bf.stats.explored}`;
});

// ---------- 6. target share ----------
function unionLength(iv) {
  iv.sort((a, b) => a[0] - b[0]);
  let s = 0, a = -Infinity, b = -Infinity;
  for (const [x, y] of iv) { if (x > b) { if (b > a) s += b - a; a = x; b = y; } else b = Math.max(b, y); }
  return s + (b > a ? b - a : 0);
}
ok('targetShare: pot <= the independent pot; a single-target operator gets exactly its union seconds in range; many targets = independent', () => {
  const op = by['能天使'], prof = C.skillMix(op, { potMode: 'base' }).sum[0].profile, info = [];
  assert.strictEqual(prof.targets, 1);
  for (const [r, c, dir] of [[5, 7, 'W'], [2, 8, 'E'], [5, 3, 'E']]) {
    const ind = C.potentials(ST, op, r, c, dir, E, { potMode: 'base' }), sh = C.potentials(ST, op, r, c, dir, E, { potMode: 'base', targetShare: true });
    let eff = 0;
    E.forEach((e, i) => { assert.ok(sh[i] <= ind[i] * (1 + 1e-12) + 1e-12); const d = C.dpsVs(prof, e); if (d > 0) eff += sh[i] / d; });
    const iv = [];
    for (const e of E) iv.push(...C.intervalsInRange(ST, prof, r, c, dir, e));
    near(eff, unionLength(iv), 1e-9, 'effective seconds of a 1-target operator = length of the union of the in-range intervals');
    info.push(`(${r},${c})${dir}: ${unionLength(iv).toFixed(1)} s union vs ${E.reduce((s, e) => s + C.secondsInRange(ST, prof, r, c, dir, e), 0).toFixed(1)} s summed`);
  }
  const many = { ...op, profiles: { base: { ...prof, targets: 999 }, active: { ...prof, targets: 999 } }, skillSpec: null };
  const a = C.potentials(ST, many, 5, 7, 'W', E, { potMode: 'base' }), b = C.potentials(ST, many, 5, 7, 'W', E, { potMode: 'base', targetShare: true });
  for (let i = 0; i < E.length; i++) near(b[i], a[i], 1e-9, 'targets >= enemies present: share = independent');
  const S = C.buildInstance(ST, R.operators, E, { K: 4, opts: BASE, targetShare: true }), bb = Z.branchAndBound(S.inst);
  return info.join('; ') + `; K = 4 instance with share: optimum ${(100 * bb.value / S.meta.hpTotal).toFixed(1)}% of HP (independent: ${(100 * Z.branchAndBound(K4.inst).value / K4.meta.hpTotal).toFixed(1)}%)`;
});

// ---------- 7. ASCII map ----------
ok("asciiMap: the tile symbols of stage_model's CLI, the same legend, operator letters with facing arrows", () => {
  const cli = execFileSync(process.execPath, [path.join(__dirname, 'stage_model.js'), '彼处水如酒'], { encoding: 'utf8' }).split(/\r?\n/);
  const li = cli.findIndex(l => l.startsWith('legend:')), cliRows = cli.slice(li + 1, li + 1 + ST.H).map(l => l.trim().split(' '));
  const plain = C.asciiMap(ST).split('\n');
  assert.ok(plain.includes(cli[li]), 'same legend line');
  const rows = plain.filter(l => /^ ?\d+  /.test(l)).map(l => l.slice(4).split(' '));
  assert.deepStrictEqual(rows, cliRows);
  const deploys = [{ op: by['艾雅法拉'], r: 5, c: 6, dir: 'E' }, { op: by['星熊'], r: 6, c: 5, dir: 'N' }, { op: by['银灰'], r: 2, c: 7, dir: 'S' }, { op: by['逻各斯'], r: 5, c: 7, dir: 'W' }];
  const txt = C.asciiMap(ST, deploys), lines = txt.split('\n'), cell = (r, c) => lines.find(l => l.startsWith(String(r).padStart(2) + '  ')).slice(4 + 2 * c, 6 + 2 * c);
  assert.deepStrictEqual(deploys.map(d => cell(d.r, d.c)), ['a>', 'b^', 'cv', 'd<']);
  assert.ok(txt.includes('a> 艾雅法拉 (5,6) E') && txt.includes('d< 逻各斯 (5,7) W'));
  return '\n' + txt.split('\n').map(l => '    ' + l).join('\n');
});

// ---------- instance size table ----------
console.log(`\n# instance size, 彼处水如酒 N15 floor 5, ${E.length} enemies, potMode ${K4.meta.potMode}, limit ${K4.inst.limit}`);
console.log('# operator    legal  symmetry  on path  distinct  value>0  kept K=4  dropped  uptime  source');
for (const row of K4.meta.perOp) {
  const nd = K4.meta.nonDamage.some(n => n.op === row.op);
  console.log('# ' + row.opName.padEnd(8, '　') + [row.legal, row.afterSymmetry, row.afterEmpty, row.afterCoverage, row.nonZero, row.kept, row.dropped].map((v, j) => String(v).padStart([5, 10, 9, 10, 9, 10, 9][j])).join('')
    + (nd ? '   no damage (heal): not a candidate' : `  ${(100 * row.uptime).toFixed(0).padStart(5)}%  ${row.source}${row.ignored.length ? ' (ignored: ' + row.ignored.join(', ') + ')' : ''}`));
}
const cnt = K4.meta.counts;
console.log('# total     ' + [cnt.legal, cnt.afterSymmetry, cnt.afterEmpty, cnt.afterCoverage, cnt.nonZero, cnt.kept, cnt.dropped].map((v, j) => String(v).padStart([5, 10, 9, 10, 9, 10, 9][j])).join(''));
console.log(`\n${passed} checks passed`);
