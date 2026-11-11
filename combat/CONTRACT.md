# combat/ interface contract (binding for every module)

Goal of app 2: given the user's operators + collectibles and a stage (floor, 保密等级), find the best
**combat timeline**: which operator goes on which tile, facing where, **when** it is deployed, and
**when each skill is started**. The simulator scores a timeline; the optimizer searches timelines.

Plain CommonJS, Node 22, no npm dependencies, `'use strict'`. Modules are built in parallel against this
file, so shapes and signatures here may be extended (extra fields) but never changed or renamed.
Unverified modelling choices are named constants or options with a comment starting `ASSUMPTION:`.

## 1. Coordinates and directions
- `grid[r][c]`, `r = 0` is the TOP row, `c = 0` the left column (same as `stage_model.loadStage`).
- Directions: `'E'` = +c, `'S'` = +r, `'W'` = -c, `'N'` = -r.
- A range is a list of offsets `[{dr, dc}]` stored FACING EAST (`dc > 0` is forward). `{dr:0, dc:0}` is the own tile.
- `rotate(range, dir)`: clockwise on screen, `(dr, dc) -> (dc, -dr)` per step E->S->W->N.
  So `{dr:0,dc:1}` becomes `{dr:1,dc:0}` for S, `{dr:0,dc:-1}` for W, `{dr:-1,dc:0}` for N.
- Tile id (integer) = `r * W + c`.

## 2. Operator object (`operators.js`: `loadOperator(name, {elite, level, potential, trust, skill, skillLevel})`)
```
{ id, name, appellation, rarity, profession, subProfession, position: 'MELEE'|'RANGED',
  elite, level, potential, trust,
  cost, redeploy, block, hp, atk, def, res, attackSpeed, baseAttackTime, interval,
  damageType: 'physical'|'arts'|'true'|'heal'|'none',
  targets,            // simultaneous targets of a basic attack (default 1)
  canHitAir,          // may target FLY enemies
  range: [{dr,dc}], rangeId,
  skillIndex,         // 0-based chosen skill, or -1
  skillLevel,         // 1..10 (8-10 = mastery 1-3)
  skillId,            // id in skill_table, or null
  raw: { talents, trait }  // untouched character_table fragments for skills.js
}
```
`skill` in the options and in roster files is 1-based (`skill: 3` = third skill); `skillIndex` is 0-based.
Other exports: `rotate`, `applyMods`, `secrecyMods(level, floor, opts)`, `stageMods(mc, {elite})`,
`hitDamage(atk, damageType, target)`, `dpsAgainst(opOrProfile, enemy)`, `loadRoster(path)`.

## 3. Modifiers (operators, enemies, collectibles, secrecy, stage mods all use this)
```
{ stat: 'atk'|'def'|'hp'|'res'|'attackSpeed'|'baseAttackTime'|'cost'|'block'|'redeploy'|'damageTaken'|'speed'|...,
  op: 'pct'|'add'|'mul'|'set', value, when?: {position?, profession?, subProfession?, type?, motion?, all?}, source }
```
`applyMods(unit, mods, ctx)` returns a NEW unit. Order: all matching `pct` of one stat are SUMMED and applied
once as `x * (1 + sum)`, then `add`, then each `mul` as an independent final multiplier, then `set`.
`interval` is recomputed as `baseAttackTime * 100 / attackSpeed` after mods.
Rule-changing collectibles are `{rule: '<name>', ...}` entries; modules ignore rules they do not implement.

