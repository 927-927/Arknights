// Builds site/js/data.js from the downloaded sources in research/sources.
// Usage: node research/scripts/build_data.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'research', 'sources');
const OUT = path.join(ROOT, 'site', 'js', 'data.js');

const templates = JSON.parse(fs.readFileSync(path.join(SRC, 'maa', 'map_templates.json'), 'utf8')).templates;
const market = JSON.parse(fs.readFileSync(path.join(SRC, 'maa', 'scrap_market.json'), 'utf8'));

const maps = templates
  .map(t => ({
    id: t.id,
    floor: t.floor,
    rows: t.rows,
    cols: t.columns,
    start: t.start,
    exits: t.terminals,
    exitType: t.terminal_type === 'battle_boss' ? 'boss' : 'final',
    edges: t.edges.map(([a, b]) => [a[0], a[1], b[0], b[1]]),
  }))
  .sort((a, b) => a.floor - b.floor || a.id.localeCompare(b.id));

const buyPrice = Object.fromEntries(market.scraps.map(s => [s.name, s.price ?? null]));

// Movement parts. range: 'orth2' cross radius 2, 'king' 8 neighbours, 'diamond2' Manhattan<=2,
// 'orth3' cross radius 3, 'line' same row or column, 'any', 'noncombat', 'merchant', 'exit',
// 'battle12' combat nodes within Manhattan 2, 'incident' 不期而遇 nodes, 'random_noncombat'.
// Effects and use counts: BWIKI 引擎配件目录. Buy prices: MAA scrap_market.json.
const processing = [
  { key: 'wheel', name: '报废轮子', en: 'Scrap Wheel', rarity: 1, range: 'orth2', uses: 1, ap: 1 },
  { key: 'prosthetic', name: '报废假肢', en: 'Scrap Prosthetic', rarity: 1, range: 'king', uses: 1, ap: 1 },
  { key: 'engine', name: '标准引擎', en: 'Standard Engine', rarity: 1, range: 'king', uses: 3, ap: 1 },
  { key: 'spring', name: '重弹簧', en: 'Heavy Spring', rarity: 2, range: 'diamond2', uses: 1, ap: 0, floorOnly: true },
  { key: 'cushion', name: '气垫底座', en: 'Air-cushion Base', rarity: 1, range: 'diamond2', uses: 2, ap: 1 },
  { key: 'exo', name: '试作外骨骼', en: 'Prototype Exoskeleton', rarity: 1, range: 'orth3', uses: 2, ap: 1 },
  { key: 'bagua', name: '小八界', en: 'Little Eight Realms', rarity: 1, range: 'random_noncombat', uses: 1, ap: 0, floorOnly: true },
  { key: 'jetpack', name: '一次性喷气背包', en: 'Disposable Jetpack', rarity: 2, range: 'any', uses: 1, ap: 0 },
  { key: 'snowmelt', name: '老妈妈的融雪', en: "Old Mama's Snowmelt", rarity: 2, range: 'noncombat', uses: 1, ap: 1, hope: 2 },
  { key: 'tentacle', name: '坎诺特的触须', en: "Kanot's Tentacle", rarity: 2, range: 'merchant', uses: 2, ap: 1, ingots: 4 },
  { key: 'principle', name: '结构性原理', en: 'Structural Principle', rarity: 3, range: 'any', uses: 3, ap: 1 },
  { key: 'remote', name: '“简易遥控器”', en: 'Simple Remote', rarity: 3, range: 'king', uses: 1, ap: 0, apGain: 3 },
  { key: 'seat', name: '紧急逃生座椅', en: 'Ejection Seat', rarity: 2, range: 'exit', uses: 1, ap: 1 },
  { key: 'wheelfb', name: '力反馈方向盘', en: 'Force-feedback Wheel', rarity: 3, range: 'line', uses: 2, ap: 1 },
  { key: 'whistle', name: '鸣笛', en: 'Whistle', rarity: 1, range: 'battle12', uses: 1, ap: 1 },
  { key: 'express', name: '坎诺特特快', en: 'Kanot Express', rarity: 3, range: 'incident', uses: 1, ap: 1 },
].map(p => ({ ...p, buy: buyPrice[p.name] ?? null, sell: 1 }));

