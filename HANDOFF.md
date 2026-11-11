# 黑流树海 (IS6) project: handoff (2026-11-10)

Read this first in a new chat. Nothing is committed yet (one initial commit on `main`).

## North star (stated by the user, 2026-11-10; do not drift from it)
App 2 is a **search program** that finds the **best combat timeline under the user's current circumstances**:
- **Inputs:** the operators the user owns right now (elite, level, potential, skill, module), the collectibles they hold, the stage, the floor and the 保密等级.
- **Output:** a concrete timeline. For each operator: which tile, facing which way, at what second it is deployed, and at what second each skill is started.
- **"Best":** the timeline that loses the fewest lives, then removes the most enemy HP, then loses the fewest operators, then finishes fastest (`sim.scoreOf`).
- **How:** the simulator scores a timeline, and search and pruning find good ones. The placement search can prove optimality only for its fast scoring model. The timeline search is heuristic and reports the best result within a simulation budget. Say this honestly; don't call a heuristic result "the optimum".
- Anything that does not serve this goal is secondary: the old research site, app 1 map planning, and polishing the teaching.
- Supersedes "Planned build" below where they differ: skills and timing are in scope. The binding interfaces are in `combat/CONTRACT.md`.

## What the user wants
The user plays at 保密等级 15 and wants two apps, plus teaching:

1. **Map planning (道中 / 运营).** Route and node planning across a floor. lubiao.wiki's 黑流树海地图规划 tool already covers node prediction and screenshot recognition, so reuse or learn from it rather than rebuilding it.
2. **In-battle calculator (main focus).** Given the user's **current operators and collectibles**, plus a stage at a given floor and secrecy level, find the **best deployment**: which operators go where, facing which way, and in what order.
   - The user links this to *pruning* in coding.
3. **Teaching, after the demo works.** Relate the project to CS algorithms, learning through the project rather than LeetCode.
   - The user said: "pls teach after you finished the demo".
   - Style: "build with me", evaluate their ideas honestly, explain trade-offs.

**Earlier phase.** Before this, a bilingual (EN/中文) static research site, "Black Flow Ledger", was built at `site/` and published at https://claude.ai/artifact/3rSUZ6BJ5TQeoUFiNkf9TK.
- The user critiqued it as "not pro level": it ignored operator and collectible strength, stage difficulty, drop pools and node deduction.
- Its v2 plan is in `research/PROGRESS.md` and is now secondary.

## The user's modelling ideas, and the verdict given
- **Maps as matrices.** Good. Use an H×W grid with one channel per property: deployable, high ground, walkable, hole, spawn/exit, teleport, devices.
  - What matters most is the map weighted by enemy-seconds or HP-seconds per tile.
  - "Tokenizer" only matters for ML; here each channel should hold a real game property.
- **Enemies as matrices with time.** Store each enemy as a record: spawn time, stats, and its path with a timestamp per tile. Build a dense time×row×col array from the records only when a question needs it.
- **Operators as vectors.** Stats fit a vector. Range does not: it is a **mask**, and sliding the mask over the HP-time map gives a placement heatmap. Skills need a small state machine each (SP, duration, multipliers).
- **Collectibles and enemy bonuses as matrices.** Unconditional ones are affine "scale + add" and compose by matrix product. Three catches:
  - Same-type % buffs are summed before multiplying.
  - Many effects are conditional (melee only, while a skill is active, after N seconds).
  - Some change rules, not numbers, e.g. 舞鞋 lets melee deploy on high ground.

  So store them as a **list of conditional modifiers** and compile per operator and situation.