## 4. Skills (`skills.js`)
`compileSkill(op) -> SkillSpec`:
```
{ id, name, level,
  trigger: 'MANUAL'|'AUTO'|'PASSIVE',
  spType: 'TIME'|'ATTACK'|'HIT'|'NONE', spCost, initSp,
  duration,           // seconds; 0 = instant, -1 = lasts until retreat (permanent / toggle)
  instant: { dp?: number, damage?: {scale, damageType, targets}, heal?: {...} } | null,  // on activation
  dpOverDuration,     // DP generated spread evenly over the duration (0 if none)
  fidelity: 'exact'|'approx'|'unsupported', notes: [string] }
```
`profiles(op, spec) -> { base: CombatProfile, active: CombatProfile }`, precomputed, talents folded in where
expressible:
```
CombatProfile = { hp, atk, def, res, block, interval, damageType, targets, canHitAir,
                  range: [{dr,dc}],  // facing east; the skill may change it
                  atkScale,          // multiplier on atk per hit (default 1)
                  hits,              // hits per attack (default 1)
                  attacks: true|false  // false = does not attack in this state
                }
```
SP automaton (the simulator calls these and owns nothing else about skills):
```
skillInit(spec) -> state { sp, active, remaining, uses }
skillTick(spec, state, dt) -> 'ended' | null     // TIME sp gain while inactive; counts duration down while active
skillOnAttack(spec, state)                        // ATTACK sp type: +1 per attack made
skillOnHit(spec, state)                           // HIT sp type: +1 per hit taken
skillReady(spec, state) -> bool
skillActivate(spec, state) -> spec.instant | {}   // sets active (or fires instantly), consumes sp
```
An `unsupported` skill behaves as no skill (base profile only) and says so in `notes`. Never guess a mechanic:
anything not derivable from `skill_table`/`character_table` blackboards and descriptions is left out and noted.

## 5. Enemy instance (`sim.sampleEnemies(stage, opts) -> [enemy]`)
```
{ id, key, name, type: 'NORMAL'|'ELITE'|'BOSS', motion: 'WALK'|'FLY', hp, atk, def, res, speed, interval,
  life, rangeRadius, applyWay, damageTaken (multiplier, default 1), wave, frag, group,
  spawn,                      // nominal spawn time (waves back to back)
  path: [{r, c, t, hidden?}]  // t relative to spawn, walking unblocked
}
```
All stage, secrecy and extra mods are already applied. Random spawn groups: exactly one option per group,
picked by a seeded PRNG (`opts.seed`, default 1).

## 6. Plan = timeline (`sim.simulate(stage, plan, opts)`)
```
plan = {
  deploys: [ { op: <operator object>, r, c, dir, t?: number } ],  // list order = deploy order; t = not-before (default 0)
  skills:  { [opName]: 'asap' | [t1, t2, ...] | { minEnemiesInRange?: n, minHpInRange?: x, notBefore?: t } },
  retreats?: [ { op: <name>, t } ]
}
```
- A deploy happens at the first tick with `time >= t`, enough DP, a free deploy slot, and every earlier
  deploy already done.
- Skill entry missing = `'asap'`. `'asap'` = activate the moment the skill is ready. A list of times =
  activate at the first tick `>= t_k` when ready (each time used once, in order). A policy object =
  activate when ready and the condition holds. AUTO skills ignore the entry and always fire when ready.
- An illegal deploy (tile type, occupied tile, operator reused) throws.
- Injection points (so modules and tests do not depend on each other): if `op.skillSpec` / `op.profiles` are
  present on an operator object they are used as is, otherwise the simulator lazily calls
  `skills.compileSkill(op)` / `skills.profiles(op, spec)`. `opts.enemies` (a prepared enemy list in the
  section 5 shape) skips `sampleEnemies`. The simulator computes hit damage inline with the HANDOFF formulas.
- Waves: wave `k+1` starts only when every enemy of wave `k` that blocks the wave is dead or leaked
  (the simulator gates this dynamically; `enemy.spawn` is the nominal back-to-back time).
```
opts = { dt=0.1, tps=TPS_DEFAULT, secrecy=0, floor=1, elite=false, enemyMods=[], seed=1,
         includeHidden=false, maxTime, lifePoints, trace=false }
result = { win, lifeLost, lifeLeft, leaks, kills, totalEnemies, hpRemoved, hpTotal, duration, score,
  deploys:   [{name, t, r, c, dir, cost}],
  skillUses: [{name, skill, t, end}],          // actual activation times: lets a policy run become explicit times
  losses:    [{name, t, cause: 'died'|'retreat'}],
  perOp:     [{name, damage, healing, kills, blockedSeconds, damageTaken, skillUptime, died}],
  dp:        {generated, spent, endUnspent},
  trace?: { sampleDt, frames: [{t, dp, enemies: [[id, r, c, hpFrac]], ops: [[name, hpFrac, skillActive, spFrac]]}],
            events: [{t, type: 'deploy'|'skill'|'skillEnd'|'kill'|'leak'|'opDown'|'wave', name?, id?}] } }
```
`r, c` of enemies in frames are fractional (interpolated). `score` = `scoreOf(result)`: a single number that
orders results lexicographically: fewer `lifeLost`, then larger `hpRemoved/hpTotal`, then fewer operator
losses, then shorter `duration`. Also exported: `canDeploy(stage, op, r, c, occupied)`, `deployLimit(stage, opts)`,
`compareResults(a, b)`, `TPS_DEFAULT`.

