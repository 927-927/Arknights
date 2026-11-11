// Tests for demo.js: node combat/test_demo.js (one line per passed check, exit code 1 on failure).
'use strict';
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const sim = require('./sim.js');
const O = require('./operators.js');
const Z = require('./optimize.js');
const D = require('./demo.js');

let passed = 0, failed = 0;
function check(name, fn) {
  try { const info = fn(); passed++; console.log(`ok ${passed + failed} - ${name}${info ? '  [' + info + ']' : ''}`); }
  catch (e) { failed++; console.log(`not ok ${passed + failed} - ${name}\n  ${String(e.stack || e).split('\n').slice(0, 6).join('\n  ')}`); }
}
const tmp = ext => path.join(os.tmpdir(), `bf_test_demo_${process.pid}.${ext}`);

check('parseArgs: positional stage (also stage=X), numbers, flags, --html/--json with and without a file; bad input throws', () => {
  const a = D.parseArgs(['虫虫游戏厅', '--secrecy', '12', '--floor', '3', '--elite', '--K', '4', '--sims', '500', '--seed', '7', '--html', '--json', 'x.json', '--quiet']);
  assert.deepStrictEqual(a, { stage: '虫虫游戏厅', secrecy: 12, floor: 3, elite: true, K: 4, sims: 500, seed: 7, html: true, json: 'x.json', quiet: true });
  assert.deepStrictEqual(D.parseArgs(['--html', '彼处水如酒']), { html: true, stage: '彼处水如酒' });      // not a .html file: the stage
  assert.deepStrictEqual(D.parseArgs(['stage=物欲遮天', '--html', 'out/a.html']), { stage: '物欲遮天', html: 'out/a.html' });
  assert.throws(() => D.parseArgs(['--sims', 'many']), /number/);
  assert.throws(() => D.parseArgs(['--nope']), /unknown option/);
  assert.throws(() => D.parseArgs(['a', 'b']), /unexpected argument/);
  return '3 parses, 3 rejections';
});

check('decodeScore inverts sim.scoreOf on lifeLost / HP share / operators died', () => {
  let n = 0;
  for (const L of [0, 1, 5, 37]) for (const hp of [0, 0.123, 0.5, 0.9999, 1]) for (const died of [0, 2, 9]) for (const dur of [0, 71.3, 9999]) {
    const res = { lifeLost: L, hpRemoved: hp * 1000, hpTotal: 1000, losses: Array.from({ length: died }, () => ({ cause: 'died' })), duration: dur };
    const d = D.decodeScore(sim.scoreOf(res));
    assert.strictEqual(d.lifeLost, L); assert.strictEqual(d.died, died); assert.strictEqual(d.hpFrac, Math.round(hp * 1e4) / 1e4);
    n++;
  }
  return n + ' cases';
});

// one quick end-to-end run, reused by the checks below
const htmlPath = tmp('html'), jsonPath = tmp('json');
const printed = [];
const origLog = console.log;
let R, wall;
{
  const t0 = performance.now();
  console.log = (...xs) => printed.push(xs.join(' '));
  try { R = D.run({ stage: '彼处水如酒', sims: 300, K: 3, quiet: true, html: htmlPath, json: jsonPath }); }
  finally { console.log = origLog; }
  wall = performance.now() - t0;
}

