# model-frontier

Which AI model gives the most for the money? `model-frontier` lists the Pareto frontier: the models that no other model beats on both benchmark score and price. It also shows close contenders beneath each frontier model: up to three alternatives within 5 Artificial Analysis points or 50 Arena Elo in the same cost tier. These margins are heuristics, not confidence intervals. Every omitted rankable model is beaten or matched on score and cost by a listed model.

```
$ model-frontier

Frontier: LMArena Elo vs $ per 1M tokens · LMArena WebDev
Each numbered row costs more and scores higher than the one above.
Indented: alternatives within 50 points in the same cost tier (up to three per row).

#  MODEL                    SCORE   $/1M
1  solar-pro4                1370  0.052
2  deepseek-v4-flash-high    1581   0.18
     gpt-6-luna-max          1579   0.20
3  glm-5.3-flash             1616   0.24
...
8  claude-opus-5.5-max       1815   8.00

Scores: LMArena WebDev leaderboard (https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), filtered and ranked by model-frontier · Prices: models.dev (https://models.dev)
```

No inference calls, no account needed.

## Install

Node.js 22.19+.

```sh
npm install -g model-frontier
```

## Data sources

It works without setup and works better with a free [Artificial Analysis](https://artificialanalysis.ai) API key:

| | Without a key | With `ARTIFICIAL_ANALYSIS_API_KEY` |
|---|---|---|
| Scores | [LMArena WebDev](https://lmarena.ai/leaderboard/webdev) Elo | Artificial Analysis intelligence and coding indices |
| Prices | [models.dev](https://models.dev) | Artificial Analysis |
| Cost per benchmark task, speed | no | yes |

Each user brings their own key; it is only sent to Artificial Analysis. Data is cached for 24 hours in `$XDG_CACHE_HOME/model-frontier` (default `~/.cache`).

## Use

```sh
model-frontier                       # intelligence vs price
model-frontier --metric coding       # coding score; unscored new models listed separately
model-frontier --provider xai        # compare only xAI models
model-frontier --provider openai,anthropic   # compare both makers on one frontier
model-frontier --by speed            # fastest model at each score level
model-frontier --by task-cost        # AA's cost per benchmark task, which includes token use
model-frontier --models gpt-6.1-sol,openai-codex/gpt-6-luna   # only these, all effort variants
model-frontier --by task-cost --min-score 45   # cheapest per task at intelligence 45 or higher
model-frontier --margin 0            # strict frontier, no alternatives
model-frontier --source aa --margin 3       # 3 AA points (requires a key)
model-frontier --source arena --margin 20   # 20 Arena Elo
model-frontier --json                # for scripts and agents
model-frontier refresh               # re-fetch now
```

Price is the blended price per 1M tokens (3:1 input to output). Coding scores lag new releases, so `--metric coding` also lists unscored models that would extend the frontier on intelligence. `--min-score` remains a hard floor for alternatives too. Speed uses speed tiers instead of cost tiers. Above the final frontier row, only alternatives at that row's cost (or speed) are shown. With `--models`, a requested model not shown on the frontier or as an alternative is listed with the reason, for example the model that beats it (`excluded[]` in JSON). JSON keeps the strict frontier in `models[]` and contenders in `alternatives[]`, each with `alternativeTo` and `scoreGap`.

`--provider` means the model maker, not a hosting service such as OpenRouter. Supply one name or a comma-separated list. Names match the source's creator name exactly, ignoring case and surrounding whitespace. Embedded control characters and blank list elements are rejected. Selected makers compete on one frontier, calculated after filtering. It intersects with `--models`; requested IDs outside the selected makers are reported as unmatched. The known `SpaceXAI` creator name in AA is treated as `xai`, so that filter works with both sources. Other names follow each source's catalog. Unknown makers match no models; if the selection has no rankable models, the CLI exits with code 2. When filtering, JSON `provider` carries the normalized, de-duplicated lowercase list, such as `"openai,anthropic"`; unfiltered results omit that field. The last numbered frontier row has the highest score among rankable models in the selection.

Only the models you can use, for example in [pi](https://pi.dev):

```sh
model-frontier --models "$(pi --list-models | awk 'NR>1 {print $2}' | paste -sd, -)"
```

`--help` lists everything. Scores are benchmarks, not your task.

## Library

```js
import { loadModels, rank, frontier, matches } from 'model-frontier';

const result = rank(await loadModels());   // LMArena without a key, Artificial Analysis with one
```

Library `rank` and `checkOptions` accept `{ provider: 'openai,anthropic' }` with the same filtering and validation as the CLI. Library ranking remains strict by default; pass `rank(snapshot, { margin: 5 })` to include alternatives. The CLI supplies its source-specific default margin. `frontier(rows, { score, cost })` is the generic Pareto filter, for your own cost model.

## Attribution

Data comes from [Artificial Analysis](https://artificialanalysis.ai), the [LMArena leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)) and [models.dev](https://models.dev). Every output names its source. If you show results elsewhere, keep that line.

## License

[MIT](LICENSE)
