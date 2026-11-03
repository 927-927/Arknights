// Writes dist/: a self-contained static copy of the site (full HTML document, opens from disk).
// Usage: node research/scripts/build_dist.js
'use strict';
const fs = require('fs');
const path = require('path');
const wrap = require('./wrap.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SITE = path.join(ROOT, 'site');
const DIST = path.join(ROOT, 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'js'), { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), wrap(fs.readFileSync(path.join(SITE, 'index.html'), 'utf8')));
for (const f of fs.readdirSync(path.join(SITE, 'js'))) fs.copyFileSync(path.join(SITE, 'js', f), path.join(DIST, 'js', f));
console.log('wrote', DIST);