check('quick run (彼处水如酒, --sims 300, --K 3, --quiet): returns results, prints nothing, the text has the 11 section headers in order', () => {
  assert.strictEqual(printed.length, 0);
  const heads = R.text.split('\n').filter(l => /^== \d+\. /.test(l)).map(l => Number(l.match(/^== (\d+)\./)[1]));
  assert.deepStrictEqual(heads, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(R.text.includes('[brute force vs branch and bound]') && R.text.includes('[Monte Carlo]') && R.text.includes('[0/1 knapsack]'));
  return `${(wall / 1000).toFixed(1)} s, ${R.text.split('\n').length} lines`;
});

check('section 5: brute force and branch and bound find the same optimum value on the small instance (5 operators, K 3, limit 3)', () => {
  const s = R.small;
  assert.strictEqual(s.equal, true);
  assert.ok(Math.abs(s.bf.value - s.bb.value) <= 1e-9 * Math.max(1, s.bf.value));
  assert.strictEqual(s.ops.length, Math.min(D.SMALL.ops, s.ops.length));
  assert.ok(s.bb.proven && s.bb.nodes <= s.bf.nodes, 'B&B explores no more nodes than brute force');
  assert.ok(s.bf.permutationSequences >= s.bf.nodes);
  return `value ${s.bf.value.toFixed(0)}, nodes ${s.bf.nodes} vs ${s.bb.nodes}, ${s.n} candidates`;
});

check('section 6: B&B proved optimal; every heuristic <= the optimum; greedy ratio in [1/3, 1]', () => {
  const f = R.full, optV = f['B&B (+ safe dominance)'].value;
  assert.strictEqual(f.proven, true);
  for (const [k, v] of Object.entries(f)) if (v && typeof v.value === 'number') assert.ok(v.value <= optV * (1 + 1e-9), k + ' beats the proven optimum');
  assert.ok(f.greedyRatio >= 1 / 3 - 1e-12 && f.greedyRatio <= 1 + 1e-12);
  return `optimum ${(100 * f['B&B (+ safe dominance)'].frac).toFixed(1)}% of HP, greedy ratio ${f.greedyRatio.toFixed(4)}`;
});

check('section 7: the knapsack choice fits the budget and the deploy limit, and equals brute force', () => {
  const k = R.knapsack, cost = k.chosen.reduce((s, n) => s + R.ops.find(o => o.name === n).cost, 0);
  assert.strictEqual(cost, k.cost); assert.ok(k.cost <= k.budget); assert.ok(k.chosen.length <= R.limit);
  assert.strictEqual(k.bruteEqual, true);
  const arrival = D.firstArrival(R.stage, R.enemies);
  assert.strictEqual(k.t, arrival.t);
  assert.ok(R.enemies.every(e => e.leaveAt >= arrival.t - 1e-9 || R.stage.grid[e.path[e.path.length - 1].r][e.path[e.path.length - 1].c].key !== 'tile_end'));
  return `t ${k.t.toFixed(1)} s, budget ${k.budget}, ${k.chosen.join(' + ') || 'nothing'} = ${k.cost} DP`;
});

check('final plan is legal: sim.canDeploy for each deploy in order (tiles of the earlier ones occupied), no operator twice, within deployLimit', () => {
  const W = R.stage.W, occ = new Set(), names = new Set();
  assert.ok(R.plan.deploys.length >= 1 && R.plan.deploys.length <= R.limit);
  assert.strictEqual(R.limit, sim.deployLimit(R.stage, R.simOpts));
  for (const d of R.plan.deploys) {
    assert.ok(sim.canDeploy(R.stage, d.op, d.r, d.c, occ, { elite: R.simOpts.elite, rules: R.simOpts.rules }), `${d.op.name} at (${d.r},${d.c})`);
    assert.ok(['E', 'S', 'W', 'N'].includes(d.dir));
    assert.ok(!names.has(d.op.name), d.op.name + ' twice');
    names.add(d.op.name); occ.add(d.r * W + d.c);
  }
  return R.plan.deploys.map(d => `${d.op.name}(${d.r},${d.c})${d.dir}`).join(' ');
});

check('re-simulating the final plan reproduces the reported result exactly (and the traced run has the same numbers)', () => {
  const again = sim.simulate(R.stage, R.plan, R.simOpts);
  assert.ok(util.isDeepStrictEqual(again, R.result));
  assert.strictEqual(R.reproduces, true);
  const { trace, ...plain } = R.traced;
  assert.ok(util.isDeepStrictEqual(plain, R.result));
  assert.ok(R.timeline.sims <= R.timeline.maxSims, 'the timeline budget is respected');
  return `life lost ${R.result.lifeLost}, kills ${R.result.kills}/${R.result.totalEnemies}, HP ${(100 * R.result.hpRemoved / R.result.hpTotal).toFixed(1)}%; ${R.timeline.sims}/${R.timeline.maxSims} sims`;
});

check('--html wrote a non-empty viewer page; --json wrote plan + result that rebuild the same run from the roster', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.ok(html.length > 10000 && html.startsWith('<!doctype html') && html.includes('id="bf-data"'));
  const blob = html.match(/<script type="application\/json" id="bf-data">([\s\S]*?)<\/script>/);
  assert.ok(blob, 'data blob present');
  const data = JSON.parse(blob[1]);
  assert.strictEqual(data.result.score, R.result.score);
  assert.ok(data.result.trace && data.result.trace.frames.length > 1, 'the page carries the traced re-simulation');
  assert.deepStrictEqual(data.ops.map(x => x.name), R.plan.deploys.map(d => d.op.name));
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8')), roster = O.loadRoster(path.join(__dirname, 'roster.example.json'));
  const by = Object.fromEntries(roster.operators.map(o => [o.name, o]));
  const plan = { deploys: j.plan.deploys.map(d => ({ op: by[d.op], r: d.r, c: d.c, dir: d.dir, t: d.t })), skills: j.plan.skills };
  const res = sim.simulate(R.stage, plan, { ...R.simOpts, rules: roster.rules });
  assert.strictEqual(res.score, j.result.score);
  assert.ok(!('trace' in j.result));
  return `${html.length} chars of HTML, ${fs.statSync(jsonPath).size} bytes of JSON`;
});

