# Changelog

## 0.2.0

- `--models`: a requested model that is not on the frontier is now listed with the reason, such as the model that beats it, instead of being left out silently. JSON: `excluded[]`.
- `--min-score N` drops models scoring below N on the ranked metric.
- Prices in the table show three significant digits, so close values like 0.131 and 0.133 no longer both read 0.13.
- `--help` tells agents to mention strong new models that have no coding score yet.

## 0.1.0

- First release: Pareto frontier from Artificial Analysis (with `ARTIFICIAL_ANALYSIS_API_KEY`) or LMArena WebDev with models.dev prices (no key).
