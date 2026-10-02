#!/usr/bin/env node
import { parseArgs, styleText } from 'node:util';
import { createRequire } from 'node:module';
import { loadModels, rank, format, checkOptions, defaultSource } from '../src/index.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    source: { type: 'string' }, metric: { type: 'string' }, by: { type: 'string' }, models: { type: 'string' },
    json: { type: 'boolean' }, offline: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.version) {
    console.log(createRequire(import.meta.url)('../package.json').version);
  } else if (values.help) {
    console.log(`model-frontier [refresh] [options]

Lists the models no other model beats on both score and cost (or speed):
the Pareto frontier, cheapest first. No inference calls.

SOURCES
  With ARTIFICIAL_ANALYSIS_API_KEY set (free at https://artificialanalysis.ai):
    Artificial Analysis scores, prices, cost per benchmark task and speed.
  Without a key: LMArena WebDev Elo with models.dev prices. No signup.

EXAMPLES
  Best value for money:
    model-frontier

  Coding score instead of intelligence (unscored new models listed separately):
    model-frontier --metric coding

  Fastest model at each score level (subscriptions, where price per token matters less):
    model-frontier --by speed

  Only the models you can use, e.g. from pi:
    model-frontier --models "$(pi --list-models | awk 'NR>1 {print $2}' | paste -sd, -)"

OPTIONS
  --metric intelligence|coding   AA score; default intelligence. LMArena has only its Elo
  --by price|task-cost|speed     Cost axis; default price (blended 3:1 input:output per 1M tokens).
                                 task-cost = AA's cost per benchmark task, includes token use
  --models id,id                 Restrict to these models; provider prefixes and effort variants match
  --source aa|arena              Default aa when a key is set, else arena
  --offline                      Cached data only, even if stale
  --json                         One JSON object on stdout
  refresh                        Re-fetch before ranking

Cache: 24 hours in $XDG_CACHE_HOME/model-frontier (default ~/.cache).
Exit codes: 0 = results, 1 = error (stderr), 2 = no rankable models.`);
  } else {
    if (positionals.length > 1 || (positionals[0] && positionals[0] !== 'refresh')) throw Error('Expected no command or refresh; see --help');
    const models = values.models?.split(',').map(id => id.trim());
    const source = values.source ?? defaultSource();
    const options = { metric: values.metric, by: values.by, models };
    checkOptions(source, options);
    const snapshot = await loadModels({ source, refresh: positionals[0] === 'refresh', offline: values.offline });
    const result = rank(snapshot, options);
    console.log(values.json ? JSON.stringify(result, null, 2) : format(result, { style: styleText }));
    if (!result.models.length) process.exitCode = 2;
  }
} catch (error) {
  console.error(process.argv.includes('--json') ? JSON.stringify({ error: error.message }) : `model-frontier: ${error.message}`);
  process.exitCode = 1;
}
