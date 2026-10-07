import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const sources = {
  aa: {
    name: 'Artificial Analysis',
    api: 'https://artificialanalysis.ai/api/v2/language/models/free',
    attribution: 'Source: Artificial Analysis (https://artificialanalysis.ai)',
    metrics: ['intelligence', 'coding'],
    axes: ['price', 'task-cost', 'speed'],
  },
  arena: {
    name: 'LMArena WebDev',
    api: 'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai%2Fleaderboard-dataset&config=webdev&split=latest',
    prices: 'https://models.dev/api.json',
    attribution: 'Scores: LMArena WebDev leaderboard (https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), filtered and ranked by model-frontier · Prices: models.dev (https://models.dev)',
    metrics: ['arena'],
    axes: ['price'],
  },
};
export const ttl = 24 * 60 * 60 * 1000;
export const defaultSource = () => process.env.ARTIFICIAL_ANALYSIS_API_KEY ? 'aa' : 'arena';
export const cachePath = source => join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'model-frontier', `${source}.json`);

const normalize = id => id.toLowerCase().replace(/[._]/g, '-');
// Effort, thinking-budget ("-32k") and date ("-20250929", "-2025-04-14") suffixes name a variant of the same model;
// any other suffix ("-mini", "-5-max") is a different model.
const variant = /^(-(minimal|low|medium|high|xhigh|max|thinking|reasoning|non-reasoning|adaptive|\d+k|\d{4}-\d{2}-\d{2}|\d{4}|\d{8}))*( \([^)]*\))?$/;

// Accepts provider-qualified IDs ("openai-codex/gpt-5.6-sol") and matches every effort variant of the model.
export function matches(query, id) {
  const q = normalize(query.split('/').pop());
  const n = normalize(id);
  return n.startsWith(q) && variant.test(n.slice(q.length));
}

// Artificial Analysis' 3:1 input:output blend. AA lists 0/0 for models it has no price for, including paid ones.
const blended = (input, output) => Number.isFinite(input) && Number.isFinite(output) && (input || output) ? (3 * input + output) / 4 : null;
const finite = value => Number.isFinite(value) ? value : null;
const positive = value => Number.isFinite(value) && value > 0 ? value : null;

async function fetchJson(url, headers, signal) {
  // fetch keeps custom headers like x-api-key across redirects, so authenticated requests must not follow them.
  const timeout = AbortSignal.timeout(30000);
  const response = await fetch(url, { headers, redirect: headers ? 'error' : 'follow', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw Error(`${url.split('?')[0]}: HTTP ${response.status}`);
  return response.json();
}

async function fetchAA(signal) {
  const key = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  // fetch puts an invalid header value into its error message, which would print the key.
  if (!/^[\x21-\x7e]+$/.test(key)) throw Error('ARTIFICIAL_ANALYSIS_API_KEY contains whitespace or non-ASCII characters');
  const headers = { 'x-api-key': key };
  const models = [];
  for (let page = 1; ; page++) {
    if (page > 20) throw Error('Artificial Analysis returned more than 20 pages');
    const body = await fetchJson(`${sources.aa.api}?page=${page}`, headers, signal);
    if (!Array.isArray(body?.data) || typeof body.pagination?.has_more !== 'boolean') throw Error('Unexpected Artificial Analysis response');
    models.push(...body.data);
    if (!body.pagination.has_more) break;
  }
  return models.map(m => ({
    id: m.slug,
    name: m.name,
    creator: m.model_creator?.name ?? null,
    releaseDate: m.release_date ?? null,
    scores: { intelligence: finite(m.evaluations?.artificial_analysis_intelligence_index), coding: finite(m.evaluations?.artificial_analysis_coding_index) },
    price: blended(m.pricing?.price_1m_input_tokens, m.pricing?.price_1m_output_tokens),
    taskCost: positive(m.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost),
    speed: positive(m.performance?.median_output_tokens_per_second),
  }));
}

// LMArena organizations whose models.dev canonical prefix differs.
const organizations = { moonshot: 'moonshotai', zai: 'zhipuai', bytedance: 'bytedance-seed', thinky: 'thinkingmachines' };
function median(values) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b), mid = sorted.length / 2;
  return Number.isInteger(mid) ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
}

