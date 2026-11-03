// Batch experiments behind the site. Writes site/js/results.js.
// Usage: node research/scripts/experiments.js [scale]   (scale 1 = full run, 0.2 = quick check)
'use strict';
const fs = require('fs');
const path = require('path');
const BF = require('../../site/js/engine.js');
const D = BF.D;

const SCALE = Number(process.argv[2] || 1);
const N = k => Math.max(4, Math.round(k * SCALE));
const OUT = path.resolve(__dirname, '..', '..', 'site', 'js', 'results.js');
const t0 = Date.now();
const lap = label => console.log(label.padEnd(28), ((Date.now() - t0) / 1000).toFixed(1) + 's');
const round = (x, d = 2) => (Number.isFinite(x) ? +x.toFixed(d) : null);
const summary = a => ({ mean: round(BF.mean(a)), p10: round(BF.quantile(a, 0.1)), p50: round(BF.quantile(a, 0.5)), p90: round(BF.quantile(a, 0.9)) });
const baseAP = f => D.floors[f - 1].ap;
const PRICES = BF.fitPrices();
const P0 = BF.DEFAULT_PARAMS;

function world(r, f, opts) {
  const m = BF.pick(r, BF.mapsOnFloor(f));
  const P = BF.populate(m, r, opts || {});
  return { m, P, val: BF.valuesFor(P) };
}
function solveStats(w, ap, extra) {
  const res = BF.solve(Object.assign({ m: w.m, P: w.P, val: w.val, ap }, extra || {}));
  let nodes = 0;
  const seen = new Set([w.m.start]);
  for (const s of res.path) if (!seen.has(s.node)) { seen.add(s.node); nodes += w.val[s.node]; }
  const last = res.path[res.path.length - 1];
  const outcome = last.how === 'pursuit' ? 'pursuit' : w.P.types[last.node];
  return { value: res.value, nodes, outcome, steps: res.path.length - 1, path: res.path };
}

const results = { meta: { generated: new Date().toISOString().slice(0, 10), scale: SCALE, params: P0, values: BF.DEFAULT_VALUES, mix: BF.DEFAULT_MIX } };

// E1 geometry of the 43 templates
results.geometry = BF.MAPS.map(BF.geometry);
results.prices = { price: Object.fromEntries(Object.entries(PRICES.price).map(([k, v]) => [k, round(v)])), report: PRICES.report.map(m => ({ ...m, value: round(m.value), options: m.options.map(o => ({ ...o, value: round(o.value), gap: round(o.gap) })) })) };
lap('geometry + prices');

// E2 value of AP by floor (full information and fog), paired samples
const apCurves = {};
const actionLogs = {};
for (let f = 1; f <= 5; f++) {
  const r = BF.rng(1000 + f);
  const budgets = [];
  for (let b = baseAP(f) - 2; b <= baseAP(f) + 5; b++) budgets.push(b);
  const S = N(400), SF = N(120);
  const full = budgets.map(() => []), fog = budgets.map(() => []), nodeV = budgets.map(() => []);
  const outcomes = budgets.map(() => ({}));
  const logs = [];
  for (let s = 0; s < S; s++) {
    const w = world(r, f);
    budgets.forEach((b, i) => {
      const st = solveStats(w, b);
      full[i].push(st.value); nodeV[i].push(st.nodes);
      outcomes[i][st.outcome] = (outcomes[i][st.outcome] || 0) + 1;
      if (s < SF) {
        const z = BF.playZone(w.m, w.P, { ap: b, knowsTemplate: true, rand: r });
        fog[i].push(z.value);
        if (b === baseAP(f)) logs.push(z.log);
      }
    });
  }
  apCurves[f] = budgets.map((b, i) => ({
    ap: b,
    full: round(BF.mean(full[i])), fog: round(BF.mean(fog[i])), nodes: round(BF.mean(nodeV[i])),
    fullBand: summary(full[i]),
    marginalFull: i + 1 < budgets.length ? round(BF.mean(full[i + 1].map((v, k) => v - full[i][k]))) : null,
    marginalFog: i + 1 < budgets.length ? round(BF.mean(fog[i + 1].map((v, k) => v - fog[i][k]))) : null,
    outcomes: Object.fromEntries(Object.entries(outcomes[i]).map(([k, v]) => [k, round(v / S, 3)])),
  }));
  const keys = ['moves', 'battles', 'noncombat', 'reveals', 'revealEvents', 'merchants', 'lights', 'partMoves', 'nodeValue', 'exitPay'];
  actionLogs[f] = Object.fromEntries(keys.map(k => [k, round(BF.mean(logs.map(l => l[k])))]));
  lap('ap curves floor ' + f);
}
results.apCurves = apCurves;
results.actionLogs = actionLogs;