// Natural items (自然物). base = 估价 when acquired (BWIKI 价格). buy = MAA shop price (2x base).
// grow: what raises the estimate. Units are per trigger.
const naturals = [
  { key: 'seed', name: '种子', en: 'Seed', base: 2, grow: {} , note: 'cultivate at 秘境行商' },
  { key: 'bloodcap', name: '血蕈', en: 'Blood Mushroom', base: 2, grow: { battle: 2 } },
  { key: 'fogweed', name: '雾滚草', en: 'Fog Tumbleweed', base: 2, grow: { reveal: 1 } },
  { key: 'corn', name: '回声玉米', en: 'Echo Corn', base: 4, grow: { recruit: 3 } },
  { key: 'spray', name: '浪花', en: 'Spray', base: 3, grow: { moveRandom: 1 } },
  { key: 'frost', name: '霜晶树', en: 'Frost Crystal Tree', base: 6, grow: { perfect: 4 }, breaksOnImperfect: true },
  { key: 'moss', name: '多生苔藓', en: 'Prolific Moss', base: 1, grow: { part: 1 }, spawns: { mossball: 3 } },
  { key: 'mossball', name: '枯苔藓球', en: 'Dry Moss Ball', base: 2, grow: {} },
  { key: 'vine', name: '板藤', en: 'Plank Vine', base: 8, grow: { part: 4 } },
  { key: 'homefruit', name: '恋家果', en: 'Homesick Fruit', base: 32, grow: { move: -2 } },
  { key: 'truffle', name: '光彩松露', en: 'Lustrous Truffle', base: 32, grow: {} },
  { key: 'cage', name: '笼控器', en: 'Cage Controller', base: 16, grow: {}, note: 'used by events' },
  { key: 'thingrass', name: '薄葬草', en: 'Thin-burial Grass', base: 3, grow: {} },
  { key: 'lifedeath', name: '生逝', en: 'Life-and-Passing', base: 1, grow: { move: 3 }, costPerMove: 1 },
  { key: 'orange', name: '血橙', en: 'Blood Orange', base: 2, grow: { noncombat: 2 } },
  { key: 'fluff', name: '旅行绒', en: 'Travel Fluff', base: 1, grow: { distance: 1 } },
  { key: 'lovegrass', name: '恋心草', en: 'Lovesick Grass', base: 4, grow: { battle: 6 }, leakPenalty: 1 },
  { key: 'nofate', name: '无缘果', en: 'Fateless Fruit', base: 4, grow: { merchant: 10 } },
  { key: 'pod', name: '种荚', en: 'Seed Pod', base: 3, grow: {}, note: '+1 seed per new zone' },
].map(n => ({ ...n, buy: buyPrice[n.name] ?? null }));

const concepts = [
  { key: 'bird', name: '白模鸟', effect: 'part-move into a battle: ASPD +50 for it, then 1 random collectible (once)' },
  { key: 'dog', name: '白模狗', effect: 'part-move into a non-combat node: 1 random collectible (once)' },
  { key: 'fish', name: '白模鱼', effect: 'part-move: +3 shield (once)' },
  { key: 'liberi', name: '涂装黎博利', effect: 'part-move into a battle: ASPD +35 for it' },
  { key: 'perro', name: '涂装佩洛', effect: 'part-move into 得偿所愿: +1 random collectible' },
  { key: 'aegir', name: '涂装阿戈尔', effect: 'part-move into 失与得: +2 random collectibles' },
  { key: 'lorenz', name: '洛伦茨之眼', effect: 'part-move into 羽瞰点: reveal the whole map (once)' },
  { key: 'kanotw', name: '白模坎诺特', effect: 'sell a natural worth >=50: 2 precious collectibles (once)' },
  { key: 'kanotp', name: '涂装坎诺特', effect: 'part-move into 安全的角落: +1 random 加工品' },
].map(c => ({ ...c, buy: buyPrice[c.name] ?? null }));