## What exists
| Path | What |
|---|---|
| `combat/stage_model.js` | **v0 in-battle model.** `loadStage(nameOrIndex)` gives the tile grid. `enemyStats(key, level)`. `shortestPath` is 8-direction with no corner cutting. `routeTimeline` gives timed waypoints. `enemyTimeline(st, tps, includeHidden)` gives enemy instances. `occupancy` gives enemy-seconds and HP-seconds per tile. CLI: `node combat/stage_model.js 彼处水如酒 [tps]` prints the map, heatmaps, roster and enemies on field. |
| `research/scripts/tomimi_decode.js` | Decodes tomimi.dev SvelteKit devalue `__data.json`. |
| `research/scripts/build_stages.js` | Writes `research/derived/stages.json`: 77 stages, rosters, difficulty metrics, lubiao frequencies. |
| `research/scripts/build_nodes.js` | Writes `research/derived/nodes.json`: node mix and P(type \| floor, distance, 凶戾/诡秘). |
| `research/scripts/build_data.js` | Builds `site/js/data.js`. Contains the **secrecy table** (lines ~96-115). |
| `site/` | v1 bilingual site. `js/engine.js` has orienteering DFS, fog-of-war player, node deduction (`deduce`, `deducedValue`, `populateReal`) and a price index. |
| `research/scripts/serve.js`, `.claude/launch.json` | Local preview, config "ledger", port 8642. |

**Sources** (`research/sources/`):
- `tomimi/`: 77 stage files and `index.tsv`.
- `gamedata/enemy_database.json`.
- `lubiao/`: drop pools, 260 collectibles, battles, stage frequencies, node-distance frequencies, floors, utopia and others.
- `maa/`, `bwiki/`.
- The user's notes: `C:\Users\zhang\OneDrive\Documents\Obsidian Vault\黑柳树海错题本.md` and `...\黑流树海-有用的一些数据.md`.

## Data facts and gotchas (verified)
- **Tile rows** are `[tileKey, isHighGround, blocksGroundMovement, effect, deployable]`. This is inferred from the data, not documented. Melee deploys on non-high deployable tiles; ranged deploys on high deployable tiles.
- **Coordinates:** route positions count rows **from the bottom**, so `grid row = H-1-row`.
- **Hidden spawns:** `hiddenGroup` spawns fire only on triggers. They are excluded by default; counting them produced 10 phantom 猎犬proto.
- **Stage fields** used so far:
  - `elite_mods` is per stage. Example: `atk ×1.2, hp ×1.4` on ALL, plus `level_hidden_group_enable`.
  - `n_mods`, `maxCost` 99, `costIncreaseTime` 1, `initialCost`, `characterLimit`.
  - `traps`, e.g. hidden `trap_323_shsbox` boxes.
  - `branches`: box-triggered spawns such as `enemy_2152_shezlc`.
  - `bonus`, `sp_enemy`, `routes`, `waves → fragments → actions`.
- **Secrecy (保密等级) enemy scaling.** Enemy ATK/HP rise per floor by: N5 1%, N6 2%, N7 3%, N8 5%, N9 6%, N10 7%, N11 8%, N12 10%, N13 12%, N14 16%, **N15 20%**, N16 25%. Other enemy-side and rule changes:

  | Level | Change |
  |---|---|
  | N5 | All enemies +30% max HP |
  | N8 | Elite and leader enemies +15% ATK |
  | N10 | Deploy limit −1 |
  | N11 | Leaders take 20% less damage |
  | N13 | Bosses strengthened |
  | N14 | 源阶方 strengthened |
  | N15 | 猎犬proto heals the boss |

  Whether "per floor" is additive (1 + 0.2×(floor−1)) is **unconfirmed**.
- **Damage:** physical = max(ATK−DEF, 5%·ATK); arts = ATK·(1−RES/100); attack interval = baseAttackTime·100/attackSpeed.
- **Operator data URL** (checked, returns 200):
  `https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/{character_table,range_table,skill_table}.json` (`uniequip_table.json` for modules).
- **Open issues in v0:**
  - Enemy speed units are uncalibrated: speed 1.0 is assumed to be 1 tile/s. Calibrate by timing a 历险水手 (speed 0.9) in-game.
  - Waves are treated as back to back (a lower bound).
  - `branches` and devices (盐坨子 boxes) are not modelled.
