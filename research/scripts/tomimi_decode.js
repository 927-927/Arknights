// Decodes SvelteKit/devalue __data.json files from tomimi.dev.
'use strict';
const fs = require('fs');
function unflatten(values) {
  const hydrated = new Array(values.length);
  const done = new Array(values.length).fill(false);
  function hydrate(i) {
    if (i === -1) return undefined;
    if (i === -3) return NaN;
    if (i === -4) return Infinity;
    if (i === -5) return -Infinity;
    if (i === -6) return -0;
    if (done[i]) return hydrated[i];
    const v = values[i];
    if (v === null || typeof v !== 'object') { done[i] = true; return (hydrated[i] = v); }
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string' && ['Date', 'Set', 'Map', 'RegExp', 'Object', 'BigInt', 'null'].includes(v[0])) {
        done[i] = true;
        if (v[0] === 'Date') return (hydrated[i] = v[1]);
        if (v[0] === 'Set') { const s = []; hydrated[i] = s; for (let k = 1; k < v.length; k++) s.push(hydrate(v[k])); return s; }
        if (v[0] === 'Map') { const m = {}; hydrated[i] = m; for (let k = 1; k < v.length; k += 2) m[hydrate(v[k])] = hydrate(v[k + 1]); return m; }
        return (hydrated[i] = v[1]);
      }
      const arr = []; hydrated[i] = arr; done[i] = true;
      for (const x of v) arr.push(hydrate(x));
      return arr;
    }
    const obj = {}; hydrated[i] = obj; done[i] = true;
    for (const [k, x] of Object.entries(v)) obj[k] = hydrate(x);
    return obj;
  }
  return hydrate(0);
}
function decodeFile(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const node = j.nodes.filter(Boolean).find(n => n.type === 'data' && Array.isArray(n.data) && n.data.length > 10) || j.nodes.filter(Boolean).pop();
  return unflatten(node.data);
}
module.exports = { unflatten, decodeFile };
if (require.main === module) {
  const d = decodeFile(process.argv[2]);
  const pick = process.argv[3];
  const out = pick ? pick.split('.').reduce((o, k) => (o ? o[k] : o), d) : d;
  console.log(JSON.stringify(out, null, 0).slice(0, Number(process.argv[4] || 4000)));
}
