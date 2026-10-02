# model-frontier

Which AI model gives the most for the money? `model-frontier` lists the Pareto frontier: the models that no other model beats on both benchmark score and price. Every model it leaves out has a listed model that scores at least as high for less.

```
$ model-frontier

Frontier: LMArena Elo vs $ per 1M tokens · LMArena WebDev
Each row costs more and scores higher than the one above.

#  MODEL                    SCORE   $/1M
1  solar-pro4                1370  0.052
2  deepseek-v4-flash-high    1581   0.18
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
model-frontier --by speed            # fastest model at each score level
model-frontier --by task-cost        # AA's cost per benchmark task, which includes token use
model-frontier --models gpt-6.1-sol,openai-codex/gpt-6-luna   # only these, all effort variants
model-frontier --json                # for scripts and agents
model-frontier refresh               # re-fetch now
```

Price is the blended price per 1M tokens (3:1 input to output). Coding scores lag new releases, so `--metric coding` also lists unscored models that would extend the frontier on intelligence.

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

`frontier(rows, { score, cost })` is the generic Pareto filter, for your own cost model.

## Attribution

Data comes from [Artificial Analysis](https://artificialanalysis.ai), the [LMArena leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)) and [models.dev](https://models.dev). Every output names its source. If you show results elsewhere, keep that line.

## License

[MIT](LICENSE)