// E3 value of information at base AP
results.voi = {};
for (let f = 1; f <= 5; f++) {
  const r = BF.rng(2000 + f);
  const S = N(150);
  const rows = { full: [], fogTemplate: [], fogNoTemplate3: [], fogTemplate3: [], pursuitNoTemplate3: 0, pursuitTemplate3: 0 };
  for (let s = 0; s < S; s++) {
    const w = world(r, f);
    rows.full.push(BF.solve({ m: w.m, P: w.P, val: w.val, ap: baseAP(f) }).value);
    rows.fogTemplate.push(BF.playZone(w.m, w.P, { ap: baseAP(f), knowsTemplate: true, rand: r }).value);
    const a = BF.playZone(w.m, w.P, { ap: baseAP(f), knowsTemplate: true, rand: r, params: { secrecy: 3 } });
    const b = BF.playZone(w.m, w.P, { ap: baseAP(f), knowsTemplate: false, rand: r, params: { secrecy: 3 } });
    rows.fogTemplate3.push(a.value); rows.fogNoTemplate3.push(b.value);
    if (a.outcome === 'pursuit' && w.m.exitType !== 'boss') rows.pursuitTemplate3++;
    if (b.outcome === 'pursuit' && w.m.exitType !== 'boss') rows.pursuitNoTemplate3++;
  }
  results.voi[f] = {
    full: round(BF.mean(rows.full)), fog: round(BF.mean(rows.fogTemplate)),
    voi: round(BF.mean(rows.full) - BF.mean(rows.fogTemplate)),
    templateValue3: round(BF.mean(rows.fogTemplate3) - BF.mean(rows.fogNoTemplate3)),
    pursuitRateNoTemplate3: round(rows.pursuitNoTemplate3 / S, 3), pursuitRateTemplate3: round(rows.pursuitTemplate3 / S, 3),
  };
  lap('voi floor ' + f);
}

// E4 movement parts: extra value when used on one floor (full information)
results.parts = {};
const partList = D.processing.filter(p => p.key !== 'express');
for (const f of [2, 3, 4, 5]) {
  const r = BF.rng(3000 + f);
  const S = N(40);
  const worlds = Array.from({ length: S }, () => world(r, f));
  const base = worlds.map(w => BF.solve({ m: w.m, P: w.P, val: w.val, ap: baseAP(f) }).value);
  results.parts[f] = partList.map(part => {
    const gains = worlds.map((w, k) => BF.solve({ m: w.m, P: w.P, val: w.val, ap: baseAP(f), parts: [{ part, uses: part.uses }] }).value - base[k]);
    return { key: part.key, name: part.name, en: part.en, buy: part.buy, uses: part.uses, ap: part.ap, range: part.range, gain: round(BF.mean(gains)), p10: round(BF.quantile(gains, 0.1)), p90: round(BF.quantile(gains, 0.9)) };
  });
  lap('parts floor ' + f);
}