// One price per canonical model: the first-party provider's own entry when models.dev lists it, else the median of all others.
// First-party providers also list discounted program tiers ("muse-spark-1.3-contributor") under the same canonical ID.
function canonicalPrices(catalog) {
  if (!catalog || typeof catalog !== 'object') throw Error('Unexpected models.dev response');
  const byId = new Map();
  for (const [provider, { models } = {}] of Object.entries(catalog)) for (const m of Object.values(models ?? {})) {
    const price = blended(m?.cost?.input, m?.cost?.output);
    if (typeof m?.canonical_model_id !== 'string' || price === null) continue;
    const entry = byId.get(m.canonical_model_id) ?? { resellers: [], releaseDate: m.release_date ?? null };
    byId.set(m.canonical_model_id, entry);
    const [org, name] = m.canonical_model_id.split('/');
    if (provider === org && m.id === name) entry.firstParty = price;
    else entry.resellers.push(price);
  }
  return [...byId].map(([id, e]) => ({ id, price: e.firstParty ?? median(e.resellers), releaseDate: e.releaseDate }));
}

const arenaPageSize = 100, arenaMaxRows = 5000;

async function fetchArena(signal) {
  // Every page must report the same total and hold exactly the rows its offset promises, so a truncated response is never cached.
  const page = (offset, total) => fetchJson(`${sources.arena.api}&offset=${offset}&length=${arenaPageSize}`, undefined, signal).then(p => {
    const rows = p?.num_rows_total;
    if (!Array.isArray(p?.rows) || !Number.isSafeInteger(rows) || rows < 1 || rows > arenaMaxRows) throw Error('Unexpected LMArena response');
    if ((total !== undefined && rows !== total) || p.rows.length !== Math.min(arenaPageSize, rows - offset)) throw Error('Inconsistent LMArena pages');
    return p;
  });
  const [first, catalog] = await Promise.all([page(0), fetchJson(sources.arena.prices, undefined, signal)]);
  const rest = await Promise.all(Array.from({ length: Math.ceil(first.num_rows_total / arenaPageSize) - 1 }, (_, i) => page((i + 1) * arenaPageSize, first.num_rows_total)));
  const prices = canonicalPrices(catalog);
  return [first, ...rest].flatMap(p => p.rows).map(r => r.row).filter(r => r.category === 'overall').map(r => {
    const org = organizations[r.organization] ?? r.organization;
    // Longest base wins, so "gpt-6-luna-max" prices as gpt-6-luna, not gpt-6.
    const priced = prices.filter(p => p.id.startsWith(`${org}/`) && matches(p.id, r.model_name)).sort((a, b) => b.id.length - a.id.length)[0];
    return { id: r.model_name, name: r.model_name, creator: r.organization, releaseDate: priced?.releaseDate ?? null, scores: { arena: finite(r.rating) }, price: priced?.price ?? null, taskCost: null, speed: null };
  });
}

const fetchers = { aa: fetchAA, arena: fetchArena };

function validate(snapshot, source) {
  const fetchedAt = snapshot?.fetchedAt;
  if (snapshot?.version !== 1 || snapshot.source !== source || !Number.isSafeInteger(fetchedAt) || fetchedAt <= 0 || fetchedAt > Date.now() + 60000 || !Array.isArray(snapshot.models)) throw Error('Invalid snapshot');
  for (const m of snapshot.models) {
    if (typeof m?.id !== 'string' || !m.id || typeof m.name !== 'string' || !m.scores || typeof m.scores !== 'object') throw Error('Invalid snapshot model');
    // Every score key of the source must be present: a missing one would read as undefined and slip past null checks.
    for (const value of [...sources[source].metrics.map(k => m.scores[k]), m.price, m.taskCost, m.speed]) if (value !== null && !Number.isFinite(value)) throw Error(`Invalid snapshot value for ${m.id}`);
  }
  return snapshot;
}

async function readCache(path, source) {
  let snapshot;
  try { snapshot = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw Error(`Unreadable cache ${path}: ${error.message}`); }
  try { return validate(snapshot, source); }
  catch (error) { throw Error(`${error.message} in ${path}; run model-frontier refresh`); }
}