check('section 8 bookkeeping: pool -> screen -> refine; completeSet fills to the limit with a feasible set worth at least as much', () => {
  const t = R.timeline;
  assert.ok(t.pool >= 1 && t.screen.length >= 1 && t.sets.length >= 1 && t.sets.length <= D.TOP_SETS);
  for (const s of t.sets) assert.ok(Array.isArray(s.phases) && s.phases.length >= 1);
  const { inst } = require('./candidates.js').buildInstance(R.stage, R.ops, R.enemies, { K: 3, opts: R.simOpts });
  const opt = Z.solve(inst), full = D.completeSet(inst, opt.set);
  assert.ok(Z.feasible(inst, full));
  assert.ok(full.length === Math.min(inst.limit, new Set(inst.cands.map(c => c.op)).size) || full.length === inst.limit);
  assert.ok(Z.value(inst, full) >= Z.value(inst, opt.set) - 1e-9 * Math.max(1, opt.value));
  assert.ok(opt.set.every(id => full.includes(id)));
  return `pool ${t.pool}, screened ${t.screen.length}, refined ${t.sets.length}; optimum ${opt.set.length} -> completed ${full.length} placements`;
});

check('a deterministic stage (铁腕迷思, no random spawn groups): section 10 says so; the run is legal and reproducible', () => {
  const r = D.run({ stage: '铁腕迷思', sims: 120, K: 2, quiet: true });
  assert.ok(r.text.includes('deterministic stage'));
  assert.strictEqual(r.mc.deterministic, true);
  assert.strictEqual(r.small.equal, true);
  assert.strictEqual(r.reproduces, true);
  assert.ok(util.isDeepStrictEqual(sim.simulate(r.stage, r.plan, r.simOpts), r.result));
  return `${r.stage.name}: ${r.enemies.length} enemies, life lost ${r.result.lifeLost}, ${r.timeline.sims} sims, ${(r.timings.totalMs / 1000).toFixed(1)} s`;
});

for (const p of [htmlPath, jsonPath]) { try { fs.unlinkSync(p); } catch (e) { /* already gone */ } }
console.log(`\n${passed} checks passed${failed ? ', ' + failed + ' FAILED' : ''}`);
if (failed) process.exit(1);
