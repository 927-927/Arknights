# Black Flow Ledger / 树海账本

Strategy and resource-allocation research for Arknights Integrated Strategies 6, 沉沦者的黑流树海, published as a static website (English / 中文).

## Layout

- `site/` the website. `index.html` is page content without a document skeleton (the artifact host adds one); `js/` holds the data, the simulation engine, precomputed results and the page script.
- `research/sources/` downloaded source data: MAA map templates and market files (AGPL-3.0), BWIKI wikitext.
- `research/scripts/` build, experiment and preview scripts.
- `dist/` a standalone copy of the site with a full HTML document (generated).

## Commands

```bash
node research/scripts/build_data.js      # sources -> site/js/data.js
node research/scripts/experiments.js     # all simulations -> site/js/results.js (~20 min; pass 0.1 for a quick run)
node research/scripts/serve.js 8642      # preview at http://localhost:8642
node research/scripts/build_dist.js      # standalone copy in dist/
```

The engine (`site/js/engine.js`) runs in both Node and the browser, so the route lab on the page uses the same optimiser as the batch experiments.
