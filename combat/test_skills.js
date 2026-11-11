// node combat/test_skills.js : one line per passed check, non-zero exit on the first failure.
'use strict';
const assert = require('node:assert');
const S = require('./skills.js');
const O = require('./operators.js');

let n = 0;
const ok = (name, fn) => { fn(); console.log(`ok ${++n} - ${name}`); };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} expected ${b}, got ${a}`);
const ST = O.table('skill_table');

// ---------- synthetic specs (the automaton only reads these fields) ----------
const spec = o => Object.assign({ id: 'test', name: 'test', level: 1, trigger: 'MANUAL', spType: 'TIME', spCost: 25, initSp: 10,
  duration: 8, instant: null, dpOverDuration: 0, fidelity: 'approx', notes: [], charges: 1, spRate: 1, ammo: 0, stages: null, onDeploy: false }, o);
const run = (sp, st, seconds, dt = 0.1) => { const out = []; for (let k = 1; k <= Math.round(seconds / dt); k++) { const r = S.skillTick(sp, st, dt); if (r) out.push([k, r]); } return out; };

ok('skillInit: {sp: initSp, active: false, remaining: 0, uses: 0}; initSp capped at spCost x charges', () => {
  assert.deepStrictEqual(S.skillInit(spec()), { sp: 10, active: false, remaining: 0, uses: 0 });
  assert.strictEqual(S.skillInit(spec({ initSp: 99 })).sp, 25);
  assert.strictEqual(S.skillInit(spec({ initSp: 99, charges: 3 })).sp, 75);
});
ok('TIME sp: initSp 10, spCost 25 -> ready after exactly 15 s at dt 0.1 (149 ticks not ready, 150 ready), also at dt 1/30', () => {
  const sp = spec(), st = S.skillInit(sp);
  run(sp, st, 14.9); assert.ok(!S.skillReady(sp, st), 'not ready at 14.9 s'); near(st.sp, 24.9);
  run(sp, st, 0.1); assert.ok(S.skillReady(sp, st), 'ready at 15 s');
  const st2 = S.skillInit(sp); for (let k = 0; k < 450; k++) S.skillTick(sp, st2, 1 / 30);
  assert.ok(S.skillReady(sp, st2), 'ready after 450 ticks of 1/30 s');
  run(sp, st, 100); assert.strictEqual(st.sp, 25, 'sp capped at spCost');
  const slow = spec({ spRate: 0.5 }), s3 = S.skillInit(slow); run(slow, s3, 29.9); assert.ok(!S.skillReady(slow, s3)); run(slow, s3, 0.1); assert.ok(S.skillReady(slow, s3));
});
ok('skillActivate: consumes spCost, sets active and remaining = duration, uses + 1; throws when not ready', () => {
  const sp = spec({ initSp: 25 }), st = S.skillInit(sp);
  assert.deepStrictEqual(S.skillActivate(sp, st), {});
  assert.deepStrictEqual(st, { sp: 0, active: true, remaining: 8, uses: 1 });
  assert.throws(() => S.skillActivate(sp, st), /not ready/);
  assert.ok(!S.skillReady(sp, st), 'not ready while active');
});
ok('no SP gain while active; duration countdown returns "ended" exactly once (tick 80 of 0.1 s for 8 s), then charging resumes', () => {
  const sp = spec({ initSp: 25 }), st = S.skillInit(sp);
  S.skillActivate(sp, st);
  const ev = run(sp, st, 7.9);
  assert.deepStrictEqual(ev, []); assert.strictEqual(st.sp, 0, 'no SP while active'); assert.ok(st.active);
  const ev2 = run(sp, st, 0.1);
  assert.deepStrictEqual(ev2, [[1, 'ended']]); assert.ok(!st.active); assert.ok(st.sp < 1e-6);
  const ev3 = run(sp, st, 30);
  assert.deepStrictEqual(ev3, [], '"ended" is returned once'); assert.strictEqual(st.sp, 25);
  // ATTACK / HIT counters do not charge while active either
  const a = spec({ spType: 'ATTACK', initSp: 25 }), sa = S.skillInit(a); S.skillActivate(a, sa); S.skillOnAttack(a, sa); assert.strictEqual(sa.sp, 0);
  const h = spec({ spType: 'HIT', initSp: 25 }), sh = S.skillInit(h); S.skillActivate(h, sh); S.skillOnHit(h, sh); assert.strictEqual(sh.sp, 0);
});
ok('a tick that crosses the end charges SP for the part after the end (dt 0.3 on a 1 s skill: 0.2 s of SP)', () => {
  const sp = spec({ initSp: 25, duration: 1 }), st = S.skillInit(sp); S.skillActivate(sp, st);
  assert.deepStrictEqual(run(sp, st, 1.2, 0.3), [[4, 'ended']]); near(st.sp, 0.2);
});
ok('ATTACK sp: +1 per attack, time and hits give nothing; HIT sp: +1 per hit taken, attacks and time give nothing', () => {
  const a = spec({ spType: 'ATTACK', spCost: 3, initSp: 0 }), sa = S.skillInit(a);
  run(a, sa, 60); S.skillOnHit(a, sa); assert.strictEqual(sa.sp, 0);
  S.skillOnAttack(a, sa); S.skillOnAttack(a, sa); assert.ok(!S.skillReady(a, sa)); S.skillOnAttack(a, sa); assert.ok(S.skillReady(a, sa));
  S.skillOnAttack(a, sa); assert.strictEqual(sa.sp, 3, 'capped');
  const h = spec({ spType: 'HIT', spCost: 2, initSp: 0 }), sh = S.skillInit(h);
  run(h, sh, 60); S.skillOnAttack(h, sh); assert.strictEqual(sh.sp, 0);
  S.skillOnHit(h, sh); assert.ok(!S.skillReady(h, sh)); S.skillOnHit(h, sh); assert.ok(S.skillReady(h, sh));
});
ok('instant skill (duration 0): fires, returns spec.instant, never active, no "ended", charging starts at once', () => {
  const inst = { dp: 12 }, sp = spec({ duration: 0, initSp: 25, instant: inst }), st = S.skillInit(sp);
  assert.strictEqual(S.skillActivate(sp, st), inst);
  assert.deepStrictEqual(st, { sp: 0, active: false, remaining: 0, uses: 1 });
  assert.deepStrictEqual(run(sp, st, 25), []); assert.ok(S.skillReady(sp, st));
});
ok('duration -1 never ends (1 hour of ticks); ammo skill ends on the tick after its last attack', () => {
  const sp = spec({ duration: -1, initSp: 25 }), st = S.skillInit(sp); S.skillActivate(sp, st);
  assert.deepStrictEqual(run(sp, st, 3600, 1), []); assert.ok(st.active); assert.strictEqual(st.sp, 0);
  const am = spec({ duration: -1, initSp: 25, ammo: 3 }), sa = S.skillInit(am); S.skillActivate(am, sa);
  S.skillOnAttack(am, sa); S.skillOnAttack(am, sa); assert.deepStrictEqual(run(am, sa, 10), []);
  S.skillOnAttack(am, sa); assert.deepStrictEqual(run(am, sa, 1), [[1, 'ended']]); assert.ok(!sa.active);
});
ok('readiness: AUTO and MANUAL ready at spCost; PASSIVE, NONE-sp and unsupported never ready', () => {
  for (const trigger of ['AUTO', 'MANUAL']) { const sp = spec({ trigger }), st = S.skillInit(sp); assert.ok(!S.skillReady(sp, st)); run(sp, st, 15); assert.ok(S.skillReady(sp, st), trigger); }
  const p = spec({ trigger: 'PASSIVE', spType: 'NONE', spCost: 0, initSp: 0 }), sp = S.skillInit(p); run(p, sp, 60); assert.ok(!S.skillReady(p, sp));
  const u = spec({ fidelity: 'unsupported' }), su = S.skillInit(u); run(u, su, 60); assert.ok(!S.skillReady(u, su)); assert.strictEqual(su.sp, 10, 'unsupported: no SP gain');
});
ok('multi-stage spec (stages): use 1 lasts stages[0].duration, use 2 and later stages[1] (-1 = permanent)', () => {
  const sp = spec({ spType: 'ATTACK', spCost: 2, initSp: 2, duration: 30, stages: [{ duration: 30 }, { duration: -1 }] }), st = S.skillInit(sp);
  S.skillActivate(sp, st); assert.strictEqual(st.remaining, 30); assert.deepStrictEqual(run(sp, st, 30), [[300, 'ended']]);
  S.skillOnAttack(sp, st); S.skillOnAttack(sp, st); S.skillActivate(sp, st); assert.strictEqual(st.uses, 2);
  assert.deepStrictEqual(run(sp, st, 3600, 1), []); assert.ok(st.active);
  const prof = { base: { n: 0 }, active: { n: 1 }, stages: [{ n: 1 }, { n: 2 }] };
  assert.strictEqual(S.currentProfile(prof, st).n, 2); assert.strictEqual(S.currentProfile(prof, { active: false }).n, 0);
});
ok('"部署后…" passive (onDeploy): active from skillInit for its duration, then ends once and never comes back', () => {
  const sp = spec({ trigger: 'PASSIVE', spType: 'NONE', spCost: 0, initSp: 0, duration: 5, onDeploy: true }), st = S.skillInit(sp);
  assert.ok(st.active); assert.deepStrictEqual(run(sp, st, 60), [[50, 'ended']]); assert.ok(!S.skillReady(sp, st));
});
ok('cycle: TIME uptime = duration / (spCost / rate + duration); -1 = always; instant = 0; null for ATTACK / passive / ammo / stages', () => {
  assert.deepStrictEqual(S.cycle(spec()), { uptime: 8 / 33, period: 33 });
  assert.deepStrictEqual(S.cycle(spec({ spRate: 0.5 })), { uptime: 8 / 58, period: 58 });
  assert.deepStrictEqual(S.cycle(spec({ duration: -1 })), { uptime: 1, period: Infinity });
  assert.deepStrictEqual(S.cycle(spec({ duration: 0 })), { uptime: 0, period: 25 });
  for (const o of [{ spType: 'ATTACK' }, { spType: 'HIT' }, { trigger: 'PASSIVE' }, { ammo: 5 }, { stages: [{ duration: 1 }] }, { fidelity: 'unsupported' }]) assert.strictEqual(S.cycle(spec(o)), null, JSON.stringify(o));
  // the automaton agrees: 330 s of asap use of the synthetic skill = 10 periods = 80 s active
  const sp = spec({ initSp: 0 }), st = S.skillInit(sp); let on = 0;
  for (let k = 0; k < 3300; k++) { if (S.skillReady(sp, st)) S.skillActivate(sp, st); if (st.active) on += 0.1; S.skillTick(sp, st, 0.1); }
  near(on / 330, 8 / 33, 'uptime');
});

// ---------- the 12 roster operators (CONTRACT 9) ----------
const R = O.loadRoster();
const ops = Object.fromEntries(R.operators.map(op => [op.name, op]));
const lvOf = op => ST[op.skillId].levels[op.skillLevel - 1];
const bbOf = op => Object.fromEntries(lvOf(op).blackboard.map(b => [b.key, b.value]));
const talentBb = (op, i) => { const t = S.talentsOf(op).byIndex(i); assert.ok(t, `${op.name} talent ${i}`); return t.bb; };
const PROFILE_KEYS = ['hp', 'atk', 'def', 'res', 'block', 'interval', 'damageType', 'targets', 'canHitAir', 'range', 'atkScale', 'hits', 'attacks'];
const NUM_KEYS = ['hp', 'atk', 'def', 'res', 'block', 'interval', 'targets', 'atkScale', 'hits'];
const compiled = {};

ok('roster: 12 operators, the contract skills (桃金娘 S1 ... 棘刺 S3), all E2', () => {
  const want = { 桃金娘: 1, 德克萨斯: 2, 塞雷娅: 2, 星熊: 2, 银灰: 3, 史尔特尔: 3, 能天使: 3, 蓝毒: 2, 艾雅法拉: 3, 逻各斯: 3, 夜莺: 3, 棘刺: 3 };
  assert.deepStrictEqual(Object.fromEntries(R.operators.map(o => [o.name, o.skillIndex + 1])), want);
  assert.ok(R.operators.every(o => o.elite === 2));
});
ok('roster: compileSkill returns the contract shape; spType/trigger/spCost/duration read from skill_table', () => {
  const SPT = { INCREASE_WITH_TIME: 'TIME', INCREASE_WHEN_ATTACK: 'ATTACK', INCREASE_WHEN_TAKEN_DAMAGE: 'HIT', 8: 'NONE' };
  for (const op of R.operators) {
    const sp = compiled[op.name] = S.compileSkill(op), lv = lvOf(op);
    for (const k of ['id', 'name', 'level', 'trigger', 'spType', 'spCost', 'initSp', 'duration', 'instant', 'dpOverDuration', 'fidelity', 'notes']) assert.ok(k in sp, `${op.name}: ${k}`);
    assert.strictEqual(sp.id, op.skillId); assert.strictEqual(sp.name, lv.name); assert.strictEqual(sp.level, op.skillLevel);
    assert.strictEqual(sp.trigger, lv.skillType); assert.strictEqual(sp.spType, SPT[lv.spData.spType]); assert.strictEqual(sp.spCost, lv.spData.spCost);
    assert.ok(['exact', 'approx', 'unsupported'].includes(sp.fidelity)); assert.ok(Array.isArray(sp.notes));
    assert.ok(sp.fidelity !== 'unsupported', `${op.name} is hand-checked: ${sp.notes.join(' / ')}`);
    assert.ok(sp.handChecked.skill && sp.handChecked.talents, `${op.name}: hand-checked handlers ran`);
    assert.ok(sp.fidelity === 'exact' || sp.notes.length > 0, `${op.name}: approx needs a note per clause left out`);
    if (op.name !== '艾雅法拉') assert.strictEqual(sp.initSp, lv.spData.initSp, op.name);
    if (!['德克萨斯', '塞雷娅', '星熊', '史尔特尔', '棘刺'].includes(op.name)) assert.strictEqual(sp.duration, lv.duration, op.name);
    assert.strictEqual(S.compileSkill(op), sp, 'cached per operator object');
  }
});
ok('roster: profiles have every contract field, no NaN anywhere (profiles, stages, spec numbers, dpsAgainst)', () => {
  const enemy = { hp: 10000, atk: 500, def: 300, res: 30, type: 'NORMAL', motion: 'WALK', damageTaken: 1 };
  const finite = (v, where) => assert.ok(typeof v !== 'number' || Number.isFinite(v) || v === Infinity && /period/.test(where), `${where} = ${v}`);
  const walk = (v, where) => { if (v && typeof v === 'object') for (const [k, w] of Object.entries(v)) walk(w, where + '.' + k); else finite(v, where); };
  for (const op of R.operators) {
    const sp = compiled[op.name], p = S.profiles(op, sp);
    for (const [name, prof] of Object.entries({ base: p.base, active: p.active, ...Object.fromEntries((p.stages || []).map((s, i) => ['stage' + i, s])) })) {
      for (const k of PROFILE_KEYS) assert.ok(k in prof, `${op.name} ${name}.${k}`);
      for (const k of NUM_KEYS) assert.ok(Number.isFinite(prof[k]), `${op.name} ${name}.${k} = ${prof[k]}`);
      assert.ok(Array.isArray(prof.range) && prof.range.length > 0 && prof.range.every(o => Number.isInteger(o.dr) && Number.isInteger(o.dc)));
      assert.ok(prof.interval > 0 && prof.hp > 0, `${op.name} ${name}`);
      walk(prof, `${op.name}.${name}`);
      assert.ok(Number.isFinite(O.dpsAgainst(prof, enemy)), `${op.name} ${name} dps`);
    }
    walk({ spCost: sp.spCost, initSp: sp.initSp, duration: sp.duration, instant: sp.instant, dpOverDuration: sp.dpOverDuration, cycle: S.cycle(sp) }, op.name + '.spec');
    const line = S.describeSkill(op); assert.ok(typeof line === 'string' && line.startsWith(op.name) && !line.includes('\n'), line);
  }
});

// per-operator: numbers equal the raw blackboard values at the roster level
const pr = name => S.profiles(ops[name], compiled[name]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
ok('桃金娘 S1: stops attacking, block 0 (trait), DP over the duration = blackboard value', () => {
  const op = ops.桃金娘, bb = bbOf(op), sp = compiled.桃金娘, p = pr('桃金娘');
  assert.strictEqual(sp.dpOverDuration, bb.value); assert.strictEqual(sp.duration, lvOf(op).duration);
  assert.strictEqual(p.active.attacks, false); assert.strictEqual(p.active.block, 0); assert.strictEqual(p.base.block, op.block); assert.strictEqual(p.base.attacks, true);
  assert.strictEqual(p.base.hpRegenPerSec, talentBb(op, 0).hp_recovery_per_sec);
});
ok('德克萨斯 S2: instant +cost DP and 2 x atk_scale arts on all enemies in the skill range; profiles unchanged', () => {
  const op = ops.德克萨斯, bb = bbOf(op), sp = compiled.德克萨斯, p = pr('德克萨斯');
  assert.strictEqual(sp.duration, 0); assert.strictEqual(sp.instant.dp, bb.cost);
  assert.deepStrictEqual([sp.instant.damage.scale, sp.instant.damage.damageType, sp.instant.damage.targets, sp.instant.damage.hits], [bb.atk_scale, 'arts', O.TARGETS_ALL, 2]);
  assert.strictEqual(sp.instant.damage.range, O.rangeOf(lvOf(op).rangeId));
  assert.ok(same(p.base, p.active)); assert.strictEqual(sp.squad.initialDp, talentBb(op, 0).cost);
  const st = S.skillInit(sp); st.sp = sp.spCost; assert.strictEqual(S.skillActivate(sp, st), sp.instant); assert.ok(!st.active);
});
ok('塞雷娅 S2: AUTO, instant heal = heal_scale x ATK on all allies in the skill range', () => {
  const op = ops.塞雷娅, bb = bbOf(op), sp = compiled.塞雷娅, p = pr('塞雷娅');
  assert.strictEqual(sp.trigger, 'AUTO'); assert.strictEqual(sp.duration, 0);
  assert.strictEqual(sp.instant.heal.scale, bb.heal_scale); assert.strictEqual(sp.instant.heal.range, O.rangeOf(lvOf(op).rangeId));
  assert.ok(same(p.base, p.active)); near(p.base.atk, op.atk, 'talent stacks default 0');
  const tb = talentBb(op, 0);
  near(S.profiles(op, sp, { stacks: tb.max_stack_cnt }).base.atk, op.atk * (1 + tb.atk * tb.max_stack_cnt));
  near(S.profiles(op, sp, { stacks: 99 }).base.def, op.def * (1 + tb.def * tb.max_stack_cnt), 'stacks capped');
});
ok('星熊 S2 (passive): DEF + def (+ talent 重装 DEF) in BOTH profiles; thorns atk_scale', () => {
  const op = ops.星熊, bb = bbOf(op), sp = compiled.星熊, p = pr('星熊');
  assert.strictEqual(sp.trigger, 'PASSIVE'); assert.strictEqual(sp.spType, 'NONE'); assert.strictEqual(sp.duration, 0);
  near(p.base.def, op.def * (1 + bb.def + (S.AURA_INCLUDES_SELF ? talentBb(op, 1).def : 0)));
  assert.ok(same(p.base, p.active)); assert.deepStrictEqual(p.base.thorns, { scale: bb.atk_scale, damageType: 'physical' });
  assert.strictEqual(p.base.damageNegateProb, talentBb(op, 0).prob);
  assert.ok(!S.skillReady(sp, S.skillInit(sp)));
});
ok('银灰 S3: ATK +atk (+ talent 25%), DEF +def (negative), targets attack@max_target, skill range, ranged 80% lifted', () => {
  const op = ops.银灰, bb = bbOf(op), sp = compiled.银灰, p = pr('银灰'), ta = talentBb(op, 0).atk;
  near(p.base.atk, op.atk * (1 + ta)); near(p.active.atk, op.atk * (1 + ta + bb.atk)); near(p.active.def, op.def * (1 + bb.def));
  assert.ok(bb.def < 0);
  assert.strictEqual(p.active.targets, bb['attack@max_target']); assert.strictEqual(p.base.targets, 1);
  assert.strictEqual(p.active.range, O.rangeOf(lvOf(op).rangeId)); assert.strictEqual(p.base.range, op.range);
  assert.strictEqual(p.base.atkScale, op.raw.trait.candidates.at(-1).blackboard.find(b => b.key === 'atk_scale').value); assert.strictEqual(p.active.atkScale, 1);
  assert.strictEqual(p.active.bonusHit.scale, 0.1, 'module X trait atk_scale_m');
});
ok('史尔特尔 S3: infinite, ATK +atk, HP +max_hp (flat), targets attack@max_target, range +ability_range_forward_extend forward', () => {
  const op = ops.史尔特尔, bb = bbOf(op), sp = compiled.史尔特尔, p = pr('史尔特尔');
  assert.strictEqual(sp.duration, -1); assert.strictEqual(lvOf(op).duration, -1);
  near(p.active.atk, op.atk * (1 + bb.atk)); near(p.active.hp, op.hp + bb.max_hp); assert.strictEqual(p.active.targets, bb['attack@max_target']);
  assert.strictEqual(p.active.range.length, op.range.length + bb.ability_range_forward_extend);
  assert.strictEqual(Math.max(...p.active.range.map(o => o.dc)), Math.max(...op.range.map(o => o.dc)) + bb.ability_range_forward_extend);
  assert.deepStrictEqual(p.active.hpDrain, { ratioPerSec: bb.hp_ratio, rampSeconds: bb.duration, tick: bb.interval });
  assert.deepStrictEqual(sp.instant, { selfHeal: { hpRatio: 1 } }); assert.ok(!sp.instant.heal, 'not an ally heal');
  assert.strictEqual(p.base.resIgnore, talentBb(op, 0).magic_resist_penetrate_fixed);
  const st = S.skillInit(sp); run(sp, st, sp.spCost); S.skillActivate(sp, st); assert.deepStrictEqual(run(sp, st, 600, 1), []);
});
ok('能天使 S3: AUTO, attack@times hits, attack@atk_scale, interval (BAT + base_attack_time) x 100 / (aspd + talent)', () => {
  const op = ops.能天使, bb = bbOf(op), sp = compiled.能天使, p = pr('能天使'), aspd = op.attackSpeed + talentBb(op, 0).attack_speed;
  assert.strictEqual(sp.trigger, 'AUTO');
  assert.strictEqual(p.active.hits, bb['attack@times']); assert.strictEqual(p.active.atkScale, bb['attack@atk_scale']);
  near(p.base.interval, op.baseAttackTime * 100 / aspd); near(p.active.interval, (op.baseAttackTime + bb.base_attack_time) * 100 / aspd);
  const t1 = talentBb(op, 1); near(p.base.atk, op.atk * (1 + t1.atk)); near(p.base.hp, op.hp * (1 + t1.max_hp));
  assert.deepStrictEqual(S.cycle(sp), { uptime: sp.duration / (sp.spCost + sp.duration), period: sp.spCost + sp.duration });
});
ok('蓝毒 S2 (Lv8): ATK +atk, targets 1 + 2, main target shot attack@times times (hitsByTarget)', () => {
  const op = ops.蓝毒, bb = bbOf(op), p = pr('蓝毒');
  near(p.active.atk, op.atk * (1 + bb.atk)); assert.strictEqual(p.active.targets, 3);
  assert.deepStrictEqual(p.active.hitsByTarget, [bb['attack@times'], 1, 1]); assert.strictEqual(p.active.hits, 1);
  assert.strictEqual(p.base.dot.dps, talentBb(op, 0).poison_damage);
});
ok('艾雅法拉 S3: ATK +atk (+ talent), BAT + base_attack_time, attack@max_target, skill range; initSp + guaranteed 乱火 SP', () => {
  const op = ops.艾雅法拉, bb = bbOf(op), sp = compiled.艾雅法拉, p = pr('艾雅法拉'), t0 = talentBb(op, 0).atk;
  near(p.active.atk, op.atk * (1 + t0 + bb.atk)); near(p.active.interval, (op.baseAttackTime + bb.base_attack_time) * 100 / op.attackSpeed);
  assert.strictEqual(p.active.targets, bb['attack@max_target']); assert.strictEqual(p.active.range, O.rangeOf(lvOf(op).rangeId));
  assert.strictEqual(sp.initSp, lvOf(op).spData.initSp + talentBb(op, 1).sp_min);
});
ok('逻各斯 S3 (Lv9): ATK +atk, targets attack@max_target, skill range; arts both profiles', () => {
  const op = ops.逻各斯, bb = bbOf(op), p = pr('逻各斯');
  near(p.active.atk, op.atk * (1 + bb.atk)); assert.strictEqual(p.active.targets, bb['attack@max_target']);
  assert.strictEqual(p.active.range, O.rangeOf(lvOf(op).rangeId)); assert.strictEqual(p.base.damageType, 'arts'); assert.strictEqual(p.active.damageType, 'arts');
});
ok('夜莺 S3 (Lv7): heal-type, ATK +atk, skill range, aura RES +magic_resistance and prob arts dodge', () => {
  const op = ops.夜莺, bb = bbOf(op), p = pr('夜莺');
  assert.strictEqual(p.base.damageType, 'heal'); assert.strictEqual(p.base.targets, 3);
  near(p.active.atk, op.atk * (1 + bb.atk)); assert.strictEqual(p.active.range, O.rangeOf(lvOf(op).rangeId));
  assert.strictEqual(p.active.aura.artsDodge, bb.prob); assert.ok(p.active.aura.mods.some(m => m.stat === 'res' && m.value === bb.magic_resistance));
});
ok('棘刺 S3: ATTACK sp; use 1 atk/attack_speed for duration; use 2+ thorns_s_3[b] values, permanent; ranged 80% lifted', () => {
  const op = ops.棘刺, bb = bbOf(op), sp = compiled.棘刺, p = pr('棘刺');
  assert.strictEqual(sp.spType, 'ATTACK'); assert.deepStrictEqual(sp.stages, [{ duration: lvOf(op).duration }, { duration: bb['thorns_s_3[b].duration'] }]);
  near(p.stages[0].atk, op.atk * (1 + bb.atk)); near(p.stages[0].interval, op.baseAttackTime * 100 / (op.attackSpeed + bb.attack_speed));
  near(p.stages[1].atk, op.atk * (1 + bb['thorns_s_3[b].atk'])); near(p.stages[1].interval, op.baseAttackTime * 100 / (op.attackSpeed + bb['thorns_s_3[b].attack_speed']));
  assert.strictEqual(p.active, p.stages[0]); assert.strictEqual(p.base.atkScale, 0.8); assert.strictEqual(p.stages[1].atkScale, 1);
  assert.strictEqual(p.stages[1].range, O.rangeOf(lvOf(op).rangeId));
  const st = S.skillInit(sp); for (let k = 0; k < sp.spCost; k++) S.skillOnAttack(sp, st);
  S.skillActivate(sp, st); assert.strictEqual(S.currentProfile(p, st), p.stages[0]);
  assert.deepStrictEqual(run(sp, st, lvOf(op).duration), [[lvOf(op).duration * 10, 'ended']]);
  for (let k = 0; k < sp.spCost; k++) S.skillOnAttack(sp, st);
  S.skillActivate(sp, st); assert.strictEqual(S.currentProfile(p, st), p.stages[1]); assert.deepStrictEqual(run(sp, st, 3600, 1), []);
  assert.strictEqual(S.cycle(sp), null);
});
ok('roster: profiles.active differs from profiles.base exactly where the skill changes the profile', () => {
  const differs = { 桃金娘: 1, 德克萨斯: 0, 塞雷娅: 0, 星熊: 0, 银灰: 1, 史尔特尔: 1, 能天使: 1, 蓝毒: 1, 艾雅法拉: 1, 逻各斯: 1, 夜莺: 1, 棘刺: 1 };
  for (const op of R.operators) assert.strictEqual(!same(pr(op.name).base, pr(op.name).active), !!differs[op.name], op.name);
});

// ---------- generic compiler and failure modes ----------
ok('generic: 玫兰莎 S1 "攻击力+{atk:0%}" -> approx, ATK x(1 + talent + atk); talent 攻击力+8% in both profiles', () => {
  const op = O.loadOperator('玫兰莎', { skill: 1 }), sp = S.compileSkill(op), p = S.profiles(op, sp), bb = bbOf(op);
  assert.strictEqual(sp.fidelity, 'approx'); assert.ok(!sp.handChecked.skill);
  const ta = S.talentsOf(op).list[0].bb.atk;
  near(p.base.atk, op.atk * (1 + ta)); near(p.active.atk, op.atk * (1 + ta + bb.atk));
});
ok('generic: next-attack skill = ammo 1 (银灰 S1: AUTO ATTACK, atk_scale replaces the lord 0.8 with a note)', () => {
  const op = O.loadOperator('银灰', { skill: 1 }), sp = S.compileSkill(op), p = S.profiles(op, sp), bb = bbOf(op);
  assert.strictEqual(sp.ammo, 1); assert.strictEqual(sp.duration, -1); assert.strictEqual(p.active.atkScale, bb.atk_scale);
  assert.ok(sp.notes.some(x => /replaces the trait ranged-attack scale/.test(x)));
  const st = S.skillInit(sp); for (let k = 0; k < sp.spCost; k++) S.skillOnAttack(sp, st);
  S.skillActivate(sp, st); assert.ok(st.active); S.skillOnAttack(sp, st); assert.deepStrictEqual(run(sp, st, 0.1), [[1, 'ended']]);
});
ok('generic passive: skill mods enter the base profile once, talents are not counted twice (synthetic talent on 森蚺 S1)', () => {
  const real = O.loadOperator('森蚺', { skill: 1 }), bb = bbOf(real);
  const op = { ...real, raw: { ...real.raw, talents: [{ candidates: [{ unlockCondition: { phase: 'PHASE_0', level: 1 }, requiredPotentialRank: 0, name: '测试', description: '攻击力+10%', blackboard: [{ key: 'atk', value: 0.1 }] }] }] } };
  const sp = S.compileSkill(op), p = S.profiles(op, sp);
  assert.strictEqual(sp.trigger, 'PASSIVE'); assert.notStrictEqual(sp.fidelity, 'unsupported');
  near(p.base.atk, op.atk * (1 + 0.1 + bb.atk)); near(p.base.def, op.def * (1 + bb.def)); assert.ok(same(p.base, p.active));
});
ok('unsupported: a clause not understood -> unsupported, note names it, base profile only, never ready', () => {
  const ct = O.table('character_table');
  let found = null;
  for (const id of Object.keys(ct)) {
    if (!id.startsWith('char_') || ct[id].isNotObtainable || !(ct[id].skills || []).length) continue;
    const o = O.loadOperator(id), s = S.compileSkill(o);
    if (s.fidelity === 'unsupported' && s.notes.some(x => /clause not understood/.test(x))) { found = [o, s]; break; }
  }
  assert.ok(found, 'some skill is unsupported');
  const [o, s] = found, p = S.profiles(o, s), st = S.skillInit(s);
  assert.strictEqual(p.active, p.base); assert.strictEqual(s.instant, null); assert.strictEqual(s.dpOverDuration, 0);
  assert.ok(s.notes.some(x => /behaves as no skill/.test(x)));
  run(s, st, 600); assert.ok(!S.skillReady(s, st)); assert.strictEqual(S.cycle(s), null);
});
ok('a hand-checked handler that fails leaves nothing behind (星熊 S2 with atk_scale removed in memory): unsupported, talents kept', () => {
  const lv = lvOf(ops.星熊), saved = lv.blackboard;
  lv.blackboard = saved.filter(b => b.key !== 'atk_scale');
  try {
    const op = { ...ops.星熊 }, sp = S.compileSkill(op), p = S.profiles(op, sp);
    assert.strictEqual(sp.fidelity, 'unsupported'); assert.ok(sp.notes.some(x => /hand-checked handler failed .*atk_scale/.test(x)));
    near(p.base.def, op.def * (1 + (S.AURA_INCLUDES_SELF ? talentBb(op, 1).def : 0)), 'skill DEF rolled back, talent DEF kept');
    assert.strictEqual(p.base.thorns, undefined); assert.strictEqual(p.active, p.base);
  } finally { lv.blackboard = saved; }
});
ok('no skill selected (skillId null) -> PASSIVE / NONE, never ready, profiles equal', () => {
  const op = { ...O.loadOperator('玫兰莎', { skill: 1 }), skillId: null, skillIndex: -1 }, sp = S.compileSkill(op), p = S.profiles(op, sp);
  assert.deepStrictEqual([sp.trigger, sp.spType, sp.duration, sp.instant], ['PASSIVE', 'NONE', 0, null]);
  assert.ok(same(p.base, p.active)); assert.ok(!S.skillReady(sp, S.skillInit(sp))); assert.match(S.describeSkill(op), /no skill/);
});
ok('sweep: every skill of every obtainable operator (max level) compiles without throwing, no NaN, numbers from the table', () => {
  const ct = O.table('character_table'), fid = {}, t0 = Date.now();
  let count = 0;
  for (const id of Object.keys(ct)) {
    const ch = ct[id];
    if (!id.startsWith('char_') || ch.isNotObtainable || !(ch.skills || []).length) continue;
    for (let s = 1; s <= ch.skills.length; s++) {
      let op;
      try { op = O.loadOperator(id, { skill: s, skillLevel: ch.phases.length >= 3 ? 10 : 7 }); } catch (e) { continue; }   // skill locked at the max elite
      const sp = S.compileSkill(op), p = S.profiles(op, sp), lv = lvOf(op);
      count++; fid[sp.fidelity] = (fid[sp.fidelity] || 0) + 1;
      for (const prof of [p.base, p.active]) for (const k of NUM_KEYS) assert.ok(Number.isFinite(prof[k]), `${op.name} S${s} ${k}`);
      assert.strictEqual(sp.spCost, lv.spData.spCost);
      if (sp.fidelity === 'unsupported') assert.strictEqual(p.active, p.base);
      if (sp.fidelity !== 'unsupported' && sp.duration > 0) assert.strictEqual(sp.duration, lv.duration, `${op.name} S${s}`);
      S.describeSkill(op);
    }
  }
  assert.ok(count > 900, 'skills compiled: ' + count);
  console.log(`   (${count} skills in ${Date.now() - t0} ms: ${Object.entries(fid).map(([k, v]) => k + ' ' + v).join(', ')})`);
});

// ---------- summary table ----------
// one short clause per note: what is left out, without where the optional field lives
const short = s => s.replace(/: only in .*$|: profiles use .*$|; profile\.atkScaleMelee.*$|; initSp includes.*$|; the simulator picks.*$|: the automaton handles.*$/, '')
  .replace(/ \((?:extensions? of|both outside)[^)]*\)/g, '').replace(/ is folded in for herself; for the other (\S+) it is only in spec\.teamMods/, ' on the other $1');
console.log('\noperator | skill | trigger | spType | spCost | initSp | duration | fidelity | what is not modelled');
for (const op of R.operators) {
  const sp = compiled[op.name];
  console.log([op.name, `S${op.skillIndex + 1} ${sp.name} Lv${sp.level}`, sp.trigger, sp.spType, sp.spCost, sp.initSp, sp.duration, sp.fidelity, sp.notes.map(short).join('; ')].join(' | '));
}
console.log(`\n${n} checks passed`);
