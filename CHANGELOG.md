# Changelog

## 0.3.0

- The CLI shows close contenders by default: up to three dimmed alternatives per frontier row within 5 Artificial Analysis points or 50 Arena Elo in the same cost/speed tier. `--margin N` adjusts this; `--margin 0` keeps the strict frontier. JSON: `alternatives[]` with `alternativeTo` and `scoreGap`. Library ranking stays strict unless a margin is supplied.

## 0.2.0

- `--models`: a requested model that is not on the frontier is now listed with the reason, such as the model that beats it, instead of being left out silently. JSON: `excluded[]`.
- `--min-score N` drops models scoring below N on the ranked metric.
- Prices in the table show three significant digits, so close values like 0.131 and 0.133 no longer both read 0.13.
- `--help` tells agents to mention strong new models that have no coding score yet.

## 0.1.0

- First release: Pareto frontier from Artificial Analysis (with `ARTIFICIAL_ANALYSIS_API_KEY`) or LMArena WebDev with models.dev prices (no key).