// E5 boss floors: walk to the boss or let the pursuit bring it
results.boss = {};
for (const f of [3, 5]) {
  const r = BF.rng(4000 + f);
  const S = N(200);
  const worlds = Array.from({ length: S }, () => world(r, f));
  const pens = [0, -3, -6, -12, -24, -48];
  results.boss[f] = {
    reachable: round(BF.mapsOnFloor(f).filter(m => Math.min(...m.exits.map(e => m.dist[e])) <= baseAP(f)).length / BF.mapsOnFloor(f).length, 3),
    byPenalty: pens.map(pen => {
      let pursuit = 0; const vals = [];
      for (const w of worlds) {
        const st = solveStats(w, baseAP(f), { params: { bossPursuitIE: pen } });
        if (st.outcome === 'pursuit') pursuit++;
        vals.push(st.value);
      }
      return { penalty: pen, pursuitShare: round(pursuit / S, 3), value: round(BF.mean(vals)) };
    }),
  };
  lap('boss floor ' + f);
}

// E6 hidden exit: how often optimal play takes 险路小径 when the next floor values carried AP at λ
results.evac = {};
for (const f of [1, 2, 4]) {
  const next = apCurves[f + 1];
  const lam = next.find(x => x.ap === baseAP(f + 1)).marginalFog;
  const r = BF.rng(5000 + f);
  const S = N(300);
  let present = 0, taken = 0, takenCash = 0;
  for (let s = 0; s < S; s++) {
    const w = world(r, f, { pEvac: 1 });
    present++;
    const a = solveStats(w, baseAP(f), { params: { carryIE: lam } });
    const b = solveStats(w, baseAP(f), { params: { carryIE: P0.hopeIE } });
    if (a.outcome === 'evac') taken++;
    if (b.outcome === 'evac') takenCash++;
  }
  results.evac[f] = { lambdaNext: lam, takenAtLambda: round(taken / present, 3), takenAtCash: round(takenCash / present, 3) };
}
lap('hidden exit');

// E7 ending 2 with one sandbox: search the three 命运所指 by walking or pay 50 ingots
{
  const r = BF.rng(6000);
  const S = N(3000);
  const acc = { both: [], pay: [], walk: [], payFail: 0, walkFail: 0, bothFail: 0 };
  const maps = BF.mapsOnFloor(5);
  for (let s = 0; s < S; s++) {
    const m = BF.pick(r, maps);
    const cand = [];
    const pool = [];
    for (let i = 0; i < m.n; i++) if (i !== m.start && !m.exits.includes(i) && m.dist[i] >= 2) pool.push(i);
    while (cand.length < 3) { const x = BF.pick(r, pool); if (!cand.includes(x)) cand.push(x); }
    const truth = cand[Math.floor(r() * 3)];
    const d = cand.map(c => BF.bfs(m.adj, c));
    const ds = c => m.dist[c];
    const order = [...cand].sort((a, b) => ds(a) - ds(b));
    const c1 = order[0];
    const both = ds(truth);
    let pay = ds(c1), walk = ds(c1);
    if (c1 !== truth) {
      pay += d[cand.indexOf(c1)][truth];
      const rest = order.slice(1).sort((a, b) => d[cand.indexOf(c1)][a] - d[cand.indexOf(c1)][b]);
      walk += d[cand.indexOf(c1)][rest[0]];
      if (rest[0] !== truth) walk += d[cand.indexOf(rest[0])][truth];
    }
    acc.both.push(both); acc.pay.push(pay); acc.walk.push(walk);
    if (both > 8) acc.bothFail++; if (pay > 8) acc.payFail++; if (walk > 8) acc.walkFail++;
  }
  results.ending2 = {
    apBoth: summary(acc.both), apPay: summary(acc.pay), apWalk: summary(acc.walk),
    walkExtraVsPay: round(BF.mean(acc.walk) - BF.mean(acc.pay)),
    overBudget: { both: round(acc.bothFail / S, 3), pay: round(acc.payFail / S, 3), walk: round(acc.walkFail / S, 3) },
    expectedPayment: round(50 * 2 / 3, 2),
  };
}
lap('ending 2');