- **v0 check on 彼处水如酒 (ro6_n_5_5).** 8×13 map, deploy limit 6, initial cost 10, 40 enemies, about 786k base HP.
  - HP-time concentrates on rows 3-4, cols 7-11, after the teleport.
  - 4 × 裂地盐鳞 (100k HP each) and 2 × 恐怖厨子 (DEF 1800) mean you need arts damage and about 11k sustained DPS at N15 floor Ⅴ. That is "缺歼灭大C" (no main damage carry) as a number.

## Planned build for app 2 (not started; the build workflow was interrupted)
1. **`combat/operators.js`**
   - Download character, range and skill tables to `research/sources/gamedata/`.
   - `loadOperator(name, {elite, level, potential, trust})` returns `{id, name, profession, position, cost, redeploy, block, hp, atk, def, res, interval, damageType, range:[{dx,dy}] facing east, skills:[{spCost, initSp, duration, blackboard}]}`.
   - `rotate(range, dir)`.
   - `dpsAgainst(op, enemy)`.
   - `applyMods(unit, mods)`: conditional modifiers; sum same-type % then multiply. Used for both operators and enemies (secrecy, elite_mods).
   - Damage type comes from the trait text: 法术伤害 / 真实伤害 / 治疗.
2. **`combat/roster.example.json`.** The user's operators (elite, level, skill, module) and collectibles as a modifier list. **Ask the user for their real roster.**
3. **`combat/sim.js`.** Tick simulator (dt 1/30 or 0.1 s):
   - Enemies advance along the timed path in "free time" τ, which stops while blocked.
   - Melee operators block ground enemies up to their block count. Blocked enemies attack the blocker. Ranged enemies attack within `rangeRadius`.
   - Operators target the enemy closest to the exit. Medics heal.
   - DP: initialCost, then +1 per `costIncreaseTime`. Deploys happen in list order as DP allows.
   - Output: leaks or life lost, kills, HP removed.
   - Skills are skipped in v1.
4. **`combat/optimize.js` and `combat/demo.js`.** The optimizer, and the algorithms to teach:
   - **Candidate generation:** range mask cross-correlated with the HP-time map (a convolution), top-K per operator.
   - **Dominance pruning:** drop a candidate whose coverage is a subset of another at equal cost.
   - **Greedy:** works because coverage is submodular (diminishing returns from overkill).
   - **Branch & bound** with an admissible bound: an operator can't deal more than its DPS × the seconds at least one enemy is in its range.
   - **Search over combinations, not permutations** (symmetry pruning).
   - **Beam search and local swap search.**
   - The demo prints explored vs pruned node counts.
   - **Check:** B&B must equal brute force on a small instance.
5. **Verify.** Review game-mechanics fidelity and algorithm correctness, and run the demo on 3 stages.

## Teaching outline (deliver after the demo runs)
| Topic | Algorithms | Where it shows up |
|---|---|---|
| Graphs | BFS / Dijkstra / A* | Enemy pathing on the grid |
| Convolution and summed-area tables | 2D cross-correlation, prefix sums | Placement heatmap |
| Optimisation | Max coverage, submodularity, (1−1/e) greedy | Choosing placements with diminishing returns |
| Knapsack DP | 0/1 knapsack | DP cost and deploy limit |
| Pruning | Branch & bound, admissible bounds, dominance / Pareto, symmetry breaking | The optimizer |
| Search | Memoisation, beam search, hill climbing / simulated annealing | The optimizer |
| Simulation | Discrete-event simulation with a priority queue, vs fixed tick | The fight sim |
| Expectation | Monte Carlo / expected value | Random spawn groups |
| Planning vs adversarial search | Planning vs minimax / alpha-beta | Enemies are scripted, so this is planning, not a game tree |
| Algebra | Function composition, monoids, non-commutativity | Modifier stacking |

## Suggested opening prompt for the new chat
> Read HANDOFF.md. Build app 2's demo per "Planned build" (use a workflow), using roster.example.json until I give my roster; then teach me the algorithms in the outline using the demo. After that, decide with me how to handle app 1 (map planning) relative to lubiao's tool.