const floors = [
  { n: 1, name: '玻利瓦尔肤层', ap: 5, exit: 'final' },
  { n: 2, name: '甜美的伤口', ap: 6, exit: 'final' },
  { n: 3, name: '血色空脉', ap: 7, exit: 'boss' },
  { n: 4, name: '受害者腐殖', ap: 8, exit: 'final' },
  { n: 5, name: '卡德霍之颅', ap: 8, exit: 'boss' },
];

// 保密等级: enemy = per-floor enemy ATK/HP increase (%), score = 得分效率 (%). BWIKI 保密难度 table.
const secrecy = [
  [0, 0, 0, '初始生命值上限更高；失败后下次获得“特勤任务影像”'],
  [1, 5, 0, '初始目标生命上限 -2'],
  [2, 10, 0, '实托邦开始生成'],
  [3, 15, 0, '部分险路尽头不再提前揭示'],
  [4, 20, 0, '出现“居民”据点；失败不再给特勤任务影像'],
  [5, 25, 1, '所有敌人最大生命 +30%'],
  [6, 30, 2, '实托邦提升至中期，追加实托邦·方针'],
  [7, 35, 3, '零件箱初始容量 -2'],
  [8, 40, 5, '精英及领袖敌人攻击力 +15%'],
  [9, 45, 6, '进入下一区域时损失 10% 源石锭'],
  [10, 50, 7, '可同时部署 -1，初始目标生命上限 -2'],
  [11, 50, 8, '领袖敌人受到伤害 -20%'],
  [12, 50, 10, '实托邦提升至晚期，范围扩大'],
  [13, 50, 12, '非初始招募五星希望 +1；首领强化'],
  [14, 50, 16, '猎犬proto进入目标点后行动力 -1；源阶方强化'],
  [15, 50, 20, '非初始招募六星希望 +1；猎犬proto为首领回复'],
  [16, 50, 25, '险路尽头不再给加工品；行商刷新 +4'],
].map(([level, score, enemy, effect]) => ({ level, score, enemy, effect }));

// Designer menus and fixed trades, in the game's own units. Used by the price-index fit.
// Each 'menu' lists options a player picks between; the fit treats them as roughly equal value.
const menus = [
  { id: 'opening', name: '开局支援 (区域相关)', source: 'BWIKI 区域相关',
    options: [
      { label: '未编号物: 1 common collectible', v: { colCommon: 1 } },
      { label: '调查预付款: +8 ingots', v: { ingot: 8 } },
      { label: '空间租赁: −6 ingots, +2 box slots', v: { ingot: -6, slot: 2 } },
      { label: '退行补偿: −2 max HP, +1 random collectible', v: { maxHP: -2, colRandom: 1 } },
      { label: '林间代步: 1 movement part', v: { proc: 1 } },
      { label: '巢寄生: −1 box slot, +1 rare collectible', v: { slot: -1, colRare: 1 } },
    ] },
  { id: 'gold', name: '金色凝滞 (安全的角落, 3 of 7 shown)', source: 'BWIKI 调查记录',
    options: [
      { label: '+3 max HP', v: { maxHP: 3 } },
      { label: '+1 carry slot', v: { carry: 1 } },
      { label: '+3 hope', v: { hope: 3 } },
      { label: '+2 AP', v: { ap: 2 } },
      { label: '+1 box slot', v: { slot: 1 } },
    ] },
  { id: 'sunny', name: '桑尼的邀请', source: 'BWIKI 调查记录',
    options: [ { label: '+3 hope', v: { hope: 3 } }, { label: '+10 ingots', v: { ingot: 10 } } ] },
  { id: 'taste', name: '色味不同源', source: 'BWIKI 调查记录',
    options: [ { label: '+3 max HP', v: { maxHP: 3 } }, { label: '+5 shield', v: { shield: 5 } } ] },
  { id: 'silent', name: '沉寂之屋 (two ways to pay for 笼控器)', source: 'BWIKI 调查记录',
    options: [ { label: '−2 HP', v: { hp: -2 } }, { label: '−8 ingots', v: { ingot: -8 } } ] },
  { id: 'legacy', name: '襁褓生灵 start menu', source: 'BWIKI 零件与零件箱',
    options: [
      { label: '襁褓天马: +1 AP on each of 5 zones', v: { ap: 5 } },
      { label: '襁褓金乌: 3 random collectibles on floor Ⅲ', v: { colRandom: 3 } },
    ] },
  { id: 'tree', name: '未涉足之树 (先行一步)', source: 'BWIKI 调查记录',
    options: [ { label: 'rest: +2 hope', v: { hope: 2 } }, { label: 'send a 6★: free promotion (3 hope) + 1 part', v: { hope: 3, proc: 1 } } ] },
];