// E8 natural items: growth per zone at the simulated action profile, and trading Monte Carlo
{
  const acts = [1, 2, 3, 4, 5].map(f => {
    const a = actionLogs[f];
    return { moves: a.moves, battles: a.battles, perfect: a.battles * 0.9, perfectRate: 0.9, noncombat: a.noncombat, reveals: a.revealEvents, revealNodes: a.reveals, merchants: a.merchants, recruits: 1.5, parts: 1.5 };
  });
  results.naturalTable = D.naturals.map(n => {
    const per = acts.map(a => BF.naturalGrowth(n, a));
    const perNode = acts.map(a => BF.naturalGrowth(n, Object.assign({}, a, { reveals: a.revealNodes })));
    const zones = per.map(p => round(p.delta - p.cost, 1));
    return { key: n.key, name: n.name, en: n.en, base: n.base, buy: n.buy, grow: n.grow, perZone: zones, perZoneNodeReading: perNode.map(p => round(p.delta - p.cost, 1)), fromZone2: round(n.base + zones.slice(1).reduce((s, x) => s + x, 0) - (n.buy || 0), 1) };
  });
  const configs = [
    { id: 'box8', label: 'Box 8 (保密等级 7+)', capacity: 8 },
    { id: 'box8full', label: 'Box 8, 6 slots held by parts', capacity: 8, reserved: 6 },
    { id: 'box10full', label: 'Box 10, 6 slots held by parts', capacity: 10, reserved: 6 },
    { id: 'box12full', label: 'Box 12 + bonus, 6 slots held', capacity: 12, reserved: 6, tradeBonus: true },
    { id: 'box10', label: 'Box 10 (default)', capacity: 10 },
    { id: 'box12', label: 'Box 12 (多边贸易)', capacity: 12, tradeBonus: true },
    { id: 'box14', label: 'Box 14 (多边贸易 + 鳍)', capacity: 14, tradeBonus: true },
    { id: 'box10rich', label: 'Box 10 + 20 ingots (后勤)', capacity: 10, startIngots: 32 },
  ];
  const visitPlans = { one: [0, 1, 1, 1, 1], sparse: [0, 1, 0, 1, 1], hunt: [0, 1, 1, 2, 1] };
  results.trading = [];
  for (const cfg of configs) for (const [plan, visits] of Object.entries(visitPlans)) {
    const r = BF.rng(7000);
    const S = N(3000);
    const profits = [], strand = [];
    for (let s = 0; s < S; s++) {
      const out = BF.tradeRun(r, Object.assign({ acts, visitsPerZone: visits }, cfg));
      profits.push(out.profit); strand.push(out.stranded);
    }
    results.trading.push({ id: cfg.id, label: cfg.label, plan, visits, profit: summary(profits), stranded: round(BF.mean(strand)) });
  }
  results.tradeActs = acts;
}
lap('natural items');

