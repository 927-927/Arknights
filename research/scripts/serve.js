// Local preview of site/, wrapping index.html in the same document skeleton the artifact host adds.
// Usage: node research/scripts/serve.js [port]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const SITE = path.resolve(__dirname, '..', '..', 'site');
const PORT = Number(process.argv[2] || 8642);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const wrap = require('./wrap.js');

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.resolve(SITE, rel);
  if (!file.startsWith(SITE)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(rel === 'index.html' ? wrap(buf.toString('utf8')) : buf);
  });
}).listen(PORT, () => console.log('serving site on http://localhost:' + PORT));