// Fixed prices, in ingots. Treated as anchors with lower weight than menus.
const anchors = [
  { label: 'Shop collectible, common tier', v: { colCommon: 1 }, price: 8, source: 'MAA shopping.json (41 items at 8)' },
  { label: 'Shop collectible, middle tier', v: { colRare: 1 }, price: 12, source: 'MAA shopping.json (99 items at 12)' },
  { label: 'Movement part at 秘境行商 (offer-weighted)', v: { proc: 1 }, price: 4.4, source: 'MAA scrap_market.json' },
];

// One-way trades offered by events and nodes (deals, not used in the fit).
const trades = [
  { from: '4 ingots', to: '1 random collectible', where: '敲动杠杆' },
  { from: '10 ingots', to: '3 random collectibles', where: '敲动杠杆' },
  { from: '4 ingots', to: '1 random part', where: '货从口出' },
  { from: '4 ingots', to: 'upgrade a shop’s collectibles', where: '无人商店' },
  { from: 'leftover AP', to: 'equal hope (1:1)', where: '险路尽头 / 险路恶敌' },
  { from: 'leftover AP', to: 'carried to next zone + rare part', where: '险路小径 (三重身)' },
  { from: '3 AP or 2 movement parts', to: '追忆 collectible', where: '愈创之心' },
  { from: '笼控器', to: '+5 AP', where: '愈创之心' },
  { from: 'half current HP', to: '+5 AP (instead of +2 free)', where: '沉重的契约' },
  { from: '4 ingots', to: 'one emergency operator for one battle', where: '应急助力' },
  { from: '50 ingots', to: 'reveal the true 命运所指', where: '好奇心与死 (ending 2)' },
  { from: '10 ingots', to: '谒日之祈 (ending 4 key)', where: '险路尽头 floors Ⅰ–Ⅱ' },
  { from: '3 sold parts at one merchant', to: '+8 ingots', where: '多边贸易分队' },
];

const hopeCost = { recruit: { 4: 0, 5: 2, 6: 6 }, promote: { 4: 1, 5: 1, 6: 3 } };
const start = { hp: 8, hope: 6, ingots: 6, carry: 6, ticketCap: 3, box: 10 };

const data = {
  generated: new Date().toISOString().slice(0, 10),
  sources: {
    maps: 'MaaAssistantArknights resource/roguelike/BlackFlow/map_templates.json (AGPL-3.0)',
    market: 'MaaAssistantArknights resource/roguelike/BlackFlow/scrap_market.json (AGPL-3.0)',
    wiki: 'BWIKI 明日方舟WIKI 沉沦者的黑流树海 and subpages',
  },
  maps, floors, processing, naturals, concepts, secrecy, menus, anchors, trades, hopeCost, start,
  shopLayouts: market.shop_types,
  refreshCosts: market.refresh_costs,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, '/* Generated by research/scripts/build_data.js. Do not edit by hand. */\n' +
  '(function (root) { root.BF_DATA = ' + JSON.stringify(data) + ';\n' +
  "if (typeof module !== 'undefined' && module.exports) module.exports = root.BF_DATA; })(typeof globalThis !== 'undefined' ? globalThis : this);\n");
console.log('wrote', OUT, (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB', maps.length, 'maps');