export async function loadModels({ source = defaultSource(), cache = cachePath(source), refresh = false, offline = false, signal } = {}) {
  if (!(source in fetchers)) throw Error(`Unknown source: ${source} (expected aa or arena)`);
  if (offline && refresh) throw Error('offline and refresh cannot be combined');
  const existing = refresh ? undefined : await readCache(cache, source);
  if (existing && (offline || Date.now() - existing.fetchedAt < ttl)) return existing;
  if (offline) throw Error(`No cached ${source} data at ${cache}; run model-frontier refresh`);
  if (source === 'aa' && !process.env.ARTIFICIAL_ANALYSIS_API_KEY) throw Error('Source aa needs ARTIFICIAL_ANALYSIS_API_KEY (free at https://artificialanalysis.ai); omit --source to use LMArena without a key');
  const snapshot = validate({ version: 1, source, fetchedAt: Date.now(), models: await fetchers[source](signal) }, source);
  await mkdir(dirname(cache), { recursive: true });
  const temp = `${cache}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(temp, cache);
  return snapshot;
}

// Pareto frontier, lowest cost first: each row scores higher than every row that costs the same or less.
export function frontier(rows, { score, cost }) {
  const sorted = rows.filter(r => Number.isFinite(score(r)) && Number.isFinite(cost(r)))
    .sort((a, b) => cost(a) - cost(b) || score(b) - score(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kept = [];
  for (const r of sorted) if (!kept.length || score(r) > score(kept.at(-1))) kept.push(r);
  return kept;
}

// Speed is better when higher, so it ranks as negative cost.
const axes = { price: r => r.price, 'task-cost': r => r.taskCost, speed: r => r.speed === null ? null : -r.speed };

// Separate from rank so callers can reject bad options before spending API requests.
export function checkOptions(sourceId, { metric, by = 'price', models: queries, minScore, margin = 0 } = {}) {
  const source = sources[sourceId];
  if (!source) throw Error(`Unknown source: ${sourceId} (expected aa or arena)`);
  metric ??= source.metrics[0];
  if (!source.metrics.includes(metric)) throw Error(`Metric ${metric} needs ${metric === 'arena' ? 'source arena' : 'ARTIFICIAL_ANALYSIS_API_KEY'}; ${source.name} has ${source.metrics.join(', ')}`);
  if (!(by in axes)) throw Error(`Unknown axis: ${by} (expected price, task-cost or speed)`);
  if (!source.axes.includes(by)) throw Error(`--by ${by} needs ARTIFICIAL_ANALYSIS_API_KEY; ${source.name} only has prices`);
  if (queries !== undefined && (!Array.isArray(queries) || queries.some(q => typeof q !== 'string' || !q.trim()))) throw Error('models must be non-empty IDs');
  if (minScore !== undefined && !Number.isFinite(minScore)) throw Error('min-score must be a number');
  if (!Number.isFinite(margin) || margin < 0) throw Error('margin must be a non-negative number');
  return { metric, by, queries, minScore, margin };
}

export function rank(snapshot, options = {}) {
  const source = sources[snapshot.source];
  const { metric, by, queries, minScore, margin } = checkOptions(snapshot.source, options);
  const rows = queries ? snapshot.models.filter(r => queries.some(q => matches(q, r.id))) : snapshot.models;
  const cost = axes[by];
  const scored = rows.filter(r => minScore === undefined || !(r.scores[metric] < minScore));
  const front = frontier(scored, { score: r => r.scores[metric], cost });
  // A contender belongs to the last frontier row at its cost or less, before the next tier.
  // Above the final tier there is no cost ceiling, so only contenders at that row's cost qualify.
  const alternatives = [];
  if (margin > 0) for (const [i, parent] of front.entries()) {
    const next = front[i + 1];
    const gap = r => Math.round((parent.scores[metric] - r.scores[metric]) * 1e6) / 1e6;
    const candidates = scored.filter(r => !front.includes(r) && Number.isFinite(r.scores[metric]) && Number.isFinite(cost(r))
      && cost(r) >= cost(parent) && (next ? cost(r) < cost(next) : cost(r) === cost(parent))
      && gap(r) <= margin);
    candidates.sort((a, b) => b.scores[metric] - a.scores[metric] || cost(a) - cost(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    alternatives.push(...candidates.slice(0, 3).map(r => ({ ...r, alternativeTo: parent.id, scoreGap: gap(r) })));
  }
  // Coding scores lag new releases. Show unscored models that sit on the intelligence frontier of all models.
  const notYetScored = metric === 'coding' ? frontier(rows, { score: r => r.scores.intelligence, cost }).filter(r => r.scores.coding === null) : [];
  const view = r => ({ id: r.id, name: r.name, creator: r.creator, releaseDate: r.releaseDate, score: r.scores[metric], scores: r.scores, price: r.price, taskCost: r.taskCost, speed: r.speed });
  // A requested model never vanishes without a reason. One entry per query with no listed variant,
  // for its most informative variant: beaten first, then below the floor, unpriced, unscored.
  const score = r => r.scores[metric];
  const status = r => score(r) === null ? 3 : !Number.isFinite(cost(r)) ? 2 : score(r) < minScore ? 1 : 0;
  const excluded = [...new Set(queries)].flatMap(query => {
    const variants = rows.filter(r => matches(query, r.id));
    if (!variants.length || variants.some(r => front.includes(r) || alternatives.some(a => a.id === r.id))) return [];
    const r = variants.sort((a, b) => status(a) - status(b) || (score(b) ?? 0) - (score(a) ?? 0))[0];
    const beater = status(r) === 0 ? front.find(f => score(f) >= score(r)) : null;
    const reason = [`Beaten by ${beater?.name}: scores at least as high ${by === 'speed' ? 'and is at least as fast' : 'at no higher cost'}`, `Below minimum score ${minScore}`,
      `No ${{ price: 'price', 'task-cost': 'task cost', speed: 'speed' }[by]} data`, `No ${metric === 'arena' ? 'LMArena' : metric} score`][status(r)];
    return [{ query, ...view(r), reason, dominatedBy: beater?.id ?? null }];
  });
  return {
    source: snapshot.source,
    attribution: source.attribution,
    metric, by, margin,
    fetchedAt: snapshot.fetchedAt,
    stale: Date.now() - snapshot.fetchedAt >= ttl,
    models: front.map(view),
    alternatives: alternatives.map(r => ({ ...view(r), alternativeTo: r.alternativeTo, scoreGap: r.scoreGap })),
    notYetScored: notYetScored.map(view),
    excluded,
    unmatched: queries?.filter(q => !snapshot.models.some(r => matches(q, r.id))) ?? [],
    ranked: scored.filter(r => Number.isFinite(r.scores[metric]) && Number.isFinite(cost(r))).length,
  };
}

const labels = { intelligence: 'intelligence', coding: 'coding', arena: 'LMArena Elo', price: '$ per 1M tokens', 'task-cost': '$ per benchmark task', speed: 'output tokens/s' };
const money = value => value === null ? '' : value >= 100 ? value.toFixed(0) : value.toPrecision(3);

// style defaults to plain text so JSON and tool consumers never get ANSI codes; the CLI passes util.styleText.
export function format(result, { style = (_, text) => text } = {}) {
  const aa = result.source === 'aa';
  const header = ['#', 'MODEL', 'SCORE', '$/1M', ...(aa ? ['$/TASK', 'TOK/S'] : [])];
  const cells = (r, n) => [n, r.name, r.score?.toFixed(aa ? 1 : 0) ?? '', money(r.price), ...(aa ? [money(r.taskCost), r.speed?.toFixed(0) ?? ''] : [])];
  const table = rows => {
    const all = [header, ...rows];
    const widths = header.map((_, col) => Math.max(...all.map(row => row[col].length)));
    return all.map(row => row.map((cell, col) => col < 2 ? cell.padEnd(widths[col]) : cell.padStart(widths[col])).join('  ').trimEnd());
  };
  const lines = [
    `${style('bold', `Frontier: ${labels[result.metric]} vs ${labels[result.by]}`)} ${style('dim', `· ${sources[result.source].name}`)}`,
    style('dim', result.by === 'speed' ? 'Each numbered row is slower and scores higher than the one above.' : 'Each numbered row costs more and scores higher than the one above.'),
  ];
  const alternatives = result.alternatives ?? [];
  if (result.margin > 0) lines.push(style('dim', `Indented: alternatives within ${result.margin} points in the same ${result.by === 'speed' ? 'speed' : 'cost'} tier (up to three per row).`));
  if (result.stale) lines.push(style('yellow', 'STALE cached data; run model-frontier refresh'));
  const listed = result.models.flatMap((r, i) => [{ ...r, number: String(i + 1) },
    ...alternatives.filter(a => a.alternativeTo === r.id).map(a => ({ ...a, name: `  ${a.name}`, number: '' }))]);
  const front = table(listed.map(r => cells(r, r.number)));
  lines.push('', style('dim', front[0]), ...front.slice(1).map((line, i) => listed[i].alternativeTo ? style('dim', line) : line));
  if (!result.models.length) lines.push('No rankable models.');
  if (result.notYetScored.length) {
    const rows = table(result.notYetScored.map(r => cells({ ...r, score: r.scores.intelligence }, '')));
    lines.push('', style('bold', 'Not yet scored on coding'), style('dim', 'SCORE is intelligence; no model beats these on intelligence at their cost.'), ...rows.slice(1));
  }
  if (result.excluded.length) lines.push('', style('bold', 'Not on the frontier:'), ...result.excluded.map(r => `  ${r.name}: ${r.reason}`));
  const footer = [`${result.ranked - result.models.length - alternatives.length} more models omitted: each is beaten or matched on score and ${result.by === 'speed' ? 'speed' : 'cost'} by a listed one.`];
  if (result.unmatched.length) footer.push(`No match: ${result.unmatched.join(', ')}`);
  footer.push(`Data from ${new Date(result.fetchedAt).toISOString()}. Benchmarks, not your task.`, result.attribution);
  lines.push('', ...footer.map(line => style('dim', line)));
  return lines.join('\n');
}
