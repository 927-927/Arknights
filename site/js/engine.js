/* Black Flow simulation engine. Runs in the browser (global BF) and in Node (require). */
(function (root) {
  'use strict';
  const D = root.BF_DATA || (typeof require !== 'undefined' ? require('./data.js') : null);

  // ---------- random numbers ----------
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  function weightedPick(r, entries) {
    let total = 0;
    for (const [, w] of entries) total += w;
    let x = r() * total;
    for (const [k, w] of entries) { x -= w; if (x < 0) return k; }
    return entries[entries.length - 1][0];
  }

  // ---------- maps ----------
  function buildMap(tpl) {
    const { rows, cols } = tpl;
    const idx = new Int16Array(rows * cols).fill(-1);
    const R = [], C = [];
    const add = (r, c) => {
      const k = r * cols + c;
      if (idx[k] < 0) { idx[k] = R.length; R.push(r); C.push(c); }
      return idx[k];
    };
    const start = add(tpl.start[0], tpl.start[1]);
    const adjSets = [];
    for (const [r1, c1, r2, c2] of tpl.edges) {
      const a = add(r1, c1), b = add(r2, c2);
      (adjSets[a] = adjSets[a] || new Set()).add(b);
      (adjSets[b] = adjSets[b] || new Set()).add(a);
    }
    const exits = tpl.exits.map(([r, c]) => add(r, c));
    const n = R.length;
    const adj = [];
    for (let i = 0; i < n; i++) adj.push(adjSets[i] ? [...adjSets[i]] : []);
    const dist = bfs(adj, start);
    return { tpl, id: tpl.id, floor: tpl.floor, rows, cols, n, R, C, idx, adj, start, exits, exitType: tpl.exitType, dist };
  }
  function bfs(adj, s) {
    const d = new Array(adj.length).fill(Infinity);
    d[s] = 0;
    const q = [s];
    for (let h = 0; h < q.length; h++) for (const j of adj[q[h]]) if (d[j] === Infinity) { d[j] = d[q[h]] + 1; q.push(j); }
    return d;
  }
  const MAPS = D ? D.maps.map(buildMap) : [];
  const mapsOnFloor = f => MAPS.filter(m => m.floor === f);

  function geometry(m) {
    const exitD = m.exits.map(e => m.dist[e]);
    const edges = m.adj.reduce((s, a) => s + a.length, 0) / 2;
    return { id: m.id, floor: m.floor, nodes: m.n, edges, cycles: edges - m.n + 1, exitDist: exitD, nearestExit: Math.min(...exitD), maxDist: Math.max(...m.dist.filter(isFinite)) };
  }

  // ---------- node contents ----------
  const COMBAT = new Set(['battle', 'elite', 'duel', 'boss', 'savage', 'roamer']);
  const TYPE_INFO = {
    battle: ['作战', 'Battle'], elite: ['紧急作战', 'Emergency battle'], duel: ['狭路相逢', 'Duel'],
    incident: ['不期而遇', 'Encounter'], wish: ['得偿所愿', 'Wish'], rest: ['安全的角落', 'Safe corner'],
    shop: ['诡意行商', 'Shop'], scrap: ['秘境行商', 'Secret merchant'], employ: ['应急助力', 'Emergency aid'],
    sacrifice: ['失与得', 'Loss & gain'], expedition: ['先行一步', 'Go ahead'], light: ['羽瞰点', 'Lookout'],
    portal: ['误入奇境', 'Wonderland'], door: ['曲折密道', 'Tunnel'], empty: ['林间空地', 'Clearing'],
    final: ['险路尽头', 'Dead-end exit'], boss: ['险路恶敌', 'Boss exit'], evac: ['险路小径', 'Hidden exit'], start: ['起点', 'Start'],
    savage: ['“居民”据点', 'Resident stronghold'], roamer: ['流窜的“居民”', 'Roaming resident'], fate: ['命运所指', 'Fate'],
  };
  // Content mix: relative weights. Not published by the game; adjustable assumption.
  const DEFAULT_MIX = { battle: 30, elite: 8, incident: 18, wish: 5, light: 5, rest: 5, shop: 4, scrap: 4, employ: 3, sacrifice: 3, expedition: 3, duel: 3, portal: 2, empty: 5 };
  const NOT_ON = { rest: [1], employ: [1, 6], sacrifice: [1, 6], expedition: [1, 5, 6], duel: [1, 2, 6] };
  // Value of completing each node, in ingot-equivalents (IE). Adjustable assumption.
  const DEFAULT_VALUES = { battle: 6, elite: 12, duel: 9, incident: 9, wish: 12, rest: 10, shop: 5, scrap: 6, employ: 2, sacrifice: 5, expedition: 10, light: 0, portal: 6, door: 0, empty: 0, final: 0, boss: 0, evac: 0, start: 0, savage: 16, roamer: 4, fate: 0 };
  const DEFAULT_PARAMS = {
    hopeIE: 3.33,        // 1 hope in ingots (桑尼的邀请: 3 hope = 10 ingots)
    carryIE: 3.33,       // value of 1 AP carried out through 险路小径
    partIE: 4,           // ordinary movement part from 险路尽头
    rarePartIE: 8,       // rarer part from 险路小径
    pursuitIE: -30,      // ordinary pursuit: 1 ticket minus the risk of losing the run
    bossPursuitIE: -6,   // boss floors: the pursuit version of the boss instead of the boss
    pEvac: 0.5,          // chance a non-boss floor has a 险路小径
    pDoor: 0.35,         // chance a floor has a pair of 曲折密道
    realMix: true,       // sample each cell from the recorded P(type | floor, distance) (lubiao, 20,530 maps)
    secrecy: 0,
  };

  function floorMix(floor, mix) {
    const out = [];
    for (const [k, w] of Object.entries(mix || DEFAULT_MIX)) {
      let ww = w;
      if (NOT_ON[k] && NOT_ON[k].includes(floor)) ww = 0;
      if (k === 'elite' && floor === 1) ww = w / 2;
      if (ww > 0) out.push([k, ww]);
    }
    return out;
  }
  function categoryMeans(floor, values, mix) {
    const v = values || DEFAULT_VALUES;
    let cw = 0, cs = 0, nw = 0, ns = 0;
    for (const [k, w] of floorMix(floor, mix)) {
      if (COMBAT.has(k)) { cw += w; cs += w * v[k]; } else { nw += w; ns += w * v[k]; }
    }
    return { combat: cs / cw, non: ns / nw };
  }

  // Recorded node mix by walking distance. Exits are fixed by the template, so they are left out.
  const NOT_SAMPLED = new Set(['final', 'boss', 'fate', 'start']);
  function distanceRow(floor, d) {
    const nd = D && D.nodeDist && D.nodeDist[floor];
    if (!nd) return null;
    const ds = Object.keys(nd).map(Number).sort((a, b) => a - b);
    const key = ds.includes(d) ? d : ds.reduce((best, x) => (Math.abs(x - d) < Math.abs(best - d) ? x : best), ds[0]);
    const row = Object.entries(nd[key]).filter(([t]) => !NOT_SAMPLED.has(t));
    return row.length ? row : null;
  }
  // What an unseen node is likely to be, given its floor, walking distance and icon (凶戾 hostile / 诡秘 mystery).
  function deduce(floor, d, hostile) {
    const ni = D && D.nodeIcon && D.nodeIcon[floor];
    if (!ni) return null;
    const ds = Object.keys(ni).map(Number);
    const key = ds.includes(d) ? d : ds.reduce((best, x) => (Math.abs(x - d) < Math.abs(best - d) ? x : best), ds[0]);
    const row = ni[key][hostile ? 'hostile' : 'mystery'];
    const ent = Object.entries(row || {}).filter(([t]) => !NOT_SAMPLED.has(t));
    const tot = ent.reduce((a, [, p]) => a + p, 0);
    return tot > 0 ? ent.map(([t, p]) => [t, p / tot]) : null;
  }
  function deducedValue(floor, d, hostile, values) {
    const post = deduce(floor, d, hostile);
    if (!post) return null;
    return post.reduce((a, [t, p]) => a + p * ((values || DEFAULT_VALUES)[t] ?? 0), 0);
  }

  function populateReal(m, r) {
    const types = new Array(m.n).fill(null);
    types[m.start] = 'start';
    for (const e of m.exits) types[e] = m.exitType;
    for (let i = 0; i < m.n; i++) if (!types[i]) types[i] = weightedPick(r, distanceRow(m.floor, m.dist[i]) || [['empty', 1]]);
    // at most one hidden exit; tunnels come in pairs
    const evacs = []; for (let i = 0; i < m.n; i++) if (types[i] === 'evac') evacs.push(i);
    evacs.slice(1).forEach(i => { types[i] = 'empty'; });
    if (m.exitType === 'boss' && evacs.length) types[evacs[0]] = 'empty';
    const pair = new Int16Array(m.n).fill(-1);
    const doors = []; for (let i = 0; i < m.n; i++) if (types[i] === 'door') doors.push(i);
    for (let k = 0; k + 1 < doors.length; k += 2) { pair[doors[k]] = doors[k + 1]; pair[doors[k + 1]] = doors[k]; }
    if (doors.length % 2) types[doors[doors.length - 1]] = 'empty';
    return { types, pair };
  }

  function populate(m, r, opts) {
    const o = Object.assign({}, DEFAULT_PARAMS, opts);
    if (o.realMix && !o.mix && D && D.nodeDist && D.nodeDist[m.floor]) return populateReal(m, r);
    const types = new Array(m.n).fill(null);
    types[m.start] = 'start';
    for (const e of m.exits) types[e] = m.exitType;
    const free = () => { const f = []; for (let i = 0; i < m.n; i++) if (!types[i]) f.push(i); return f; };
    const pair = new Int16Array(m.n).fill(-1);
    if (m.floor === 1) types[pick(r, free())] = 'shop';
    if (m.exitType === 'final' && r() < o.pEvac) {
      const cand = free().filter(i => m.dist[i] >= 2);
      if (cand.length) types[pick(r, cand)] = 'evac';
    }
    if (m.n >= 16 && r() < o.pDoor) {
      const f = free();
      const a = pick(r, f);
      const rest = f.filter(i => i !== a && Math.abs(m.R[i] - m.R[a]) + Math.abs(m.C[i] - m.C[a]) >= 3);
      if (rest.length) { const b = pick(r, rest); types[a] = types[b] = 'door'; pair[a] = b; pair[b] = a; }
    }
    const entries = floorMix(m.floor, o.mix);
    for (const i of free()) types[i] = weightedPick(r, entries);
    return { types, pair };
  }

  // ---------- route optimiser (exact, full information) ----------
  // A walk starts at `pos` with `ap`. Entering an uncompleted node completes it.
  // Entering an exit ends the zone. AP 0 away from an exit triggers the pursuit.
  function inRange(m, from, to, range) {
    const dr = Math.abs(m.R[to] - m.R[from]), dc = Math.abs(m.C[to] - m.C[from]);
    if (from === to) return false;
    switch (range) {
      case 'orth2': return (dr === 0 && dc <= 2) || (dc === 0 && dr <= 2);
      case 'orth3': return (dr === 0 && dc <= 3) || (dc === 0 && dr <= 3);
      case 'king': return dr <= 1 && dc <= 1;
      case 'diamond2': return dr + dc <= 2;
      case 'line': return dr === 0 || dc === 0;
      default: return true;
    }
  }
  function partTargets(m, P, from, part, visitedFn) {
    const out = [];
    for (let j = 0; j < m.n; j++) {
      if (j === from) continue;
      const t = P.types[j];
      switch (part.range) {
        case 'noncombat': if (COMBAT.has(t)) continue; break;
        case 'merchant': if (t !== 'shop' && t !== 'scrap') continue; break;
        case 'exit': if (t !== 'final' && t !== 'boss' && t !== 'evac') continue; break;
        case 'battle12': if (!COMBAT.has(t) || !inRange(m, from, j, 'diamond2')) continue; break;
        case 'incident': if (t !== 'incident') continue; break;
        case 'random_noncombat': continue;
        default: if (!inRange(m, from, j, part.range)) continue;
      }
      out.push(j);
    }
    return out;
  }
  const isExitType = t => t === 'final' || t === 'boss' || t === 'evac';

  // problem: { m, P:{types,pair}, val: Float64Array of first-visit values, ap, pos, visited:Uint8Array,
  //            parts:[{part,uses}], params, exitKnown?:Uint8Array (planning: which nodes are known exits) }
  function solve(problem) {
    const { m, P, val } = problem;
    const prm = Object.assign({}, DEFAULT_PARAMS, problem.params);
    const types = P.types;
    const exitKnown = problem.exitKnown || null;
    const isExit = j => isExitType(types[j]) && (!exitKnown || exitKnown[j]);
    const bossFloor = m.exitType === 'boss';
    const pursuit = bossFloor ? prm.bossPursuitIE : prm.pursuitIE;
    const exitPay = (j, ap) => {
      const t = types[j];
      if (t === 'final') return ap * prm.hopeIE + (prm.secrecy >= 16 ? 0 : prm.partIE);
      if (t === 'evac') return ap * prm.carryIE + prm.rarePartIE;
      return ap * prm.hopeIE; // boss
    };
    const parts = (problem.parts || []).map(p => ({ part: p.part, uses: p.uses }));
    const memo = new Map();
    const choice = new Map();
    let lo0 = 0, hi0 = 0;
    for (let i = 0; i < m.n; i++) if (problem.visited && problem.visited[i]) { if (i < 32) lo0 |= (1 << i); else hi0 |= (1 << (i - 32)); }
    const visitedBit = (lo, hi, j) => (j < 32 ? (lo >>> j) & 1 : (hi >>> (j - 32)) & 1);
    const setBit = (lo, hi, j) => (j < 32 ? [lo | (1 << j), hi] : [lo, hi | (1 << (j - 32))]);
    let nodesExpanded = 0;

    function arrive(j, lo, hi, ap, uses, extra) {
      // returns value gained from arriving at j (including the rest of the walk)
      let gain = extra;
      let nap = ap;
      if (!visitedBit(lo, hi, j)) {
        gain += val[j];
        if (types[j] === 'light') nap += 1;
        [lo, hi] = setBit(lo, hi, j);
      }
      if (isExit(j)) return gain + exitPay(j, nap);
      return gain + dfs(j, lo, hi, nap, uses);
    }

    function dfs(pos, lo, hi, ap, uses) {
      const key = lo + ',' + hi + ',' + pos + ',' + ap + ',' + uses;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      memo.set(key, -Infinity); // zero-cost loops (tunnel pairs) gain nothing
      nodesExpanded++;
      let best = pursuit; // voluntary pursuit (or forced when ap = 0)
      let act = null;
      if (ap > 0) {
        for (const j of m.adj[pos]) {
          const v = arrive(j, lo, hi, ap - 1, uses, 0);
          if (v > best) { best = v; act = ['walk', j]; }
        }
      }
      if (types[pos] === 'door' && P.pair[pos] >= 0) {
        const j = P.pair[pos];
        const v = arrive(j, lo, hi, ap, uses, 0);
        if (v > best) { best = v; act = ['door', j]; }
      }
      for (let k = 0; k < parts.length; k++) {
        const left = Math.floor(uses / Math.pow(4, k)) % 4;
        if (!left) continue;
        const part = parts[k].part;
        if (ap < part.ap) continue;
        const nu = uses - Math.pow(4, k);
        const extra = (part.hope ? part.hope * prm.hopeIE : 0) + (part.ingots || 0);
        const nap = ap - part.ap + (part.apGain || 0);
        if (part.range === 'random_noncombat') {
          let cand = [];
          for (let j = 0; j < m.n; j++) if (j !== pos && !COMBAT.has(types[j]) && !isExitType(types[j]) && types[j] !== 'start' && !visitedBit(lo, hi, j)) cand.push(j);
          if (!cand.length) for (let j = 0; j < m.n; j++) if (j !== pos && !COMBAT.has(types[j]) && !isExitType(types[j])) cand.push(j);
          if (!cand.length) continue;
          let s = 0;
          for (const j of cand) s += arrive(j, lo, hi, nap, nu, extra);
          const v = s / cand.length;
          if (v > best) { best = v; act = ['part', k, -1]; }
          continue;
        }
        // landing on a finished node is never better than landing on a fresh one in range,
        // so only fresh nodes and exits are tried; long-range parts try the 10 most valuable.
        let targets = partTargets(m, P, pos, part).filter(j => isExit(j) || !visitedBit(lo, hi, j));
        if (targets.length > 12) {
          const ex = targets.filter(isExit);
          const rest = targets.filter(j => !isExit(j)).sort((a, b) => val[b] - val[a]).slice(0, parts[k].uses >= 3 ? 6 : 10);
          targets = ex.concat(rest);
        }
        for (const j of targets) {
          const v = arrive(j, lo, hi, nap, nu, extra);
          if (v > best) { best = v; act = ['part', k, j]; }
        }
      }
      memo.set(key, best);
      choice.set(key, act);
      return best;
    }

    let uses0 = 0;
    parts.forEach((p, k) => { uses0 += Math.min(3, p.uses) * Math.pow(4, k); });
    const pos0 = problem.pos ?? m.start;
    if (!(problem.visited && problem.visited[pos0])) [lo0, hi0] = setBit(lo0, hi0, pos0);
    const value = dfs(pos0, lo0, hi0, problem.ap, uses0);

    // reconstruct the planned walk
    const path = [{ node: pos0, how: 'start' }];
    let pos = pos0, lo = lo0, hi = hi0, ap = problem.ap, uses = uses0;
    for (let guard = 0; guard < 64; guard++) {
      const key = lo + ',' + hi + ',' + pos + ',' + ap + ',' + uses;
      const act = choice.get(key);
      if (!act) { path.push({ node: pos, how: 'pursuit' }); break; }
      let j, cost = 0;
      if (act[0] === 'walk') { j = act[1]; cost = 1; }
      else if (act[0] === 'door') { j = act[1]; }
      else {
        const part = parts[act[1]].part;
        if (act[2] < 0) { path.push({ node: pos, how: 'part', part: part.key, random: true }); break; }
        j = act[2]; cost = part.ap; uses -= Math.pow(4, act[1]);
        ap += part.apGain || 0;
      }
      ap -= cost;
      if (!visitedBit(lo, hi, j)) { if (types[j] === 'light') ap += 1; [lo, hi] = setBit(lo, hi, j); }
      path.push({ node: j, how: act[0] === 'part' ? 'part' : act[0], part: act[0] === 'part' ? parts[act[1]].part.key : undefined, ap });
      if (isExit(j)) break;
      pos = j;
    }
    return { value, path, first: path[1] || null, states: nodesExpanded };
  }

  // ---------- one zone under fog ----------
  function valuesFor(P, values, floor) {
    const v = values || DEFAULT_VALUES;
    const out = new Float64Array(P.types.length);
    P.types.forEach((t, i) => { out[i] = v[t] ?? 0; });
    return out;
  }

  // Which nodes the player can see: everything reachable through completed or empty
  // nodes, plus the first unfinished node on each path. 羽瞰点 add their own radius.
  function revealFrom(m, P, pos, visited, seen) {
    const transparent = j => visited[j] || P.types[j] === 'empty' || P.types[j] === 'door' || P.types[j] === 'start';
    const q = [pos];
    const mark = new Uint8Array(m.n);
    mark[pos] = 1;
    let fresh = 0;
    const see = j => { if (!seen[j]) { seen[j] = 1; fresh++; if (P.types[j] === 'light') fresh += radius(j, 1); } };
    const radius = (j, r) => {
      let f = 0;
      for (let k = 0; k < m.n; k++) if (!seen[k] && Math.abs(m.R[k] - m.R[j]) + Math.abs(m.C[k] - m.C[j]) <= r) { seen[k] = 1; f++; }
      return f;
    };
    see(pos);
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      for (const j of m.adj[i]) {
        if (mark[j]) continue;
        mark[j] = 1;
        see(j);
        if (transparent(j)) q.push(j);
        if (P.types[i] === 'door' && P.pair[i] >= 0 && !mark[P.pair[i]]) { mark[P.pair[i]] = 1; see(P.pair[i]); q.push(P.pair[i]); }
      }
    }
    return { fresh, radius };
  }

  // Plays one zone. knowsTemplate: the player recognises the layout and knows where the
  // exits are. Unseen nodes are valued at their category average (凶戾 / 诡秘 icons).
  function playZone(m, P, opt) {
    const o = Object.assign({ ap: m.tpl ? D.floors[m.floor - 1].ap : 5, knowsTemplate: true, fullInfo: false, values: DEFAULT_VALUES, parts: [], params: {} }, opt);
    const prm = Object.assign({}, DEFAULT_PARAMS, o.params);
    const actual = valuesFor(P, o.values);
    const cat = categoryMeans(m.floor, o.values, prm.mix);
    const visited = new Uint8Array(m.n);
    const seen = new Uint8Array(m.n);
    const log = { moves: 0, battles: 0, noncombat: 0, reveals: 0, merchants: 0, partMoves: 0, lights: 0, revealEvents: 0, visited: [], nodeValue: 0, exitPay: 0, partBonus: 0 };
    let pos = m.start, ap = o.ap, total = 0;
    visited[pos] = 1;
    { const fr = revealFrom(m, P, pos, visited, seen).fresh; log.reveals += fr; if (fr > 0) log.revealEvents++; }
    // exits shown in advance (at 保密等级 3+ one of several is hidden)
    const shownExits = new Uint8Array(m.n);
    m.exits.forEach((e, k) => { if (!(prm.secrecy >= 3 && m.exits.length > 1 && k === m.exits.length - 1)) shownExits[e] = 1; });
    let parts = o.parts.map(p => (p.part ? { part: p.part, uses: p.uses } : { part: p, uses: p.uses }));
    const path = [{ node: pos, how: 'start', ap }];
    let outcome = null;
    for (let step = 0; step < 60; step++) {
      // belief
      const bel = new Float64Array(m.n);
      const exitKnown = new Uint8Array(m.n);
      const btypes = P.types.slice();
      for (let i = 0; i < m.n; i++) {
        const known = o.fullInfo || seen[i] || (o.knowsTemplate && m.exits.includes(i)) || shownExits[i];
        if (known) { bel[i] = actual[i]; if (isExitType(P.types[i])) exitKnown[i] = 1; }
        else {
          const combat = COMBAT.has(P.types[i]);
          const ded = o.deduce !== false ? deducedValue(m.floor, m.dist[i], combat, o.values) : null;
          bel[i] = ded != null ? ded : combat ? cat.combat : cat.non;
          btypes[i] = combat ? 'battle' : (P.types[i] === 'light' ? 'empty' : 'incident');
          if (isExitType(P.types[i])) btypes[i] = 'incident';
        }
      }
      const plan = solve({ m, P: { types: btypes, pair: P.pair }, val: bel, ap, pos, visited, parts, params: prm, exitKnown });
      const nx = plan.first;
      if (!nx || nx.how === 'pursuit') { outcome = 'pursuit'; log.exitPay = (m.exitType === 'boss' ? prm.bossPursuitIE : prm.pursuitIE); total += log.exitPay; path.push({ node: pos, how: 'pursuit', ap }); break; }
      // execute the first action
      let j = nx.node;
      if (nx.how === 'walk') { ap -= 1; log.moves++; }
      else if (nx.how === 'part') {
        const k = parts.findIndex(p => p.part.key === nx.part && p.uses > 0);
        const part = parts[k].part;
        ap -= part.ap; ap += part.apGain || 0; parts[k].uses--; log.partMoves++; log.moves++;
        if (part.hope) { total += part.hope * prm.hopeIE; log.partBonus += part.hope * prm.hopeIE; }
        if (part.ingots) { total += part.ingots; log.partBonus += part.ingots; }
        if (nx.random) {
          const cand = [];
          for (let i = 0; i < m.n; i++) if (i !== pos && !COMBAT.has(P.types[i]) && !isExitType(P.types[i]) && P.types[i] !== 'start' && !visited[i]) cand.push(i);
          j = cand.length ? cand[Math.floor((o.rand || Math.random)() * cand.length)] : pos;
        }
      }
      if (!visited[j]) {
        visited[j] = 1;
        total += actual[j];
        log.nodeValue += actual[j];
        const t = P.types[j];
        if (t === 'light') { ap += 1; log.lights++; const fr = revealFrom(m, P, j, visited, seen).radius(j, 2); log.reveals += fr; if (fr > 0) log.revealEvents++; }
        if (COMBAT.has(t)) log.battles++; else if (!isExitType(t) && t !== 'empty' && t !== 'door') log.noncombat++;
        if (t === 'shop' || t === 'scrap') log.merchants++;
        log.visited.push(t);
      }
      path.push({ node: j, how: nx.how, ap, part: nx.part });
      pos = j;
      { const fr = revealFrom(m, P, pos, visited, seen).fresh; log.reveals += fr; if (fr > 0) log.revealEvents++; }
      if (isExitType(P.types[pos])) {
        const t = P.types[pos];
        const pay = t === 'final' ? ap * prm.hopeIE + (prm.secrecy >= 16 ? 0 : prm.partIE) : t === 'evac' ? ap * prm.carryIE + prm.rarePartIE : ap * prm.hopeIE;
        total += pay;
        log.exitPay = pay;
        outcome = t;
        break;
      }
      if (ap <= 0 && !(P.types[pos] === 'door')) { outcome = 'pursuit'; log.exitPay = (m.exitType === 'boss' ? prm.bossPursuitIE : prm.pursuitIE); total += log.exitPay; path.push({ node: pos, how: 'pursuit', ap: 0 }); break; }
    }
    return { value: total, outcome, apLeft: ap, path, log, seen, partsLeft: parts.filter(p => p.uses > 0) };
  }

  // ---------- designer price index ----------
  // Linear least squares over designer menus (options roughly equal) and fixed shop prices.
  const PRICE_VARS = ['hope', 'ap', 'maxHP', 'hp', 'shield', 'slot', 'carry', 'proc', 'colCommon', 'colRandom', 'colRare'];
  function fitPrices(opts) {
    const o = Object.assign({ menus: D.menus.map(m => m.id), anchorWeight: 0.5, iterations: 6 }, opts);
    const menus = D.menus.filter(m => o.menus.includes(m.id));
    const nv = PRICE_VARS.length, nm = menus.length, N = nv + nm;
    let mu = menus.map(() => 10);
    let x = null;
    for (let it = 0; it < o.iterations; it++) {
      const A = [], b = [], w = [];
      menus.forEach((menu, mi) => {
        for (const opt of menu.options) {
          const row = new Array(N).fill(0);
          let rhs = 0;
          for (const [k, c] of Object.entries(opt.v)) {
            if (k === 'ingot') rhs -= c; else row[PRICE_VARS.indexOf(k)] += c;
          }
          row[nv + mi] = -1;
          A.push(row); b.push(rhs); w.push(1 / Math.max(2, Math.abs(mu[mi])) ** 2);
        }
      });
      for (const an of D.anchors) {
        const row = new Array(N).fill(0);
        for (const [k, c] of Object.entries(an.v)) row[PRICE_VARS.indexOf(k)] += c;
        A.push(row); b.push(an.price); w.push(o.anchorWeight / an.price ** 2);
      }
      // tiny ridge keeps unidentified prices finite
      for (let k = 0; k < N; k++) { const row = new Array(N).fill(0); row[k] = 1; A.push(row); b.push(0); w.push(1e-6); }
      x = lstsq(A, b, w);
      mu = x.slice(nv);
    }
    const price = Object.fromEntries(PRICE_VARS.map((k, i) => [k, x[i]]));
    const report = menus.map((menu, mi) => ({
      id: menu.id, name: menu.name, value: x[nv + mi],
      options: menu.options.map(opt => {
        let v = 0;
        for (const [k, c] of Object.entries(opt.v)) v += k === 'ingot' ? c : c * price[k];
        return { label: opt.label, value: v, gap: v - x[nv + mi] };
      }),
    }));
    return { price, report };
  }
  function lstsq(A, b, w) {
    const n = A[0].length;
    const M = Array.from({ length: n }, () => new Array(n + 1).fill(0));
    for (let r = 0; r < A.length; r++) {
      const row = A[r], wr = w[r];
      for (let i = 0; i < n; i++) {
        if (!row[i]) continue;
        for (let j = 0; j < n; j++) M[i][j] += wr * row[i] * row[j];
        M[i][n] += wr * row[i] * b[r];
      }
    }
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c] || 1e-12;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / d;
        if (!f) continue;
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / (row[i] || 1e-12));
  }

  // ---------- natural items ----------
  // Estimate after one zone, given that zone's action counts.
  function naturalGrowth(item, act) {
    const g = item.grow || {};
    let d = 0;
    if (g.battle) d += g.battle * (act.battles || 0);
    if (g.perfect) d += g.perfect * (act.perfect ?? act.battles ?? 0);
    if (g.reveal) d += g.reveal * (act.reveals || 0);
    if (g.recruit) d += g.recruit * (act.recruits || 0);
    if (g.noncombat) d += g.noncombat * (act.noncombat || 0);
    if (g.merchant) d += g.merchant * (act.merchants || 0);
    if (g.part) d += g.part * (act.parts || 0);
    if (g.move) d += g.move * (act.moves || 0);
    if (g.distance) d += g.distance * (act.distance ?? act.moves ?? 0);
    const cost = (item.costPerMove || 0) * (act.moves || 0);
    return { delta: d, cost };
  }

  // Monte Carlo of trading at 秘境行商 over zones 2..5.
  // policy: { capacity, reserved (slots kept for movement parts), trade (多边贸易 bonus), keep (item keys allowed) }
  function tradeRun(r, cfg) {
    const c = Object.assign({ capacity: 10, reserved: 3, tradeBonus: false, startIngots: 12, incomePerZone: 10, visitsPerZone: [0, 1, 1, 1, 1], acts: null, sprayStep: 3 }, cfg);
    const items = [];
    let ingots = c.startIngots, profit = 0, bought = 0, soldBonus = 0, spent = 0;
    const byItem = {};
    const nat = Object.fromEntries(D.naturals.map(n => [n.key, n]));
    const layouts = D.shopLayouts;
    function offers() {
      const shop = pick(r, layouts);
      const lay = weightedPick(r, shop.layouts.map(l => [l, l.probability]));
      const pool = Object.entries(shop.offer_rates).filter(([name]) => D.naturals.some(n => n.name === name));
      const out = [];
      for (let k = 0; k < lay.natural; k++) {
        const name = weightedPick(r, pool);
        const it = D.naturals.find(n => n.name === name);
        if (it && it.buy) out.push(it);
      }
      return out;
    }
    const zones = [1, 2, 3, 4, 5];
    for (const z of zones) {
      ingots += c.incomePerZone;
      const act = c.acts ? c.acts[z - 1] : { battles: 3, perfect: 2.6, reveals: 10, recruits: 1.5, noncombat: 3, merchants: 1, parts: 1.5, moves: 7 };
      const visits = c.visitsPerZone[z - 1] || 0;
      const remainingZones = 5 - z;
      for (let v = 0; v < visits; v++) {
        const last = z === 5 && v === visits - 1;
        // sell: everything on the last visit, plus items that will lose value
        let soldHere = 0;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          const g = naturalGrowth(nat[it.key], act).delta;
          if (last || g < 0) {
            ingots += it.value; profit += it.value - it.paid; soldHere++;
            (byItem[it.key] = byItem[it.key] || { n: 0, profit: 0 }).profit += it.value - it.paid;
            items.splice(i, 1);
          }
        }
        if (c.tradeBonus && soldHere >= 3) { ingots += 8 * Math.floor(soldHere / 3); soldBonus += 8 * Math.floor(soldHere / 3); }
        if (last) break;
        // buy: best expected gain per slot, if a later merchant is likely
        const slots = c.capacity - c.reserved - items.length;
        const offerList = offers().map(it => {
          let gain = 0;
          for (let zz = z; zz <= 5; zz++) {
            const a2 = c.acts ? c.acts[zz - 1] : act;
            const g = naturalGrowth(it, a2);
            gain += (zz === z ? 0.5 : 1) * (g.delta - g.cost);
          }
          return { it, gain: it.base + gain - it.buy };
        }).filter(x => x.gain > 0).sort((a, b) => b.gain - a.gain);
        let free = slots;
        for (const { it } of offerList) {
          if (free <= 0 || ingots < it.buy) continue;
          ingots -= it.buy; spent += it.buy; bought++;
          items.push({ key: it.key, value: it.base, paid: it.buy });
          (byItem[it.key] = byItem[it.key] || { n: 0, profit: 0 }).n++;
          free--;
        }
      }
      // items grow during the rest of the zone
      for (const it of items) {
        const n = nat[it.key];
        if (n.grow.moveRandom) {
          for (let k = 0; k < (act.moves || 0); k++) it.value = Math.max(0, it.value + Math.round((r() * 2 - 1) * c.sprayStep));
        } else {
          const g = naturalGrowth(n, act);
          it.value = Math.max(0, it.value + g.delta);
          ingots -= g.cost;
        }
        if (n.breaksOnImperfect && r() > Math.pow(act.perfectRate ?? 0.9, act.battles || 0)) it.value = 0;
      }
    }
    const stranded = items.reduce((s, it) => s + it.paid, 0);
    return { profit: profit - stranded + soldBonus, gross: profit, soldBonus, stranded, bought, spent, byItem };
  }

  // ---------- small stats helpers ----------
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  function quantile(a, q) {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return s[lo] + (s[hi] - s[lo]) * (p - lo);
  }

  const BF = {
    D, rng, pick, weightedPick, MAPS, mapsOnFloor, buildMap, geometry, bfs,
    COMBAT, TYPE_INFO, DEFAULT_MIX, DEFAULT_VALUES, DEFAULT_PARAMS, floorMix, categoryMeans,
    populate, populateReal, deduce, deducedValue, solve, valuesFor, playZone, revealFrom, fitPrices, PRICE_VARS,
    naturalGrowth, tradeRun, mean, quantile, isExitType,
  };
  root.BF = BF;
  if (typeof module !== 'undefined' && module.exports) module.exports = BF;
})(typeof globalThis !== 'undefined' ? globalThis : this);
