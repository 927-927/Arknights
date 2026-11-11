// Builds research/derived/nodes.json from lubiao's recorded maps:
// per floor, the share of each node type and P(type | walking distance), split into 凶戾 / 诡秘 icons.
// Usage: node research/scripts/build_nodes.js
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'research', 'sources', 'lubiao');
const nd = JSON.parse(fs.readFileSync(path.join(SRC, 'node-distance-frequencies-rogue_6.json'), 'utf8'));
const floorsDef = JSON.parse(fs.readFileSync(path.join(SRC, 'foundation-floors-rogue_6.json'), 'utf8'));

// lubiao node names -> engine types
const TYPE = { '作战': 'battle', '紧急作战': 'elite', '险路恶敌': 'boss', '诡意行商': 'shop', '安全的角落': 'rest', '不期而遇': 'incident', '得偿所愿': 'wish', '失与得': 'sacrifice', '先行一步': 'expedition', '狭路相逢': 'duel', '应急助力': 'employ', '命运所指': 'fate', '秘境行商': 'scrap', '险路尽头': 'final', '险路小径': 'evac', '羽瞰点': 'light', '曲折密道': 'door', '误入奇境': 'portal', '居民据点': 'savage', '流窜的“居民”': 'roamer', '林间空地': 'empty' };
const HOSTILE = new Set(['battle', 'elite', 'boss', 'duel', 'savage', 'roamer']);

const floors = nd.floors.map(f => {
  const byType = {}, byDist = {};
  let total = 0;
  for (const row of f.rows) {
    const t = TYPE[row.name] || row.name;
    let n = 0;
    for (const [d, c] of Object.entries(row.counts)) {
      n += c;
      (byDist[d] = byDist[d] || {})[t] = ((byDist[d] || {})[t] || 0) + c;
    }
    if (n) byType[t] = n;
    total += n;
  }
  const perMap = Object.fromEntries(Object.entries(byType).map(([t, n]) => [t, +(n / f.mapSampleCount).toFixed(3)]));
  const distances = Object.keys(byDist).map(Number).sort((a, b) => a - b).map(d => {
    const row = byDist[d];
    const n = Object.values(row).reduce((s, x) => s + x, 0);
    const hostile = Object.entries(row).filter(([t]) => HOSTILE.has(t)).reduce((s, [, x]) => s + x, 0);
    const share = Object.fromEntries(Object.entries(row).sort((a, b) => b[1] - a[1]).map(([t, x]) => [t, +(x / n).toFixed(4)]));
    const ifMystery = {}, ifHostile = {};
    for (const [t, x] of Object.entries(row)) {
      if (HOSTILE.has(t)) ifHostile[t] = +(x / Math.max(1, hostile)).toFixed(4);
      else ifMystery[t] = +(x / Math.max(1, n - hostile)).toFixed(4);
    }
    return { distance: d, samples: n, perMap: +(n / f.mapSampleCount).toFixed(2), share, ifHostile, ifMystery };
  });
  return { floor: f.label, maps: f.mapSampleCount, nodes: total, perMap, distances };
});

const stageLists = floorsDef.floors.map(f => ({ floor: f.floor, zone: f.zoneName, normal: f.normalStageIds, elite: f.eliteStageIds }));
const out = { generated: new Date().toISOString().slice(0, 10), source: 'lubiao.wiki node-distance-frequencies-rogue_6.json (' + nd.mapSampleCount + ' maps, ' + nd.sampleCount + ' nodes)', floors, stageLists, treehole: floorsDef.specialLayers };
fs.mkdirSync(path.join(ROOT, 'research', 'derived'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'research', 'derived', 'nodes.json'), JSON.stringify(out, null, 1));
for (const f of floors) {
  console.log(`Floor ${f.floor}: ${f.maps} maps, nodes per map by type:`, JSON.stringify(f.perMap));
  for (const d of f.distances) console.log(`   d${d} (${d.perMap}/map) hostile→${JSON.stringify(d.ifHostile)} mystery→${JSON.stringify(Object.fromEntries(Object.entries(d.ifMystery).slice(0, 6)))}`);
}
