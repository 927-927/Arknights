/* Black Flow Ledger: page logic, charts and labs. */
(function () {
  'use strict';
  const BF = window.BF, D = window.BF_DATA, R = window.BF_RESULTS;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f1 = x => (x == null || !isFinite(x) ? '–' : (Math.round(x * 10) / 10).toFixed(1));
  const f0 = x => (x == null || !isFinite(x) ? '–' : String(Math.round(x)));
  const pct = x => (x == null ? '–' : Math.round(x * 100) + '%');
  const ROMAN = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ'];
  const SER = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];
  const baseAP = f => D.floors[f - 1].ap;
  const hopeIE = R.meta.params.hopeIE;
  const renderers = [];
  const onRender = fn => { renderers.push(fn); fn(); };

  // ---------- language ----------
  const isZh = () => document.documentElement.getAttribute('data-lang') === 'zh';
  const T = (en, zh) => (isZh() ? zh : en);
  const floorName = f => T('Floor ' + ROMAN[f], '第' + ROMAN[f] + '层');
  const typeName = t => T(BF.TYPE_INFO[t][1], BF.TYPE_INFO[t][0]);
  function setLang(lang) {
    document.documentElement.setAttribute('data-lang', lang);
    document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    try { localStorage.setItem('bfl-lang', lang); } catch (e) { /* storage blocked */ }
    document.querySelectorAll('[data-setlang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.setlang === lang)));
    fillKeys();
    renderers.forEach(fn => fn());
  }
  document.querySelectorAll('[data-setlang]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.setlang === (isZh() ? 'zh' : 'en')));
    b.addEventListener('click', () => setLang(b.dataset.setlang));
  });

  // ---------- key figures ----------
  const K = {};
  const lamAt = f => R.apCurves[f].find(x => x.ap === baseAP(f)).marginalFog;
  const chain = id => R.chain.find(c => c.id === id).total.mean;
  const trade = (id, plan) => R.trading.find(t => t.id === id && t.plan === plan);
  function fillKeys() {
    const lams = [1, 2, 3, 4, 5].map(lamAt);
    const mid = [2, 3, 4, 5].map(lamAt);
    K.lamHopeMid = f1(BF.mean(mid) / hopeIE);
    K.lamHopeRange = f1(Math.min(...lams) / hopeIE) + '–' + f1(Math.max(...lams) / hopeIE);
    K.lamIE = f0(BF.mean(mid));
    K.hopeIE = hopeIE.toFixed(2);
    const g = R.geometry;
    const f1maps = g.filter(x => x.floor === 1);
    K.floor1Rail = f1maps.filter(x => x.exitDist.every(d => d === baseAP(1))).length + ' / ' + f1maps.length;
    const out = f => g.filter(x => x.floor === f && x.nearestExit > baseAP(f)).length;
    K.bossOut3 = out(3); K.bossOut5b = out(5);
    K.bossOut5 = out(5) + ' / ' + g.filter(x => x.floor === 5).length;
    const bp = R.boss[3].byPenalty;
    let cross = null;
    for (let i = 1; i < bp.length; i++) if (bp[i - 1].pursuitShare >= 0.5 && bp[i].pursuitShare < 0.5) {
      const a = bp[i - 1], b = bp[i];
      cross = -(a.penalty + (b.penalty - a.penalty) * (a.pursuitShare - 0.5) / (a.pursuitShare - b.pursuitShare));
    }
    K.bossBreak = cross == null ? '24' : f0(cross);
    const base = chain('base');
    const peg = chain('pegasus') - base, gri = chain('griffin') - base;
    K.pegasusGain = f0(peg);
    K.pegasusGainHope = f0(peg / hopeIE);
    K.griffinGainHope = f0(gri / hopeIE);
    K.jinwuHope = f0(3 * R.prices.price.colRandom / hopeIE);
    const cheap = ['wheel', 'prosthetic'].flatMap(k => [2, 3, 4, 5].map(f => R.parts[f].find(p => p.key === k).gain / 2));
    K.cheapReturn = f0(Math.min(...cheap)) + '–' + f0(Math.max(...cheap)) + '×';
    K.pegasusVsGriffin = gri > 0 ? f0(peg / gri) + '×' : T('several times', '数倍');
    K.carryGain = f0(chain('evacSeeker') - base);
    K.huntGain = f0(trade('box10', 'hunt').profit.mean - trade('box10', 'one').profit.mean);
    const vois = [1, 2, 3, 4, 5].map(f => R.voi[f].voi);
    K.voiRange = f0(Math.min(...vois)) + '–' + f0(Math.max(...vois));
    K.pursuitNoTpl = pct(Math.max(R.voi[2].pursuitRateNoTemplate3, R.voi[4].pursuitRateNoTemplate3));
    K.e2Extra = f1(R.ending2.walkExtraVsPay);
    K.priceAP = f1(R.prices.price.ap);
    K.priceAPHope = f1(R.prices.price.ap / R.prices.price.hope);
    K.genDate = R.meta.generated;
    K.scale = String(R.meta.scale);
    document.querySelectorAll('[data-k]').forEach(el => { const k = el.getAttribute('data-k'); if (K[k] != null) el.textContent = K[k]; });
  }
  fillKeys();

  // ---------- chart helpers ----------
  function niceTicks(lo, hi, n) {
    const span = hi - lo || 1;
    const step0 = span / Math.max(1, n);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= step0) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function tipFor(host) {
    let t = host.querySelector('.tip');
    if (!t) { t = document.createElement('div'); t.className = 'tip'; t.hidden = true; host.appendChild(t); }
    return t;
  }
  function showTip(host, x, y, html) {
    const t = tipFor(host);
    t.innerHTML = html; t.hidden = false;
    const w = host.clientWidth;
    t.style.left = Math.min(Math.max(x, 80), w - 80) + 'px';
    t.style.top = y + 'px';
  }
  const hideTip = host => { const t = host.querySelector('.tip'); if (t) t.hidden = true; };
  function legend(host, series, dot) {
    const div = document.createElement('div');
    div.className = 'legend';
    div.innerHTML = series.map(s => `<span><i class="${dot ? 'dot' : ''}" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
    host.appendChild(div);
  }
  function tableHTML(headers, rows) {
    return `<table><thead><tr>${headers.map(h => `<th class="${h.n ? 'n' : ''}">${h.html || esc(h.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr class="${r.hl ? 'hl' : ''}">${r.cells.map((c, i) => `<td class="${headers[i].n ? 'n' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  function tableView(afterEl, headers, rows, summary) {
    let d = afterEl.nextElementSibling;
    if (!d || !d.dataset || !d.dataset.auto) {
      d = document.createElement('details');
      d.className = 'table-view'; d.dataset.auto = '1';
      afterEl.insertAdjacentElement('afterend', d);
    }
    const open = d.open;
    d.innerHTML = `<summary>${esc(summary || T('Show as table', '以表格查看'))}</summary><div class="tscroll">${tableHTML(headers, rows)}</div>`;
    d.open = open;
  }

  // Horizontal bars. rows: [{label, sub, vals:[{v, lo, hi, text}]}], series: [{name, color}]
  function hbar(host, cfg) {
    const W = Math.max(300, host.clientWidth || 600);
    const ns = cfg.series.length;
    const barH = Math.min(14, cfg.barH || (ns > 2 ? 9 : 12)), gap = 3;
    const labelW = Math.min(cfg.labelW || 190, Math.round(W * 0.42));
    const valW = cfg.valW || 64;
    const rowH = ns * barH + (ns - 1) * gap + 16;
    const top = 8, axisH = 28;
    const H = top + cfg.rows.length * rowH + axisH;
    let lo = Math.min(0, ...cfg.rows.flatMap(r => r.vals.filter(v => v.v != null).map(v => (v.lo ?? v.v))));
    let hi = Math.max(...cfg.rows.flatMap(r => r.vals.filter(v => v.v != null).map(v => (v.hi ?? v.v))), cfg.ref ? cfg.ref.v : 0);
    if (cfg.max != null) hi = cfg.max;
    const ticks = niceTicks(lo, hi, Math.max(3, Math.floor((W - labelW - valW) / 90)));
    hi = Math.max(hi, ticks[ticks.length - 1]); lo = Math.min(lo, ticks[0]);
    const x = v => labelW + (v - lo) / (hi - lo) * (W - labelW - valW);
    const fmt = cfg.fmt || f1;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.aria || 'bar chart')}">`;
    for (const t of ticks) s += `<line class="gridline" x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${H - axisH}"/><text x="${x(t)}" y="${H - axisH + 16}" text-anchor="middle" class="axis-label">${fmt(t)}</text>`;
    s += `<line class="baseline" x1="${x(0)}" x2="${x(0)}" y1="${top}" y2="${H - axisH}"/>`;
    if (cfg.ref) s += `<line class="ref" x1="${x(cfg.ref.v)}" x2="${x(cfg.ref.v)}" y1="${top}" y2="${H - axisH}"/><text class="ref-label" x="${x(cfg.ref.v) + 4}" y="${top + 10}">${esc(cfg.ref.label)}</text>`;
    cfg.rows.forEach((r, ri) => {
      const y0 = top + ri * rowH + 8;
      s += `<text x="0" y="${y0 + (ns * barH + (ns - 1) * gap) / 2 + 4}" class="${r.strong ? 'val' : ''}">${esc(r.label)}${r.sub ? `<tspan class="axis-label"> ${esc(r.sub)}</tspan>` : ''}</text>`;
      r.vals.forEach((v, si) => {
        if (v.v == null) return;
        const y = y0 + si * (barH + gap);
        const x0 = x(Math.min(0, v.v)), x1 = x(Math.max(0, v.v));
        const w = Math.max(1, x1 - x0);
        const rr = Math.min(4, w / 2, barH / 2);
        const path = v.v >= 0
          ? `M${x0},${y} H${x1 - rr} Q${x1},${y} ${x1},${y + rr} V${y + barH - rr} Q${x1},${y + barH} ${x1 - rr},${y + barH} H${x0} Z`
          : `M${x1},${y} H${x0 + rr} Q${x0},${y} ${x0},${y + rr} V${y + barH - rr} Q${x0},${y + barH} ${x0 + rr},${y + barH} H${x1} Z`;
        s += `<path d="${path}" fill="${cfg.series[si].color}"/>`;
        if (v.lo != null && v.hi != null) {
          const cy = y + barH / 2;
          s += `<line x1="${x(v.lo)}" x2="${x(v.hi)}" y1="${cy}" y2="${cy}" stroke="var(--ink-2)" stroke-width="1.2"/><line x1="${x(v.lo)}" x2="${x(v.lo)}" y1="${cy - 4}" y2="${cy + 4}" stroke="var(--ink-2)" stroke-width="1.2"/><line x1="${x(v.hi)}" x2="${x(v.hi)}" y1="${cy - 4}" y2="${cy + 4}" stroke="var(--ink-2)" stroke-width="1.2"/>`;
        }
        const tx = Math.max(x(v.hi ?? v.v), x1) + 6;
        s += `<text class="val" x="${tx}" y="${y + barH / 2 + 4}">${esc(v.text ?? fmt(v.v))}</text>`;
        s += `<rect x="${labelW}" y="${y - 2}" width="${W - labelW}" height="${barH + 4}" fill="transparent" data-r="${ri}" data-s="${si}" class="hit"/>`;
      });
    });
    if (cfg.axisLabel) s += `<text x="${W - valW}" y="${H - 2}" text-anchor="end" class="axis-label">${esc(cfg.axisLabel)}</text>`;
    s += '</svg>';
    host.innerHTML = s;
    if (ns > 1 || cfg.legend) legend(host, cfg.series);
    host.querySelectorAll('.hit').forEach(el => {
      el.addEventListener('mousemove', e => {
        const r = cfg.rows[+el.dataset.r], si = +el.dataset.s, v = r.vals[si];
        const box = host.getBoundingClientRect();
        showTip(host, e.clientX - box.left, e.clientY - box.top, `<b>${esc(r.label)}</b><br>${esc(cfg.series[si].name)}: ${esc(v.text ?? fmt(v.v))}${v.lo != null ? `<br>${T('10th–90th percentile', '10%–90% 分位')}: ${fmt(v.lo)} – ${fmt(v.hi)}` : ''}`);
      });
      el.addEventListener('mouseleave', () => hideTip(host));
    });
    if (cfg.table !== false) {
      const headers = [{ label: cfg.rowHeader || '' }].concat(cfg.series.map(s => ({ label: s.name, n: true })));
      tableView(host, headers, cfg.rows.map(r => ({ cells: [esc(r.label + (r.sub ? ' ' + r.sub : ''))].concat(r.vals.map(v => v.v == null ? '–' : esc(v.text ?? fmt(v.v)) + (v.lo != null ? ` <span style="color:var(--muted)">(${fmt(v.lo)}–${fmt(v.hi)})</span>` : ''))) })));
    }
  }

  // Line chart with crosshair. series: [{name, color, pts:[[x,y]]}]
  function lineChart(host, cfg) {
    const W = Math.max(180, host.clientWidth || 600);
    const H = cfg.height || 220;
    const L = cfg.left ?? 40, Rr = cfg.right ?? 12, Tp = 14, B = 30;
    const xs = [...new Set(cfg.series.flatMap(s => s.pts.map(p => p[0])))].sort((a, b) => a - b);
    const ys = cfg.series.flatMap(s => s.pts.map(p => p[1])).filter(v => v != null);
    let ylo = cfg.yMin ?? Math.min(0, ...ys), yhi = cfg.yMax ?? Math.max(...ys, cfg.ref ? cfg.ref.y : -Infinity);
    const yt = niceTicks(ylo, yhi, cfg.yTicks || 4);
    ylo = Math.min(ylo, yt[0]); yhi = Math.max(yhi, yt[yt.length - 1]);
    const xlo = cfg.xMin ?? xs[0], xhi = cfg.xMax ?? xs[xs.length - 1];
    const x = v => L + (v - xlo) / ((xhi - xlo) || 1) * (W - L - Rr);
    const y = v => Tp + (1 - (v - ylo) / ((yhi - ylo) || 1)) * (H - Tp - B);
    const xf = cfg.xFmt || (v => v), yf = cfg.yFmt || f1;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.aria || 'line chart')}">`;
    for (const t of yt) s += `<line class="gridline" x1="${L}" x2="${W - Rr}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-label" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${yf(t)}</text>`;
    for (const t of (cfg.xTicks || xs)) s += `<text class="axis-label" x="${x(t)}" y="${H - B + 16}" text-anchor="middle">${esc(xf(t))}</text>`;
    s += `<line class="baseline" x1="${L}" x2="${W - Rr}" y1="${H - B}" y2="${H - B}"/>`;
    if (cfg.mark != null) s += `<line x1="${x(cfg.mark)}" x2="${x(cfg.mark)}" y1="${Tp}" y2="${H - B}" stroke="var(--rule-strong)" stroke-width="1"/><text class="axis-label" x="${x(cfg.mark) + 4}" y="${H - B - 6}">${esc(cfg.markLabel || '')}</text>`;
    if (cfg.ref) s += `<line class="ref" x1="${L}" x2="${W - Rr}" y1="${y(cfg.ref.y)}" y2="${y(cfg.ref.y)}"/><text class="ref-label" x="${W - Rr}" y="${y(cfg.ref.y) - 5}" text-anchor="end">${esc(cfg.ref.label)}</text>`;
    cfg.series.forEach(se => {
      const pts = se.pts.filter(p => p[1] != null);
      s += `<polyline fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.map(p => x(p[0]) + ',' + y(p[1])).join(' ')}"/>`;
      const last = pts[pts.length - 1];
      if (last) s += `<circle cx="${x(last[0])}" cy="${y(last[1])}" r="4" fill="${se.color}" stroke="var(--surface)" stroke-width="2"/>`;
    });
    s += `<line class="xhair" x1="0" x2="0" y1="${Tp}" y2="${H - B}" stroke="var(--ink-2)" stroke-width="1" visibility="hidden"/>`;
    s += `<g class="dots"></g><rect class="overlay" x="${L}" y="${Tp}" width="${W - L - Rr}" height="${H - Tp - B}" fill="transparent"/>`;
    if (cfg.xLabel) s += `<text class="axis-label" x="${W - Rr}" y="${H - 2}" text-anchor="end">${esc(cfg.xLabel)}</text>`;
    s += '</svg>';
    host.innerHTML = s;
    if (cfg.series.length > 1 && cfg.legend !== false) legend(host, cfg.series);
    const svg = host.querySelector('svg'), ov = host.querySelector('.overlay'), xh = host.querySelector('.xhair'), dots = host.querySelector('.dots');
    ov.addEventListener('mousemove', e => {
      const box = svg.getBoundingClientRect();
      const px = (e.clientX - box.left) * (W / box.width);
      let best = xs[0];
      for (const v of xs) if (Math.abs(x(v) - px) < Math.abs(x(best) - px)) best = v;
      xh.setAttribute('x1', x(best)); xh.setAttribute('x2', x(best)); xh.setAttribute('visibility', 'visible');
      const rows = cfg.series.map(se => { const p = se.pts.find(q => q[0] === best); return p && p[1] != null ? { se, v: p[1] } : null; }).filter(Boolean);
      dots.innerHTML = rows.map(r => `<circle cx="${x(best)}" cy="${y(r.v)}" r="4" fill="${r.se.color}" stroke="var(--surface)" stroke-width="2"/>`).join('');
      const hostBox = host.getBoundingClientRect();
      showTip(host, x(best) * (box.width / W) + (box.left - hostBox.left), Math.min(...rows.map(r => y(r.v))) * (box.height / H), `<b>${esc((cfg.xName || '') + xf(best))}</b>` + rows.map(r => `<br><span style="color:${r.se.color}">●</span> ${esc(r.se.name)}: ${yf(r.v)}`).join(''));
    });
    ov.addEventListener('mouseleave', () => { xh.setAttribute('visibility', 'hidden'); dots.innerHTML = ''; hideTip(host); });
  }

  // ---------- map drawing ----------
  const GLYPH = { battle: '战', elite: '急', duel: '狭', incident: '遇', wish: '愿', rest: '角', shop: '商', scrap: '秘', employ: '援', sacrifice: '失', expedition: '先', light: '瞰', portal: '奇', door: '道', empty: '', final: '尽', boss: '恶', evac: '径', start: '' };
  const GROUP = t => (BF.COMBAT.has(t) && t !== 'boss') ? 'combat' : ['incident', 'wish', 'rest', 'sacrifice', 'expedition', 'employ'].includes(t) ? 'event' : (t === 'shop' || t === 'scrap') ? 'merchant' : ['light', 'door', 'portal'].includes(t) ? 'move' : ['final', 'boss', 'evac'].includes(t) ? 'exit' : 'plain';
  const GROUP_STYLE = {
    combat: { fill: 'var(--s2)', text: 'var(--on-fill)', en: 'Combat', zh: '作战类' },
    event: { fill: 'var(--s1)', text: 'var(--on-fill)', en: 'Event or service', zh: '事件与服务' },
    merchant: { fill: 'var(--s4)', text: '#0b0b0b', en: 'Merchant', zh: '行商' },
    move: { fill: 'var(--s3)', text: 'var(--on-fill)', en: 'Lookout, tunnel, wonderland', zh: '羽瞰点、密道、奇境' },
    exit: { fill: 'var(--ink)', text: 'var(--surface)', en: 'Exit (尽 / 径 / 恶)', zh: '出口（尽 / 径 / 恶）' },
    plain: { fill: 'var(--surface)', text: 'var(--ink-2)', en: 'Clearing', zh: '林间空地' },
  };
  function mapSVG(m, opt) {
    const o = Object.assign({ cell: 40, types: null, path: null, seen: null, small: false, pair: null }, opt);
    const c = o.cell, pad = c * 0.15;
    const W = m.cols * c + pad * 2, H = m.rows * c + pad * 2;
    const cx = i => pad + m.C[i] * c + c / 2, cy = i => pad + m.R[i] * c + c / 2;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(m.id)}">`;
    for (let i = 0; i < m.n; i++) for (const j of m.adj[i]) if (i < j) s += `<line class="edge" x1="${cx(i)}" y1="${cy(i)}" x2="${cx(j)}" y2="${cy(j)}" style="stroke-width:${o.small ? 2 : 3}"/>`;
    if (o.pair) for (let i = 0; i < m.n; i++) if (o.pair[i] > i) s += `<path d="M${cx(i)},${cy(i)} Q${(cx(i) + cx(o.pair[i])) / 2},${Math.min(cy(i), cy(o.pair[i])) - c * 0.8} ${cx(o.pair[i])},${cy(o.pair[i])}" fill="none" stroke="var(--s3)" stroke-width="1.5" opacity="0.8"/>`;
    const size = o.small ? c * 0.5 : c * 0.66;
    for (let i = 0; i < m.n; i++) {
      const t = o.types ? o.types[i] : (m.exits.includes(i) ? (m.exitType === 'boss' ? 'boss' : 'final') : i === m.start ? 'start' : 'empty');
      const hidden = o.seen && !o.seen[i];
      const st = GROUP_STYLE[GROUP(t)];
      let fill = st.fill, txt = st.text, glyph = GLYPH[t] || '', stroke = GROUP(t) === 'plain' ? 'var(--rule-strong)' : 'var(--surface)';
      if (hidden) { fill = 'var(--surface)'; stroke = 'var(--rule-strong)'; txt = 'var(--muted)'; glyph = BF.COMBAT.has(t) ? '凶' : '诡'; }
      s += `<g class="node" data-i="${i}"><rect x="${cx(i) - size / 2}" y="${cy(i) - size / 2}" width="${size}" height="${size}" rx="${o.small ? 2 : 5}" fill="${fill}" stroke="${stroke}"/>`;
      if (!o.small && glyph) s += `<text x="${cx(i)}" y="${cy(i) + 1}" style="font-size:${Math.round(c * 0.32)}px;fill:${txt}">${glyph}</text>`;
      s += '</g>';
      if (i === m.start) s += `<circle class="start-ring" cx="${cx(i)}" cy="${cy(i)}" r="${size * 0.68}" style="stroke-width:${o.small ? 1.5 : 2.5}"/>`;
    }
    if (o.path && o.path.length > 1) {
      let d = '';
      for (let k = 1; k < o.path.length; k++) {
        const a = o.path[k - 1].node, b = o.path[k].node;
        if (o.path[k].how === 'pursuit' || a === b) continue;
        if (o.path[k].how === 'part') s += `<path class="jump" d="M${cx(a)},${cy(a)} Q${(cx(a) + cx(b)) / 2 + c * 0.3},${(cy(a) + cy(b)) / 2 - c * 0.6} ${cx(b)},${cy(b)}"/>`;
        else if (o.path[k].how === 'door') s += `<path class="jump" style="stroke:var(--s3)" d="M${cx(a)},${cy(a)} L${cx(b)},${cy(b)}"/>`;
        else d += `M${cx(a)},${cy(a)} L${cx(b)},${cy(b)} `;
      }
      s += `<path class="route" d="${d}"/>`;
      const placed = {};
      o.path.forEach((p, k) => {
        if (k === 0 || p.how === 'pursuit') return;
        const n = p.node; const off = (placed[n] = (placed[n] || 0) + 1) - 1;
        const x0 = cx(n) + size * 0.48 - off * 13, y0 = cy(n) - size * 0.48;
        s += `<circle class="stepdot" cx="${x0}" cy="${y0}" r="7.5"/><text class="stepno" x="${x0}" y="${y0 + 0.5}">${k}</text>`;
      });
    }
    s += '</svg>';
    return s;
  }

  // ---------- resource diagram ----------
  onRender(function drawFlow() {
    const host = $('#flow');
    const W = host.clientWidth || 800;
    if (W < 820) {
      const rows = [
        [T('AP', '行动力'), T('Hope', '希望'), T('1 : 1 at 险路尽头 and after the boss', '险路尽头、击败首领后 1 : 1'), true],
        [T('AP', '行动力'), T('Next zone', '下一区域'), T('carried through 险路小径, plus a rarer part', '经险路小径带走，外加较稀有加工品'), true],
        [T('Movement part', '加工品'), T('AP', '行动力'), T('jumps skip unfinished nodes; 简易遥控器 +3 AP', '跳过未完成节点；简易遥控器 +3 行动力'), true],
        [T('Half current life', '一半目标生命'), T('AP', '行动力'), T('+5 AP instead of +2 (沉重的契约)', '+5 行动力而非 +2（沉重的契约）'), true],
        [T('Hope', '希望'), T('Ingots', '源石锭'), T('3 hope or 10 ingots (桑尼的邀请)', '3 希望或 10 源石锭（桑尼的邀请）'), false],
        [T('Hope', '希望'), T('Operators', '干员'), T('6★ recruit 6, promote 3; 5★ recruit 2', '六星招募 6、进阶 3；五星招募 2'), false],
        [T('Ingots', '源石锭'), T('Collectibles', '收藏品'), T('8 / 12 / 16 at 诡意行商; 4 for 1 at 敲动杠杆', '诡意行商 8 / 12 / 16；敲动杠杆 4 换 1'), false],
        [T('Ingots', '源石锭'), T('Movement parts', '加工品'), T('2–16 at 秘境行商', '秘境行商 2–16'), false],
        [T('Ingots', '源石锭'), T('Natural items', '自然物'), T('bought at 2× their estimate', '按估价的 2 倍买入'), false],
        [T('Natural items', '自然物'), T('Ingots', '源石锭'), T('sold at estimate; 3 sold → +8 with 多边贸易', '按估价卖出；多边贸易卖 3 个 +8'), false],
        [T('Ingots', '源石锭'), T('Box slots', '零件箱'), T('6 for +2 (空间租赁)', '6 换 +2 格（空间租赁）'), false],
      ];
      host.innerHTML = tableHTML([{ label: T('From', '从') }, { label: T('To', '到') }, { label: T('Rate', '汇率') }], rows.map(r => ({ hl: r[3], cells: [esc(r[0]), esc(r[1]), esc(r[2])] })));
      return;
    }
    // four columns: AP side, hope/parts/slots, operators/ingots, what ingots buy
    const VW = 1156, VH = 400, bw = 172, bh = 54;
    const B = {
      life: [24, 24, T('Target life', '目标生命'), T('目标生命', 'target life')],
      ap: [24, 183, T('AP', '行动力'), T('行动力', 'AP')],
      next: [24, 342, T('Next zone', '下一区域'), T('下一区域', 'next zone')],
      hope: [330, 24, T('Hope', '希望'), T('希望', 'hope')],
      parts: [330, 183, T('Movement parts', '加工品'), T('加工品', 'movement parts')],
      slot: [330, 342, T('Box slots', '零件箱格'), T('零件箱', 'box slots')],
      ops: [960, 24, T('Operators', '干员'), T('招募 · 进阶', 'recruit · promote')],
      ing: [636, 183, T('Ingots', '源石锭'), T('源石锭', 'ingots')],
      col: [960, 168, T('Collectibles', '收藏品'), T('收藏品', 'collectibles')],
      nat: [960, 312, T('Natural items', '自然物'), T('自然物', 'natural items')],
    };
    const clip = (k, dx, dy) => {
      const [x, y] = B[k]; const cx = x + bw / 2, cy = y + bh / 2;
      const t = Math.min(dx ? (bw / 2 + 2) / Math.abs(dx) : Infinity, dy ? (bh / 2 + 2) / Math.abs(dy) : Infinity);
      return [cx + dx * t, cy + dy * t];
    };
    // bend: perpendicular offset of the curve; off: extra label offset along the same normal
    const edge = (a, b, label, hot, bend, off) => {
      const ca = [B[a][0] + bw / 2, B[a][1] + bh / 2], cb = [B[b][0] + bw / 2, B[b][1] + bh / 2];
      const dx = cb[0] - ca[0], dy = cb[1] - ca[1], len = Math.hypot(dx, dy);
      const [sx, sy] = clip(a, dx / len, dy / len), [ex, ey] = clip(b, -dx / len, -dy / len);
      const nx = -dy / len, ny = dx / len;
      const mx = (sx + ex) / 2, my = (sy + ey) / 2;
      const qx = mx + nx * (bend || 0), qy = my + ny * (bend || 0);
      const lx = mx + nx * ((bend || 0) / 2 + (off ?? -10)), ly = my + ny * ((bend || 0) / 2 + (off ?? -10)) + 4;
      return `<path class="${hot ? 'hot' : ''}" d="M${sx},${sy} Q${qx},${qy} ${ex},${ey}" marker-end="url(#ah${hot ? 'h' : ''})"/>` +
        `<text class="lbl ${hot ? 'hot' : ''}" x="${lx}" y="${ly}" text-anchor="middle" style="paint-order:stroke;stroke:var(--surface);stroke-width:5px;stroke-linejoin:round">${esc(label)}</text>`;
    };
    let s = `<svg viewBox="0 0 ${VW} ${VH}" role="img" aria-label="${esc(T('Resource conversions', '资源换算'))}"><defs>
      <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" stroke="none"/></marker>
      <marker id="ahh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--ap)" stroke="none"/></marker></defs>`;
    s += edge('life', 'ap', T('half life → +5 AP', '一半生命 → +5 行动力'), true, 0, -62);
    s += edge('ap', 'next', T('carried via 险路小径', '经险路小径带走'), true, 0, -62);
    s += edge('ap', 'hope', T('1 : 1 at 险路尽头 / boss', '险路尽头 / 首领后 1 : 1'), true, 0, 14);
    s += edge('parts', 'ap', T('jumps skip nodes', '跳过节点'), true, 0, 12);
    s += edge('hope', 'ops', T('6★: recruit 6 · promote 3', '六星：招募 6 · 进阶 3'), false, 0, 12);
    s += edge('hope', 'ing', T('3 hope = 10 ingots', '3 希望 = 10 源石锭'), false, 0, -12);
    s += edge('ing', 'parts', T('2–16 at 秘境行商', '秘境行商 2–16'), false, 0, 12);
    s += edge('ing', 'slot', T('6 → +2 slots (空间租赁)', '6 → +2 格（空间租赁）'), false, 0, -12);
    s += edge('ing', 'col', T('8 / 12 / 16 at shop', '诡意行商 8 / 12 / 16'), false, 0, 12);
    s += edge('ing', 'nat', T('buy at 2× estimate', '按 2 倍估价买入'), false, 18, 14);
    s += edge('nat', 'ing', T('sell at estimate · 3 → +8', '按估价卖出 · 卖 3 个 +8'), false, 18, 14);
    for (const [k, [x, y, name, sub]] of Object.entries(B)) {
      s += `<g class="box ${k === 'ap' ? 'key' : ''}"><rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="6"/><text x="${x + 14}" y="${y + 24}">${esc(name)}</text><text class="sub" x="${x + 14}" y="${y + 42}">${esc(sub)}</text></g>`;
    }
    s += '</svg>';
    host.innerHTML = s;
  });

  // ---------- price index ----------
  const MENU_TEXT = {
    opening: { en: 'Opening support (区域相关)', zh: '开局支援（区域相关）', opts: ['未编号物：1 件普通收藏品', '调查预付款：+8 源石锭', '空间租赁：−6 源石锭，零件箱 +2', '退行补偿：−2 目标生命上限，+1 件随机收藏品', '林间代步：1 个加工品', '巢寄生：零件箱 −1，+1 件稀有收藏品'] },
    gold: { en: '金色凝滞 (safe corner, 3 of 7 shown)', zh: '金色凝滞（安全的角落，7 选 3）', opts: ['+3 目标生命上限', '可携带干员 +1', '+3 希望', '+2 行动力', '零件箱容量 +1'] },
    sunny: { en: '桑尼的邀请', zh: '桑尼的邀请', opts: ['+3 希望', '+10 源石锭'] },
    taste: { en: '色味不同源', zh: '色味不同源', opts: ['+3 目标生命上限', '+5 护盾'] },
    silent: { en: '沉寂之屋 (two ways to pay for 笼控器)', zh: '沉寂之屋（笼控器的两种付法）', opts: ['−2 目标生命', '−8 源石锭'] },
    legacy: { en: '襁褓生灵 start menu', zh: '襁褓生灵开局选择', opts: ['襁褓天马：5 个区域各 +1 行动力', '襁褓金乌：第Ⅲ层获得 3 件随机收藏品'] },
    tree: { en: '未涉足之树 (先行一步)', zh: '未涉足之树（先行一步）', opts: ['休息：+2 希望', '派出六星：免费晋升（3 希望）+ 1 个零件'] },
  };
  const menuState = Object.fromEntries(D.menus.map(m => [m.id, true]));
  D.menus.forEach(m => {
    const lab = document.createElement('label');
    lab.className = 'check';
    lab.innerHTML = `<input type="checkbox" id="menu-${m.id}" checked> <span><span data-l="en">${esc(MENU_TEXT[m.id].en)}</span><span data-l="zh">${esc(MENU_TEXT[m.id].zh)}</span></span>`;
    $('#menuToggles').appendChild(lab);
    lab.querySelector('input').addEventListener('change', e => { menuState[m.id] = e.target.checked; drawPrices(); });
  });
  const PRICE_LABEL = { hope: ['Hope', '希望'], ap: ['AP', '行动力'], maxHP: ['Max target life', '目标生命上限'], hp: ['Target life', '目标生命'], shield: ['Shield', '护盾'], slot: ['Box slot', '零件箱格'], carry: ['Carry slot', '可携带干员位'], proc: ['Movement part', '加工品'], colCommon: ['Common collectible', '普通收藏品'], colRandom: ['Random collectible', '随机收藏品'], colRare: ['Rare collectible', '稀有收藏品'] };
  function drawPrices() {
    const ids = Object.keys(menuState).filter(k => menuState[k]);
    const host = $('#priceChart');
    if (!ids.length) { host.textContent = T('Select at least one menu.', '请至少选择一个菜单。'); return; }
    const fit = BF.fitPrices({ menus: ids });
    const lam = BF.mean([2, 3, 4, 5].map(lamAt));
    const order = ['ap', 'hope', 'slot', 'carry', 'proc', 'colCommon', 'colRandom', 'colRare', 'maxHP', 'hp', 'shield'];
    hbar(host, {
      series: [{ name: T('Designer price (menus)', '设计者定价（菜单）'), color: 'var(--s1)' }, { name: T('Use value in simulation', '模拟中的使用价值'), color: 'var(--s3)' }],
      rows: order.map(k => ({ label: T(PRICE_LABEL[k][0], PRICE_LABEL[k][1]), strong: k === 'ap', vals: [{ v: fit.price[k] }, { v: k === 'ap' ? lam : null }] })),
      labelW: 150, rowHeader: T('Unit', '单位'), aria: T('Designer price index', '设计者价格指数'),
    });
    $('#menuTable').innerHTML = tableHTML([{ label: T('Menu', '菜单') }, { label: T('Option', '选项') }, { label: T('Value (ingots)', '价值（源石锭）'), n: true }, { label: T('Off menu value', '偏离菜单均值'), n: true }],
      fit.report.flatMap(m => m.options.map((o, i) => ({ cells: [i ? '' : `<b>${esc(T(MENU_TEXT[m.id].en, MENU_TEXT[m.id].zh))}</b> <span class="num">≈ ${f1(m.value)}</span>`, esc(T(o.label, MENU_TEXT[m.id].opts[i] || o.label)), f1(o.value), (o.gap >= 0 ? '+' : '') + f1(o.gap)] }))));
  }
  onRender(drawPrices);

  // ---------- geometry ----------
  onRender(function drawSlack() {
    const host = $('#slackChart');
    const W = Math.max(300, host.clientWidth || 600);
    const L = 74, Rr = 16, Tp = 10, rowH = 46, B = 30;
    const H = Tp + 5 * rowH + B;
    const maxD = Math.max(...R.geometry.map(g => g.nearestExit), 12);
    const x = v => L + v / maxD * (W - L - Rr);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(T('Exit distance against AP', '出口距离与行动力'))}">`;
    for (let t = 0; t <= maxD; t += 2) s += `<line class="gridline" x1="${x(t)}" x2="${x(t)}" y1="${Tp}" y2="${H - B}"/><text class="axis-label" x="${x(t)}" y="${H - B + 16}" text-anchor="middle">${t}</text>`;
    s += `<text class="axis-label" x="${W - Rr}" y="${H - 2}" text-anchor="end">${esc(T('steps from start to nearest exit', '起点到最近出口的步数'))}</text>`;
    for (let f = 1; f <= 5; f++) {
      const y0 = Tp + (f - 1) * rowH + rowH / 2;
      s += `<text x="0" y="${y0 + 4}" class="val">${esc(floorName(f))}</text>`;
      s += `<line x1="${x(baseAP(f))}" x2="${x(baseAP(f))}" y1="${y0 - 16}" y2="${y0 + 16}" stroke="var(--accent)" stroke-width="2"/><text class="ref-label" x="${x(baseAP(f)) + 5}" y="${y0 - 8}">${baseAP(f)} ${esc(T('AP', '行动力'))}</text>`;
      const cnt = {};
      R.geometry.filter(g => g.floor === f).forEach(g => {
        const k = g.nearestExit; const n = (cnt[k] = (cnt[k] || 0) + 1) - 1;
        const yy = y0 + (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 7;
        s += `<circle cx="${x(k)}" cy="${yy}" r="5" fill="${g.nearestExit > baseAP(f) ? 'var(--s2)' : 'var(--s1)'}" stroke="var(--surface)" stroke-width="2"><title>${g.id}: ${g.nearestExit}</title></circle>`;
      });
    }
    s += '</svg>';
    host.innerHTML = s;
    legend(host, [{ name: T('Exit reachable on foot', '可步行到达出口'), color: 'var(--s1)' }, { name: T('Exit beyond the base AP', '出口超出基础行动力'), color: 'var(--s2)' }], true);
    tableView(host, [{ label: T('Template', '模板') }, { label: T('Nodes', '节点'), n: true }, { label: T('Loops', '环'), n: true }, { label: T('Exit distances', '出口距离') }, { label: T('AP', '行动力'), n: true }],
      R.geometry.map(g => ({ hl: g.nearestExit > baseAP(g.floor), cells: [esc(g.id), g.nodes, g.cycles, g.exitDist.join(', '), baseAP(g.floor)] })), T('Show all 43 templates', '查看全部 43 张模板'));
  });

  onRender(function drawGallery() {
    const host = $('#gallery');
    let s = '';
    for (let f = 1; f <= 5; f++) {
      const ms = BF.mapsOnFloor(f);
      const exitName = f === 3 || f === 5 ? '险路恶敌' : '险路尽头';
      s += `<p class="floor-label">${esc(floorName(f))} <span class="zh">${D.floors[f - 1].name}</span> <span class="num" style="font-size:13px;color:var(--ink-2)">${ms[0].rows}×${ms[0].cols} · ${baseAP(f)} ${T('AP', '行动力')} · ${T('exit', '出口')}: ${exitName}</span></p><div class="gallery">`;
      for (const m of ms) {
        const g = BF.geometry(m);
        const over = g.nearestExit > baseAP(f);
        s += `<button type="button" data-map="${m.id}" aria-label="${esc(T('Open ' + m.id + ' in the route lab', '在路线实验中打开 ' + m.id))}">${mapSVG(m, { cell: 14, small: true })}<span class="cap"><b>${m.id.replace('floor-', '')}</b><span class="${over ? 'warnmark' : ''}">${T('exit', '出口')} ${g.nearestExit}${over ? ' > ' + T('AP', '行动力') : ''}</span></span></button>`;
      }
      s += '</div>';
    }
    host.innerHTML = s;
    host.querySelectorAll('button[data-map]').forEach(b => b.addEventListener('click', () => {
      const m = BF.MAPS.find(x => x.id === b.dataset.map);
      lab.floor = m.floor; lab.tpl = m.id; lab.ap = baseAP(m.floor); lab.seed = 1;
      syncLab(); runLab();
      $('#lab').scrollIntoView({ behavior: 'smooth' });
    }));
  });

  // ---------- price of a step ----------
  onRender(function drawLambda() {
    const host = $('#lambdaPanels');
    host.innerHTML = '';
    for (let f = 1; f <= 5; f++) {
      const cur = R.apCurves[f].filter(x => x.marginalFull != null);
      const box = document.createElement('div');
      box.className = 'panel';
      box.innerHTML = `<p class="mini-title">${esc(floorName(f))} <span style="font-size:13px;color:var(--ink-2);font-weight:500">${T('base', '基础')} ${baseAP(f)}</span></p><div class="chart"></div>`;
      host.appendChild(box);
      lineChart(box.querySelector('.chart'), {
        series: [{ name: T('Full information', '完全信息'), color: 'var(--s1)', pts: cur.map(x => [x.ap, x.marginalFull]) }, { name: T('Fog, knows template', '迷雾，认得模板'), color: 'var(--s3)', pts: cur.map(x => [x.ap, x.marginalFog]) }],
        ref: { y: hopeIE, label: T('1 hope', '1 希望') }, mark: baseAP(f), markLabel: T('base', '基础'), yMin: 0, yMax: Math.max(16, ...cur.map(x => Math.max(x.marginalFull, x.marginalFog))),
        height: 170, left: 30, legend: false, xName: T('AP ', '行动力 '), yFmt: f0, aria: floorName(f),
      });
    }
    $('#lambdaLegend').innerHTML = `<span><i style="background:var(--s1)"></i>${T('Full information', '完全信息')}</span><span><i style="background:var(--s3)"></i>${T('Fog, knows template', '迷雾，认得模板')}</span><span><i style="background:var(--accent)"></i>${T('Exit pays 1 hope', '出口回收价 1 希望')} (${hopeIE.toFixed(2)} IE)</span>`;
    const outName = k => ({ final: '险路尽头', evac: '险路小径', boss: '险路恶敌', pursuit: T('pursuit', '追猎') }[k] || k);
    const rows = [];
    for (let f = 1; f <= 5; f++) R.apCurves[f].forEach(x => rows.push({ hl: x.ap === baseAP(f), cells: [esc(floorName(f)), x.ap, f1(x.full), f1(x.fog), f1(x.marginalFull), f1(x.marginalFog), esc(Object.entries(x.outcomes).map(([k, v]) => outName(k) + ' ' + pct(v)).join(', '))] }));
    tableView($('#lambdaLegend'), [{ label: T('Floor', '楼层') }, { label: T('AP', '行动力'), n: true }, { label: T('Best value', '最优值'), n: true }, { label: T('Fog value', '迷雾值'), n: true }, { label: T('+1 AP (full)', '+1 行动力（完全）'), n: true }, { label: T('+1 AP (fog)', '+1 行动力（迷雾）'), n: true }, { label: T('How zones end (best plan)', '结束方式（最优计划）') }], rows, T('Show the numbers', '查看数据'));
  });
  const SCEN = { default: ['Default mix and values', '默认构成与价值'], battleHeavy: ['Battle-heavy maps', '战斗偏多的地图'], eventHeavy: ['Event-heavy maps', '事件偏多的地图'], lowValues: ['Node values ×0.5', '节点价值 ×0.5'], highValues: ['Node values ×1.5', '节点价值 ×1.5'] };
  onRender(function sensTable() {
    const rows = R.sensitivity.map(s => ({ hl: s.id === 'default', cells: [esc(T(SCEN[s.id][0], SCEN[s.id][1]))].concat([1, 2, 3, 4, 5].map(f => f1(s.marginal[f]) + ` <span style="color:var(--muted)">(${f1(s.marginal[f] / hopeIE)} ${T('h', '希望')})</span>`)) }));
    $('#sensTable').innerHTML = tableHTML([{ label: T('Scenario', '情景') }].concat([1, 2, 3, 4, 5].map(f => ({ label: floorName(f), n: true }))), rows) +
      `<p style="font-size:13px;color:var(--ink-2);margin:6px 0 0">${T('Value of the first extra AP above base, full information, IE (hope in brackets). The exit pays 1 hope.', '基础预算之上第一点额外行动力的价值（完全信息，IE；括号内为希望）。出口只回收 1 希望。')}</p>`;
  });

  // ---------- route lab ----------
  const lab = { floor: 2, tpl: null, seed: 1, ap: 6, part1: '', part2: '', mode: 'best', knows: true, sec3: false, values: Object.assign({}, BF.DEFAULT_VALUES) };
  const partOpts = D.processing.filter(p => p.key !== 'express');
  const partName = p => T(p.name + ' · ' + p.en, p.name);
  function syncLab() {
    $('#labFloor').innerHTML = [1, 2, 3, 4, 5].map(f => `<button type="button" aria-pressed="${f === lab.floor}" data-f="${f}">${ROMAN[f]}</button>`).join('');
    const ms = BF.mapsOnFloor(lab.floor);
    if (!lab.tpl || !ms.some(m => m.id === lab.tpl)) lab.tpl = ms[0].id;
    $('#labTpl').innerHTML = ms.map(m => `<option value="${m.id}" ${m.id === lab.tpl ? 'selected' : ''}>${m.id} · ${T('exit', '出口')} ${BF.geometry(m).nearestExit}</option>`).join('');
    $('#labAP').value = lab.ap; $('#labAPv').textContent = lab.ap;
    const po = `<option value="">${T('None', '无')}</option>` + partOpts.map(p => `<option value="${p.key}">${esc(partName(p))}${p.buy ? ' · ' + p.buy + ' ' + T('ingots', '源石锭') : ''}</option>`).join('');
    $('#labPart1').innerHTML = po; $('#labPart2').innerHTML = po;
    $('#labPart1').value = lab.part1; $('#labPart2').value = lab.part2;
    $('#labMode').innerHTML = [['best', T('Best route', '最优路线')], ['fog', T('Fog player', '迷雾玩家')]].map(([k, l]) => `<button type="button" aria-pressed="${lab.mode === k}" data-m="${k}">${l}</button>`).join('');
    $('#labTemplate').checked = lab.knows; $('#labSecrecy').checked = lab.sec3;
    $('#labKey').innerHTML = Object.values(GROUP_STYLE).map(g => `<span><i style="background:${g.fill};border:1px solid var(--rule-strong)"></i>${esc(T(g.en, g.zh))}</span>`).join('') +
      `<span><i style="background:var(--surface);border:1px solid var(--rule-strong)"></i>${T('Unseen (凶 hostile / 诡 other)', '未揭示（凶 / 诡）')}</span><span><i style="background:var(--accent)"></i>${T('Part jump', '加工品跳跃')}</span>`;
  }
  function buildValueSliders() {
    const keys = ['battle', 'elite', 'duel', 'incident', 'wish', 'rest', 'expedition', 'shop', 'scrap', 'sacrifice', 'employ', 'portal'];
    $('#labValues').innerHTML = keys.map(k => `<div class="slider-row"><label for="v-${k}"><span class="zh">${BF.TYPE_INFO[k][0]}</span> <span data-l="en">${BF.TYPE_INFO[k][1]}</span></label><output id="v-${k}-o">${lab.values[k]}</output><input type="range" id="v-${k}" min="0" max="30" step="1" value="${lab.values[k]}"></div>`).join('');
    keys.forEach(k => $('#v-' + k).addEventListener('input', e => { lab.values[k] = +e.target.value; $('#v-' + k + '-o').textContent = e.target.value; runLab(); }));
  }
  function runLab() {
    const m = BF.MAPS.find(x => x.id === lab.tpl);
    const P = BF.populate(m, BF.rng(lab.seed * 7919 + m.floor), {});
    const val = BF.valuesFor(P, lab.values);
    const parts = [lab.part1, lab.part2].filter(Boolean).map(k => partOpts.find(p => p.key === k)).map(p => ({ part: p, uses: p.uses }));
    const params = { secrecy: lab.sec3 ? 3 : 0 };
    const best = BF.solve({ m, P, val, ap: lab.ap, parts, params });
    let path, value, outcome, apLeft, seen = null, nodesV = 0;
    if (lab.mode === 'best') {
      path = best.path; value = best.value;
      const last = path[path.length - 1];
      outcome = last.how === 'pursuit' ? 'pursuit' : P.types[last.node];
      apLeft = last.how === 'pursuit' ? 0 : last.ap;
      const vis = new Set([m.start]);
      path.forEach(p => { if (!vis.has(p.node)) { vis.add(p.node); nodesV += val[p.node]; } });
    } else {
      const z = BF.playZone(m, P, { ap: lab.ap, knowsTemplate: lab.knows, values: lab.values, parts, params, rand: BF.rng(lab.seed) });
      path = z.path; value = z.value; outcome = z.outcome; apLeft = z.apLeft; seen = z.seen; nodesV = z.log.nodeValue;
    }
    const host = $('#labMap');
    const W = host.clientWidth || 600;
    const cell = Math.max(34, Math.min(70, Math.floor((W - 8) / m.cols)));
    host.innerHTML = mapSVG(m, { cell, types: P.types, path, seen, pair: Array.from(P.pair) });
    host.querySelectorAll('.node').forEach(g => {
      const i = +g.dataset.i, t = P.types[i];
      const tt = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      tt.textContent = (seen && !seen[i] ? T('Unseen · ', '未揭示 · ') : '') + BF.TYPE_INFO[t][0] + ' ' + T(BF.TYPE_INFO[t][1], '') + (val[i] ? ' · ' + val[i] + ' IE' : '');
      g.appendChild(tt);
    });
    const outName = { final: '险路尽头', evac: '险路小径', boss: '险路恶敌', pursuit: T('追猎 (pursuit)', '追猎') }[outcome] || outcome;
    $('#labReadout').innerHTML = [
      [T('Total', '总价值'), f1(value) + ' IE'], [T('From nodes', '来自节点'), f1(nodesV) + ' IE'], [T('Zone ends at', '结束于'), outName], [T('AP left', '剩余行动力'), apLeft],
      lab.mode === 'fog' ? [T('Best possible', '理论最优'), f1(best.value) + ' IE'] : [T('States searched', '搜索状态数'), best.states.toLocaleString()],
    ].map(([a, b]) => `<div><span class="rl">${esc(a)}</span><span class="rv">${esc(String(b))}</span></div>`).join('');
    $('#labSteps').innerHTML = path.slice(1).map((p, k) => {
      if (p.how === 'pursuit') return `<span>${k + 1}. ${T('pursuit', '追猎')}</span>`;
      const t = P.types[p.node];
      const pt = partOpts.find(x => x.key === p.part);
      return `<span class="${p.how === 'part' ? 'jump' : ''}">${k + 1}. <span class="zh">${BF.TYPE_INFO[t][0]}</span>${p.how === 'part' && pt ? ' · ' + esc(pt.name) : ''}</span>`;
    }).join('');
  }
  $('#labFloor').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; lab.floor = +b.dataset.f; lab.ap = baseAP(lab.floor); lab.tpl = null; syncLab(); runLab(); });
  $('#labTpl').addEventListener('change', e => { lab.tpl = e.target.value; runLab(); });
  $('#labAP').addEventListener('input', e => { lab.ap = +e.target.value; $('#labAPv').textContent = lab.ap; runLab(); });
  $('#labPart1').addEventListener('change', e => { lab.part1 = e.target.value; runLab(); });
  $('#labPart2').addEventListener('change', e => { lab.part2 = e.target.value; runLab(); });
  $('#labMode').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; lab.mode = b.dataset.m; syncLab(); runLab(); });
  $('#labTemplate').addEventListener('change', e => { lab.knows = e.target.checked; runLab(); });
  $('#labSecrecy').addEventListener('change', e => { lab.sec3 = e.target.checked; runLab(); });
  $('#labRoll').addEventListener('click', () => { lab.seed++; runLab(); });
  lab.ap = baseAP(lab.floor);
  buildValueSliders();
  onRender(() => { syncLab(); runLab(); });

  // ---------- exits ----------
  onRender(function drawExits() {
    hbar($('#evacChart'), {
      series: [{ name: T('Carried AP valued at 1 hope', '带走的行动力按 1 希望计'), color: 'var(--s1)' }, { name: T('Valued at next floor’s step price', '按下一层的边际价值计'), color: 'var(--s3)' }],
      rows: [1, 2, 4].map(f => ({ label: floorName(f), sub: `→ ${ROMAN[f + 1]} λ ${f1(R.evac[f].lambdaNext)}`, vals: [{ v: R.evac[f].takenAtCash * 100, text: pct(R.evac[f].takenAtCash) }, { v: R.evac[f].takenAtLambda * 100, text: pct(R.evac[f].takenAtLambda) }] })),
      max: 100, fmt: f0, axisLabel: T('% of zones with a hidden exit', '存在隐藏出口的区域中所占比例 %'), labelW: 150, rowHeader: T('Floor', '楼层'), aria: T('Hidden exit take rate', '隐藏出口选择率'),
    });
    const pens = R.boss[3].byPenalty.map(p => -p.penalty);
    lineChart($('#bossChart'), {
      series: [3, 5].map((f, i) => ({ name: floorName(f), color: SER[i], pts: R.boss[f].byPenalty.map(p => [-p.penalty, p.pursuitShare * 100]) })),
      yMin: 0, yMax: 100, yFmt: v => f0(v) + '%', xTicks: pens, xName: T('penalty ', '代价 '), xLabel: T('how much worse the pursuit version is (IE)', '追猎版首领的额外代价（IE）'), height: 230, aria: T('Boss pursuit share', '首领层追猎比例'),
    });
    tableView($('#bossChart'), [{ label: T('Penalty (IE)', '代价（IE）'), n: true }, { label: T('Floor Ⅲ ends in pursuit', '第Ⅲ层以追猎结束'), n: true }, { label: T('Floor Ⅴ ends in pursuit', '第Ⅴ层以追猎结束'), n: true }], R.boss[3].byPenalty.map((p, i) => ({ cells: [-p.penalty, pct(p.pursuitShare), pct(R.boss[5].byPenalty[i].pursuitShare)] })));
  });

  // ---------- parts ----------
  onRender(function drawParts() {
    const rows = R.parts[2].map(p => ({ key: p.key, p2: p, p5: R.parts[5].find(q => q.key === p.key) })).sort((a, b) => b.p5.gain - a.p5.gain);
    hbar($('#partsChart'), {
      series: [{ name: floorName(2), color: 'var(--s1)' }, { name: floorName(5), color: 'var(--s2)' }],
      rows: rows.map(r => {
        const part = D.processing.find(p => p.key === r.key);
        return { label: part.name + (part.floorOnly ? '*' : ''), sub: (part.buy ? part.buy + T('g', '锭') : T('not sold', '不出售')) + ' · ' + part.uses + T('×', '次'), vals: [{ v: r.p2.gain, lo: r.p2.p10, hi: r.p2.p90 }, { v: r.p5.gain, lo: r.p5.p10, hi: r.p5.p90 }] };
      }),
      labelW: 190, axisLabel: T('IE added when used on that floor', '在该层使用时增加的 IE'), rowHeader: T('Part', '加工品'), aria: T('Value of movement parts', '加工品价值'), table: false,
    });
    const head = [{ label: T('Part', '加工品') }, { label: T('Price', '售价'), n: true }, { label: T('Uses', '次数'), n: true }, { label: T('AP per use', '每次行动力'), n: true }].concat([2, 3, 4, 5].map(f => ({ label: floorName(f), n: true }))).concat([{ label: T('Return on price (Ⅱ–Ⅴ avg)', '回报倍数（Ⅱ–Ⅴ 平均）'), n: true }]);
    $('#partsTable').innerHTML = tableHTML(head, rows.map(r => {
      const part = D.processing.find(p => p.key === r.key);
      const gs = [2, 3, 4, 5].map(f => R.parts[f].find(q => q.key === r.key).gain);
      return { cells: [`<span class="zh">${esc(part.name)}</span> ${esc(T(part.en, ''))}`, part.buy ?? '–', part.uses, part.ap].concat(gs.map(f1)).concat([part.buy ? f1(BF.mean(gs) / part.buy) + '×' : '–']) };
    }));
  });

  // ---------- natural items ----------
  const nat = { reading: 'event', recruits: 1.5 };
  $('#fogReading').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; nat.reading = b.dataset.r; drawNatural(); });
  $('#recruits').addEventListener('input', e => { nat.recruits = +e.target.value; drawNatural(); });
  const GROW_TEXT = g => Object.entries(g).map(([k, v]) => T({ battle: `+${v} per battle`, perfect: `+${v} per perfect battle`, reveal: `+${v} per reveal`, recruit: `+${v} per recruit`, noncombat: `+${v} per non-combat node`, merchant: `+${v} per merchant entered`, part: `+${v} per part gained`, move: `${v > 0 ? '+' : ''}${v} per move`, distance: `+${v} per step travelled`, moveRandom: 'random walk per move' }[k] || k,
    { battle: `每场作战 +${v}`, perfect: `每次完美作战 +${v}`, reveal: `每次揭示 +${v}`, recruit: `每次招募 +${v}`, noncombat: `每进入非战斗节点 +${v}`, merchant: `每进入行商 +${v}`, part: `每获得零件 +${v}`, move: `每次移动 ${v > 0 ? '+' : ''}${v}`, distance: `按移动距离 +${v}`, moveRandom: '每次移动随机变化' }[k] || k)).join(T(', ', '，')) || T('fixed', '固定');
  function drawNatural() {
    $('#fogReading').innerHTML = [['event', T('Per reveal event', '按揭示事件')], ['node', T('Per node revealed', '按揭示节点数')]].map(([k, l]) => `<button type="button" data-r="${k}" aria-pressed="${nat.reading === k}">${l}</button>`).join('');
    $('#recruitsV').textContent = nat.recruits;
    const acts = R.tradeActs.map(a => Object.assign({}, a, { recruits: nat.recruits, reveals: nat.reading === 'node' ? a.revealNodes : a.reveals }));
    const items = D.naturals.filter(n => n.buy).map(n => {
      const per = acts.map(a => { const g = BF.naturalGrowth(n, a); return g.delta - g.cost; });
      return { n, per, gain: n.base + per.slice(1).reduce((s, x) => s + x, 0) - n.buy };
    }).sort((a, b) => b.gain - a.gain);
    const head = [{ label: T('Item', '自然物') }, { label: T('Buy', '售价'), n: true }, { label: T('Estimate', '估价'), n: true }, { label: T('Grows by', '增值方式') }].concat([1, 2, 3, 4, 5].map(f => ({ label: ROMAN[f], n: true }))).concat([{ label: T('Bought Ⅱ, sold Ⅴ', 'Ⅱ买 Ⅴ卖'), n: true }]);
    const warn = n => (n.leakPenalty ? ` <span style="color:var(--crit)">${T('(+1 life lost per leak)', '（漏怪多扣 1 生命）')}</span>` : '') + (n.breaksOnImperfect ? ` <span style="color:var(--crit)">${T('(breaks on an imperfect battle)', '（非完美作战即损坏）')}</span>` : '');
    $('#naturalTable').innerHTML = tableHTML(head, items.map((it, i) => ({ hl: i < 3, cells: [`<span class="zh">${esc(it.n.name)}</span> ${esc(T(it.n.en, ''))}${warn(it.n)}`, it.n.buy, it.n.base, esc(GROW_TEXT(it.n.grow) + (it.n.costPerMove ? T(', costs 1 ingot per move', '，每次移动消耗 1 源石锭') : ''))].concat(it.per.map(f1)).concat([(it.gain >= 0 ? '+' : '') + f1(it.gain)]) }))) +
      `<p style="font-size:13px;color:var(--ink-2);margin:6px 0 0">${T(
        `Growth per zone (ingots) at the simulated action counts: moves ${R.tradeActs.map(a => f1(a.moves)).join(' / ')}, battles ${R.tradeActs.map(a => f1(a.battles)).join(' / ')}, reveal ${nat.reading === 'node' ? 'nodes' : 'events'} ${acts.map(a => f1(a.reveals)).join(' / ')} on floors Ⅰ–Ⅴ. 浪花 is a random walk with zero drift, so its expected growth is 0. Items not sold at 秘境行商 (板藤, 光彩松露, 无缘果 and others) come from events and drops.`,
        `按模拟中的行动次数计算的每区域增值（源石锭）：第Ⅰ–Ⅴ层移动 ${R.tradeActs.map(a => f1(a.moves)).join(' / ')} 次，作战 ${R.tradeActs.map(a => f1(a.battles)).join(' / ')} 场，揭示${nat.reading === 'node' ? '节点' : '事件'} ${acts.map(a => f1(a.reveals)).join(' / ')} 次。浪花是零漂移的随机游走，期望增值为 0。秘境行商不出售的自然物（板藤、光彩松露、无缘果等）来自事件和掉落。`)}</p>`;
  }
  onRender(drawNatural);
  const TRADE_LABEL = { box8: ['Box 8 (保密等级 7+)', '零件箱 8（保密等级 7+）'], box10: ['Box 10 (default)', '零件箱 10（默认）'], box12: ['Box 12 (多边贸易)', '零件箱 12（多边贸易）'], box14: ['Box 14 (多边贸易 + 鳍)', '零件箱 14（多边贸易 + 鳍）'], box10rich: ['Box 10 + 20 ingots (后勤)', '零件箱 10 + 20 源石锭（后勤）'], box8full: ['Box 8, 6 slots held', '零件箱 8，已占用 6 格'], box10full: ['Box 10, 6 slots held', '零件箱 10，已占用 6 格'], box12full: ['Box 12 + bonus, 6 slots held', '零件箱 12 + 卖出奖励，已占用 6 格'] };
  onRender(function drawTrade() {
    const ids = ['box8', 'box10', 'box12', 'box14', 'box10rich', 'box8full', 'box10full', 'box12full'].filter(id => R.trading.some(t => t.id === id));
    hbar($('#tradeChart'), {
      series: [{ name: T('Sparse visits (Ⅱ, Ⅳ, Ⅴ)', '稀疏访问（Ⅱ、Ⅳ、Ⅴ）'), color: 'var(--s4)' }, { name: T('One visit per floor Ⅱ–Ⅴ', 'Ⅱ–Ⅴ 每层一次'), color: 'var(--s1)' }, { name: T('Two visits on Ⅳ', '第Ⅳ层两次'), color: 'var(--s3)' }],
      rows: ids.map(id => ({ label: T(TRADE_LABEL[id][0], TRADE_LABEL[id][1]), vals: ['sparse', 'one', 'hunt'].map(p => { const t = trade(id, p); return { v: t.profit.mean, lo: t.profit.p10, hi: t.profit.p90 }; }) })),
      labelW: 220, axisLabel: T('ingots of trading profit per run', '每局交易利润（源石锭）'), fmt: f0, rowHeader: T('Box', '零件箱'), aria: T('Trading profit', '交易利润'),
    });
  });

  // ---------- information ----------
  onRender(function drawVoi() {
    hbar($('#voiChart'), {
      series: [{ name: T('Value of seeing the whole map', '看清全图的价值'), color: 'var(--s1)' }, { name: T('Value of knowing the template (保密等级 3+)', '认得模板的价值（保密等级 3+）'), color: 'var(--s3)' }],
      rows: [1, 2, 3, 4, 5].map(f => ({ label: floorName(f), vals: [{ v: R.voi[f].voi }, { v: R.voi[f].templateValue3 }] })),
      labelW: 90, axisLabel: T('IE per zone', '每区域 IE'), rowHeader: T('Floor', '楼层'), aria: T('Value of information', '信息价值'), ref: { v: hopeIE, label: T('1 hope', '1 希望') },
    });
  });

  // ---------- whole run ----------
  const CHAIN_LABEL = { base: ['No bonus', '无加成'], pegasus: ['襁褓天马 (+1 AP per zone)', '襁褓天马（每区域 +1 行动力）'], griffin: ['襁褓骏鹰 (Ⅰ–Ⅱ fully revealed)', '襁褓骏鹰（第Ⅰ–Ⅱ层全图视野）'], pioneer: ['开拓者分队 (+1 part per zone)', '开拓者分队（每区域 +1 加工品）'], evacSeeker: ['Value carried AP at next floor’s λ', '按下一层边际价值计算带走的行动力'] };
  onRender(function drawChain() {
    const base = chain('base');
    hbar($('#chainChart'), {
      series: [{ name: T('Total value per run', '每局总价值'), color: 'var(--s1)' }],
      rows: R.chain.map(c => ({ label: T(CHAIN_LABEL[c.id][0], CHAIN_LABEL[c.id][1]), strong: c.id === 'base', vals: [{ v: c.total.mean, lo: c.total.p10, hi: c.total.p90, text: f0(c.total.mean) + (c.id === 'base' ? '' : ` (${c.total.mean - base >= 0 ? '+' : ''}${f0(c.total.mean - base)})`) }] })),
      labelW: 250, fmt: f0, axisLabel: T('IE over floors Ⅰ–Ⅴ', '第Ⅰ–Ⅴ层累计 IE'), rowHeader: T('Variant', '变体'), aria: T('Chained run value', '整局价值'), table: false,
    });
    $('#chainTable').innerHTML = tableHTML([{ label: T('Variant', '变体') }].concat([1, 2, 3, 4, 5].map(f => ({ label: floorName(f), n: true }))).concat([{ label: T('Took 险路小径 (Ⅰ/Ⅱ/Ⅳ)', '走险路小径（Ⅰ/Ⅱ/Ⅳ）'), n: true }]),
      R.chain.map(c => ({ cells: [esc(T(CHAIN_LABEL[c.id][0], CHAIN_LABEL[c.id][1]))].concat(c.perFloor.map(f1)).concat([[0, 1, 3].map(i => pct(c.evacRate[i])).join(' / ')]) })));
  });

  // ---------- endings ----------
  onRender(function drawE2() {
    const e = R.ending2;
    hbar($('#e2Chart'), {
      series: [{ name: T('AP to reach the true 命运所指', '到达真命运所指所需行动力'), color: 'var(--s1)' }],
      rows: [[T('Both sandboxes (marked)', '两个沙盘（已标出）'), e.apBoth, e.overBudget.both], [T('One sandbox, pay 50 at a false node', '一个沙盘，在假节点付 50'), e.apPay, e.overBudget.pay], [T('One sandbox, keep walking', '一个沙盘，继续步行搜索'), e.apWalk, e.overBudget.walk]]
        .map(([l, s, o]) => ({ label: l, vals: [{ v: s.mean, lo: s.p10, hi: s.p90, text: f1(s.mean) + ' · ' + pct(o) + T(' over 8', ' 超出 8') }] })),
      labelW: 250, valW: 130, ref: { v: 8, label: T('floor Ⅴ AP', '第Ⅴ层行动力') }, axisLabel: T('AP from the start of floor Ⅴ', '从第Ⅴ层起点算起的行动力'), rowHeader: T('Strategy', '策略'), aria: T('Ending 2 search cost', '结局二搜索成本'),
    });
  });

  // ---------- secrecy ----------
  function drawSec() {
    const lv = +$('#secLevel').value;
    $('#secLevelV').textContent = lv;
    const row = D.secrecy[lv];
    const step = row.enemy / 100;
    lineChart($('#secChart'), {
      series: [{ name: T('Compounding', '复利叠加'), color: 'var(--s2)', pts: [1, 2, 3, 4, 5].map(f => [f, Math.pow(1 + step, f - 1)]) }, { name: T('Additive', '线性叠加'), color: 'var(--s1)', pts: [1, 2, 3, 4, 5].map(f => [f, 1 + step * (f - 1)]) }],
      yMin: 1, yMax: Math.max(1.2, Math.pow(1 + step, 4)), yFmt: v => '×' + v.toFixed(2), xFmt: v => ROMAN[v], xName: T('floor ', '第 '), xLabel: T('floor', '楼层'), height: 220, aria: T('Enemy scaling', '敌人缩放'),
    });
    const notes = D.secrecy.filter(s => s.level <= lv && s.level > 0).map(s => `<li><b>${s.level}</b> ${esc(s.effect)}</li>`).join('');
    const hp = (lv >= 5 ? 1.3 : 1) * Math.pow(1 + step, 4);
    const tax = lv >= 9 ? `<p>${T(`An ingot carried from floor Ⅰ to Ⅴ keeps <b>${pct(Math.pow(0.9, 4))}</b> of its value. Natural items and parts keep their estimate.`, `从第Ⅰ层带到第Ⅴ层的源石锭只剩 <b>${pct(Math.pow(0.9, 4))}</b>，自然物和零件的估价不受影响。`)}</p>` : '';
    const head = T(`Per-floor enemy increase <b>+${row.enemy}%</b>${lv >= 5 ? `, on top of +30% max HP from level 5 (floor Ⅴ HP ×${hp.toFixed(2)} compounding)` : ''}. Score bonus +${row.score}%.`,
      `每层敌人额外 <b>+${row.enemy}%</b>${lv >= 5 ? `，另有等级 5 起所有敌人最大生命 +30%（复利下第Ⅴ层生命 ×${hp.toFixed(2)}）` : ''}。得分效率 +${row.score}%。`);
    $('#secNotes').innerHTML = `<p>${head}</p>${tax}<ul style="margin:0;padding-left:1.1em;display:grid;gap:4px">${notes}</ul>`;
  }
  $('#secLevel').addEventListener('input', drawSec);
  onRender(drawSec);

  // ---------- index highlight and resize ----------
  const links = [...document.querySelectorAll('.index a')];
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) links.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + en.target.id)); });
    }, { rootMargin: '-45% 0px -50% 0px' });
    document.querySelectorAll('main section').forEach(s => io.observe(s));
  }
  let rt = null, lastW = $('main').clientWidth;
  const rerender = () => {
    const w = $('main').clientWidth;
    if (Math.abs(w - lastW) < 8) return;
    lastW = w;
    clearTimeout(rt);
    rt = setTimeout(() => renderers.forEach(fn => fn()), 150);
  };
  if ('ResizeObserver' in window) new ResizeObserver(rerender).observe($('main'));
  else window.addEventListener('resize', rerender);
})();