`TPS_DEFAULT = 0.5`: ASSUMPTION from the community wikis (move speed 1.0 = 0.5 tiles per second); the user will
calibrate it in game.

## 7. Placement instance (`optimize.js`, pure, knows nothing about the game)
```
inst = { limit,                      // max deployments
         hp: Float64Array(nE), w: Float64Array(nE),
         cands: [ { id, op: <operator index>, tile: <tile id>, dir, cost, pot: Float64Array(nE) } ] }
value(S) = sum_i w[i] * min(hp[i], sum_{p in S} pot[p][i])
feasible(S): each operator index at most once, each tile at most once, |S| <= limit
```
`candidates.js` builds `inst` from a stage, operators and enemies (`pot[p][i]` = damage that placement could
deal to enemy `i` walking through unblocked). `timeline.js` turns placement sets into full plans by
searching deploy order, deploy times and skill timing with `sim.simulate`.

## 8. File ownership
| File | Owner step |
|---|---|
| `operators.js`, `roster.example.json`, `test_operators.js` | operators |
| `skills.js`, `test_skills.js` | skills |
| `sim.js`, `test_sim.js`, `stage_model.js` (backwards-compatible extensions only) | sim |
| `optimize.js`, `test_optimize.js` | optimize |
| `test_integration.js` | integrate |
| `candidates.js`, `test_candidates.js` | candidates |
| `timeline.js`, `test_timeline.js` | timeline |
| `render.js`, `test_render.js` | viewer |
| `demo.js` | demo |

## 9. Example roster (fixed so parallel steps agree)
`roster.example.json` (`"example": true`, `"secrecy": 15`, `"floor": 5`), all Elite 2:
桃金娘 S1 · 德克萨斯 S2 · 塞雷娅 S2 · 星熊 S2 · 银灰 S3 · 史尔特尔 S3 · 能天使 S3 · 蓝毒 S2 · 艾雅法拉 S3 · 逻各斯 S3 · 夜莺 S3 · 棘刺 S3.

## 10. As built: extensions (integrate step; nothing above was changed or renamed)
Extra fields and arguments the built modules carry. A later module may rely on them; none is required.

**operators.js**
- `loadOperator(name, {elite, level, potential, trust, skill, skillLevel, module})`: `module` = `'X'`, `'Y3'`, a uniEquipId,
  a module name or `{type|id|name, stage}` (flat attribute bonuses of the stage only). `name` may be the Chinese name,
  the char id or the English appellation. Extra operator fields: `attacks` (false = no basic attack), `hits`, `aoe`
  (`null|'splash'|'chain'|'blocked'|'range'`), `anyTile` (MELEE that may use high ground), `traitText`, `module`,
  `raw.description`. `rarity` is a number 1-6; `range` arrays are frozen and shared (never mutate them).
- Modifier `when`: any key, matched against `ctx[k]` if defined, else `unit[k]`; an array = any of; `{all: true}`.
  Stage mods use `when: {key: [...]}` (enemy keys). Stat aliases from game data are accepted (`max_hp`, `ms`, ...).
- Rule entries (`{rule}`) emitted: `deployLimit {add}` (地形图 +1; secrecy N10 -1, source mentions "secrecy"),
  `meleeOnHighGround` (舞鞋), `hiddenGroupEnable|hiddenGroupDisable {group}`, `enemyReplace {from, to}`,
  `enemyStealth {when}`.
- `secrecyMods(level, floor, {perFloor, floorOneSteps, floorOp})`; `stageMods(mc, {elite, normalInElite})` returns
  `{mods, forbid: [{r,c}], unhandled, hiddenGroups: {enable, disable}, replace: [{from, to}]}`.
