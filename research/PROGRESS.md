# v2 rebuild: progress record (paused 2026-11-05)

## Why v2
User feedback on v1 (published site "Black Flow Ledger"): it ignored 干员 and 收藏品 strength, battle-map difficulty, node drop pools, human node deduction, and was not pro level. Goal: a central 运营 norm plus small fixes for abnormal cases, tested against the user's 错题本 (`C:\Users\zhang\OneDrive\Documents\Obsidian Vault\黑柳树海错题本.md`) and resource list (`...\黑流树海-有用的一些数据.md`). The user plays at 保密等级 15. Exclude 仙术杯-only competition rules.

## Done
- **Sources downloaded** (`research/sources/`):
  - `lubiao/`: archive (260 collectibles, 69 drop pools), battles (105 stages and rewards), stage frequencies (24,745 battles), node frequencies by walking distance (20,530 maps), map constructions, floors and event pools, 实托邦, 小八界, 浪花, 希望的沃土, duel variants, and the route-tool JS.
  - `tomimi/`: 77 stage `__data.json` files (enemies, waves, deploy limit, emergency modifiers), with `index.tsv`.
  - `gamedata/enemy_database.json` (ArknightsGameData).
- **Scripts** (`research/scripts/`):
  - `tomimi_decode.js` decodes the devalue format.
  - `build_stages.js` writes `research/derived/stages.json` (per-stage enemy roster, real stats, difficulty metrics and index).
  - `build_nodes.js` writes `research/derived/nodes.json` (node mix and P(type | floor, distance, 凶戾/诡秘)).
  - `build_data.js` now also embeds `nodeDist`, `nodeIcon`, `stages` and `pools` in `site/js/data.js`.
- **Engine** (`site/js/engine.js`):
  - `populate()` samples cells from recorded distributions (`realMix`).
  - `deduce()` and `deducedValue()` give the posterior for an unseen node.
  - The fog player values unseen nodes by deduction (`deduce: false` disables it).
  - New node types: savage, roamer, fate.
- **Not rerun yet:** `experiments.js` and the site still show v1 results.

## Paused: research workflow
- The workflow was stopped before any of the 5 research agents finished (stages and 鬼图, collectibles, operators, pro 运营 / 仙术杯, node deduction), and the critic never ran.
- Partial agent transcripts are in `C:\Users\zhang\.claude\projects\E--DESKTOP-Arknights\87f8f4b2-487d-4888-b683-139bdae94dbb\subagents\workflows\wf_5bf6c81e-f80\agent-*.jsonl`.
- Script: `C:\Users\zhang\.claude\projects\E--DESKTOP-Arknights\87f8f4b2-487d-4888-b683-139bdae94dbb\workflows\scripts\blackflow-pro-research-wf_5bf6c81e-f80.js`. It takes `args.errata` (the 错题本 text). Rerun it with that scriptPath; nothing is cached.

## Next steps
1. Rerun the research workflow, or mine the partial transcripts first to save tokens.
2. Build the 战力 model:
   - Power from operators and collectibles.
   - Stage difficulty from `stages.json`, scaled by 保密等级 per-floor growth.
   - Win-rate and life loss.
   - Calibrate on benchmarks: at N15, 30 collectibles by floor Ⅳ is far too few (user); 凉笙 多边贸易 averages 150+ collectibles.
3. Model the trade engine: 多边贸易 + 板藤/多生苔藓 buy-and-sell-back loop, 前瞻性投资 withdrawal (the user had 400 saved), shop refresh 4/8/12/16.
4. Synthesize the central norm per floor and the abnormal-case playbook. Map every 错题本 entry to a rule.
5. Run an adversarial verification pass on the claims.
6. Rerun experiments with the real node mix and deduction, update the bilingual site (new sections: 战力, stages/鬼图, drop pools, deduction tool, pro norm), then republish to the same artifact: https://claude.ai/artifact/3rSUZ6BJ5TQeoUFiNkf9TK (publish `site/index.html` with `files` js/data.js, js/engine.js, js/results.js, js/app.js).
