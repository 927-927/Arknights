const BF = require('../../site/js/engine.js');
const r = BF.rng(7);
for (const f of [1,2,3,4,5]) {
  const maps = BF.mapsOnFloor(f);
  let t0 = Date.now(), states = 0, vals = [];
  for (let s = 0; s < 20; s++) {
    const m = BF.pick(r, maps);
    const P = BF.populate(m, r, {});
    const val = BF.valuesFor(P);
    const res = BF.solve({ m, P, val, ap: BF.D.floors[f-1].ap });
    states += res.states; vals.push(res.value);
  }
  console.log('floor', f, 'mean V*', BF.mean(vals).toFixed(1), 'avg states', (states/20).toFixed(0), 'ms/solve', ((Date.now()-t0)/20).toFixed(1));
}
// with a jetpack and with structural principle on floor 5
const jet = BF.D.processing.find(p => p.key==='jetpack'), pr = BF.D.processing.find(p => p.key==='principle');
for (const part of [jet, pr]) {
  let t0 = Date.now(), st=0;
  for (let s = 0; s < 5; s++) {
    const m = BF.pick(r, BF.mapsOnFloor(5)); const P = BF.populate(m, r, {});
    const res = BF.solve({ m, P, val: BF.valuesFor(P), ap: 8, parts: [{ part, uses: part.uses }] }); st += res.states;
  }
  console.log(part.key, 'avg states', st/5, 'ms', (Date.now()-t0)/5);
}
// fog play
let t0 = Date.now();
for (const f of [2,5]) { const m = BF.pick(r, BF.mapsOnFloor(f)); const P = BF.populate(m, r, {});
  const z = BF.playZone(m, P, { ap: BF.D.floors[f-1].ap });
  const full = BF.solve({ m, P, val: BF.valuesFor(P), ap: BF.D.floors[f-1].ap });
  console.log('fog floor', f, z.value.toFixed(1), z.outcome, 'full', full.value.toFixed(1), JSON.stringify(z.log).slice(0,200)); }
console.log('fog ms', Date.now()-t0);
console.log(JSON.stringify(BF.fitPrices().price, (k,v)=> typeof v==='number'? +v.toFixed(2): v));