- `loadRoster(path)` returns `{operators, raw, mods, rules, dynamicMods, secrecy, floor, path}`; `operators` already
  carry the collectible stat mods (do not apply `mods` again); pass `rules` to `sim` as `opts.rules`.
- Extra exports: `rangeOf, resolveId, matchWhen, table` and the constants listed in the file.

**skills.js**
- `profiles(op, spec, {stacks, extraMods})` -> `{base, active, stages?}`; `stages[k]` = active profile of use k+1
  (last one repeats). Extra exports: `describeSkill(op)`, `cycle(spec)`, `currentProfile(profiles, state)`,
  `talentsOf`, `traitOf`, `skillLevelData` and the constants in the file.
- Extra spec fields: `operator, rangeId, charges, spRate, ammo, onDeploy, stages[{duration}], teamMods[], squad
  {initialDp, redeployPct}, stacking {every, max, mods}, initSpRoll, handChecked, effects`. Extra instant fields:
  `damage.hits`, `damage.range`, `heal.range` (facing east), `selfHeal {hpRatio}`.
- Extra profile fields: `atkScaleMelee, atkScaleByType, bonusHit, hitsByTarget, dot, onHitDebuff, proc, resIgnore,
  defIgnoreRamp, hpRegenPerSec, idleRegen, hpDrain, deathDelay, damageNegateProb, thorns, aura, prefersAir`.

**sim.js**
- `simulate(stage, plan, opts)`: extra opts `enemies, skillApi, modApi, fragmentTiming ('afterLast'|'fromStart'),
  stopOnDefeat, secrecyOpts, rules, strictSkills, noSkills (no skill is ever started, AUTO and onDeploy included;
  the base profile with talents and always-on passives stays), squad (operator objects of the squad, default the
  planned operators: spec.squad.initialDp)`. Extra plan.skills entry `'never'` (also `null`/`false`).
- Honoured skills.js extensions: profile `stages`, spec `ammo`, `onDeploy`, `teamMods` (while the bearer is on the
  field, folded in through `skills.profiles(op, spec, {extraMods})`), `stacking` (stacks = seconds on the field /
  every), `squad.initialDp`, instant `damage.hits/range`, `heal.range`, `selfHeal`, profile `atkScaleByType,
  hitsByTarget, bonusHit, resIgnore, damageNegateProb, thorns, hpRegenPerSec, prefersAir, hpDrain, deathDelay, dot,
  idleRegen, defIgnoreRamp, aura {mods, artsDodge}`. Not honoured: `atkScaleMelee, proc, onHitDebuff,
  squad.redeployPct` (the simulator has no redeploy), `loadRoster().dynamicMods`.
- Extra result fields: `alive, timedOut, lifePoints, dp.initial, dp.refunded`; `kill` events carry `name` (the
  killer), `opDown` events carry `cause`.
- Extra enemy fields (section 5): `prefabKey, baseAttackTime, attackSpeed, massLevel, notCount, attackMode,
  damageType, hits, waveT, waveSpan, dontBlockWave, bonus, leaveAt`; the list carries a non-enumerable `meta`
  `{seed, fragmentTiming, hiddenGroups, skipped, waveSpans}`.
- `canDeploy(stage, op, r, c, occupied, opts?)`: `occupied` = Set/Map of tile ids, array of ids or `{r,c}`, bitmap or
  predicate; `opts = {elite, rules}`. `deployLimit(stage, {secrecy, rules})`. Extra exports: `deployError,
  stageSystem, mulberry32` and the constants in the file. A deploy also waits for its tile to be free (a tile may be
  planned twice when its first occupant has a planned retreat).

**optimize.js** (pure): `inst.w` may be omitted (all 1), candidate ids may be strings, `pot`/`hp` may be plain arrays.
Exports: `value, feasible, prepare, newLeft, gain, place, damageSoFar, dominancePrune, greedy, Heap, lazyGreedy, TopN,
bruteForce, suffixTopSums, branchAndBound, solve, beamSearch, localSearch, simulatedAnnealing, knapsack01,
knapsackBrute, checkSubmodular, randomInstance, mulberry32, EPS, PRUNE_TOL, NODE_CAP_DEFAULT`. Every search returns
`{set (sorted ids), value, stats: {explored, pruned: {bound, dominance, symmetry, infeasible}, evals, timeMs}}`.