// E9 a chained run: floors I to V under fog with parts carried between zones
{
  const S = N(160);
  const variants = [
    { id: 'base', label: 'No bonus' },
    { id: 'pegasus', label: '襁褓天马 (+1 AP per zone)', apBonus: 1 },
    { id: 'griffin', label: '襁褓骏鹰 (Ⅰ–Ⅱ fully revealed)', reveal12: true, hope: 1 },
    { id: 'pioneer', label: '开拓者分队 (+1 part per zone)', partPerZone: true },
    { id: 'evacSeeker', label: 'Value carried AP at next floor’s λ', carryLambda: true },
  ];
  const offer = D.shopLayouts[0].offer_rates;
  const procPool = D.processing.filter(p => offer[p.name]).map(p => [p, offer[p.name]]);
  results.chain = [];
  for (const v of variants) {
    const r = BF.rng(8000);
    const totals = [], perFloor = [1, 2, 3, 4, 5].map(() => []), pursuits = [0, 0, 0, 0, 0], evacs = [0, 0, 0, 0, 0];
    for (let s = 0; s < S; s++) {
      let carry = 0, inv = [], total = (v.hope || 0) * P0.hopeIE;
      for (let f = 1; f <= 5; f++) {
        if (v.partPerZone) inv.push({ part: BF.weightedPick(r, procPool), uses: 0 });
        inv.forEach(p => { if (!p.uses) p.uses = p.part.uses; });
        const w = world(r, f);
        const lam = f < 5 ? apCurves[f + 1].find(x => x.ap === baseAP(f + 1)).marginalFog : P0.hopeIE;
        const use = inv.slice(0, 2);
        const z = BF.playZone(w.m, w.P, { ap: baseAP(f) + carry + (v.apBonus || 0), knowsTemplate: true, fullInfo: v.reveal12 && f <= 2, parts: use, rand: r, params: { carryIE: v.carryLambda ? lam : P0.hopeIE } });
        total += z.value; perFloor[f - 1].push(z.value);
        if (z.outcome === 'pursuit') pursuits[f - 1]++;
        carry = z.outcome === 'evac' ? z.apLeft : 0;
        if (z.outcome === 'evac') evacs[f - 1]++;
        inv = z.partsLeft.concat(inv.slice(2)).filter(p => !p.part.floorOnly);
        if (z.outcome === 'final') inv.push({ part: BF.weightedPick(r, procPool), uses: 0 });
      }
      totals.push(total);
    }
    results.chain.push({ id: v.id, label: v.label, total: summary(totals), perFloor: perFloor.map(a => round(BF.mean(a))), pursuitRate: pursuits.map(x => round(x / S, 3)), evacRate: evacs.map(x => round(x / S, 3)) });
    lap('chain ' + v.id);
  }
}

// E10 sensitivity: does the AP verdict survive other content mixes and node values?
{
  const scenarios = [
    { id: 'default', label: 'Default mix and values' },
    { id: 'battleHeavy', label: 'Battle-heavy maps', mix: Object.assign({}, BF.DEFAULT_MIX, { battle: 45, elite: 12, incident: 10 }) },
    { id: 'eventHeavy', label: 'Event-heavy maps', mix: Object.assign({}, BF.DEFAULT_MIX, { battle: 18, incident: 28, wish: 8 }) },
    { id: 'lowValues', label: 'Node values ×0.5', valueScale: 0.5 },
    { id: 'highValues', label: 'Node values ×1.5', valueScale: 1.5 },
  ];
  results.sensitivity = scenarios.map(sc => {
    const vals = Object.fromEntries(Object.entries(BF.DEFAULT_VALUES).map(([k, x]) => [k, x * (sc.valueScale || 1)]));
    const row = { id: sc.id, label: sc.label, marginal: {} };
    for (let f = 1; f <= 5; f++) {
      const r = BF.rng(9000 + f);
      const S = N(150);
      const d = [];
      for (let s = 0; s < S; s++) {
        const m = BF.pick(r, BF.mapsOnFloor(f));
        const P = BF.populate(m, r, { mix: sc.mix });
        const val = BF.valuesFor(P, vals);
        const a = BF.solve({ m, P, val, ap: baseAP(f) }).value;
        const b = BF.solve({ m, P, val, ap: baseAP(f) + 1 }).value;
        d.push(b - a);
      }
      row.marginal[f] = round(BF.mean(d));
    }
    return row;
  });
}
lap('sensitivity');

// example worlds for the site's route viewer (one per floor, fixed seed)
results.examples = [1, 2, 3, 4, 5].map(f => {
  const r = BF.rng(42 + f);
  const w = world(r, f);
  const st = solveStats(w, baseAP(f));
  return { floor: f, map: w.m.id, types: w.P.types, pair: Array.from(w.P.pair), path: st.path.map(p => p.node), value: round(st.value) };
});

fs.writeFileSync(OUT, '/* Generated by research/scripts/experiments.js */\n(function (root) { root.BF_RESULTS = ' + JSON.stringify(results) + ";\nif (typeof module !== 'undefined' && module.exports) module.exports = root.BF_RESULTS; })(typeof globalThis !== 'undefined' ? globalThis : this);\n");
lap('wrote ' + path.basename(OUT));
