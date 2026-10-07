import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { frontier, rank, format, loadModels, checkOptions, matches, ttl } from '../src/index.js';

delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const row = (id, { intelligence = null, coding = null, price = null, taskCost = null, speed = null } = {}) =>
  ({ id, name: id, creator: 'Lab', releaseDate: null, scores: { intelligence, coding }, price, taskCost, speed });
const snapshot = (models, source = 'aa', fetchedAt = Date.now()) => ({ version: 1, source, fetchedAt, models });

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'model-frontier-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function mockFetch(t, respond) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(respond(url)), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
  return requests;
}

test('frontier keeps only rows that score higher than every row costing the same or less', () => {
  const rows = [row('cheap', { intelligence: 30, price: 1 }), row('dominated', { intelligence: 25, price: 2 }), row('mid', { intelligence: 40, price: 2 }),
    row('tie-loser', { intelligence: 35, price: 2 }), row('same-score-pricier', { intelligence: 40, price: 3 }), row('best', { intelligence: 50, price: 8 }), row('unpriced', { intelligence: 90 })];
  assert.deepEqual(frontier(rows, { score: r => r.scores.intelligence, cost: r => r.price }).map(r => r.id), ['cheap', 'mid', 'best']);
});

test('ranks on intelligence by default and on speed as the fastest model per score level', () => {
  const s = snapshot([row('fast', { intelligence: 30, coding: 20, price: 5, speed: 300 }), row('smart', { intelligence: 50, coding: 45, price: 1, speed: 50 })]);
  const result = rank(s);
  assert.equal(result.metric, 'intelligence');
  assert.deepEqual(result.models.map(m => m.id), ['smart']);
  assert.deepEqual(rank(s, { by: 'speed' }).models.map(m => m.id), ['fast', 'smart']);
});

test('coding ranking lists unscored models only where they would extend the frontier on intelligence', () => {
  const s = snapshot([
    row('scored', { intelligence: 40, coding: 60, price: 2 }),
    row('new-release', { intelligence: 48, price: 3 }),
    row('old-weak', { intelligence: 20, price: 4 }),
    row('new-release-low-effort', { intelligence: 45, price: 3 }),
    row('beaten-by-scored', { intelligence: 35, price: 2.5 }),
  ]);
  const result = rank(s, { metric: 'coding' });
  assert.deepEqual(result.models.map(m => m.id), ['scored']);
  assert.deepEqual(result.notYetScored.map(m => m.id), ['new-release']);
  assert.match(format(result), /Not yet scored on coding[\s\S]*new-release/);
  assert.deepEqual(rank(s).notYetScored, []);
  // An unscored model beaten on intelligence by a scored model that is off the coding frontier is still beaten.
  const offFrontier = snapshot([row('a', { intelligence: 40, coding: 60, price: 2 }), row('b', { intelligence: 60, coding: 50, price: 2 }), row('c', { intelligence: 50, price: 3 })]);
  assert.deepEqual(rank(offFrontier, { metric: 'coding' }).notYetScored, []);
});

test('--models accepts provider-qualified IDs, matches effort variants only, and reports misses', () => {
  const s = snapshot(['gpt-6-1-sol-high', 'gpt-6-1-sol-xhigh', 'gpt-6-1-sol-mini', 'gpt-6-high', 'gpt-6-luna-high'].map((id, i) => row(id, { intelligence: 40 + i, price: 1 + i })));
  const ids = queries => rank(s, { models: queries, by: 'price' }).models.map(m => m.id).sort();
  assert.deepEqual(ids(['openai-codex/gpt-6.1-sol']), ['gpt-6-1-sol-high', 'gpt-6-1-sol-xhigh']);
  assert.deepEqual(ids(['gpt-6']), ['gpt-6-high']);
  assert.ok(matches('anthropic/claude-sonnet-4-5', 'claude-sonnet-4-5-20250929-high-32k'));
  assert.ok(matches('gpt-4.1', 'gpt-4-1-2025-04-14'));
  assert.ok(!matches('gpt-4.1', 'gpt-4-1-mini-2025-04-14'));
  assert.deepEqual(rank(s, { models: ['gpt-6', 'claude-nope'] }).unmatched, ['claude-nope']);
});

test('--models explains every requested model left off the frontier', () => {
  const s = snapshot([row('cheap', { intelligence: 50, coding: 40, price: 1 }), row('pricier', { intelligence: 45, coding: 50, price: 4 }), row('weak', { intelligence: 10, coding: 5, price: 0.5 }),
    row('unpriced', { intelligence: 60 }), row('new', { intelligence: 55, price: 2 }), row('other', { intelligence: 99, price: 0.1 }),
    row('gpt-x-low', { intelligence: 20, price: 9 }), row('gpt-x-high', { intelligence: 70, price: 9 }), row('gpt-y-low', { intelligence: 30, price: 9 }), row('gpt-y-high', { intelligence: 40, price: 9 })]);
  const why = options => Object.fromEntries(rank(s, options).excluded.map(e => [e.id, [e.reason, e.dominatedBy]]));
  const all = ['cheap', 'pricier', 'weak', 'unpriced', 'new'];
  assert.deepEqual(why({ models: all, minScore: 20 }), {
    pricier: ['Beaten by cheap: scores at least as high at no higher cost', 'cheap'],
    weak: ['Below minimum score 20', null],
    unpriced: ['No price data', null],
  });
  assert.equal(rank(s, { models: all }).excluded.find(e => e.id === 'weak'), undefined);
  assert.deepEqual(why({ models: all, metric: 'coding' }).new, ['No coding score', null]);
  assert.deepEqual(rank(s, {}).excluded, []);
  assert.deepEqual(rank(s, { models: ['cheap'] }).excluded, []);
  assert.match(format(rank(s, { models: all })), /Not on the frontier:\n {2}pricier: Beaten by cheap/);
  // One entry per requested model, for its strongest variant; variants of a model on the frontier are not listed.
  const variants = rank(s, { models: ['gpt-x', 'gpt-y', 'cheap'] }).excluded;
  assert.deepEqual(variants.map(e => [e.query, e.id, e.dominatedBy]), [['gpt-y', 'gpt-y-high', 'cheap']]);
  assert.equal(rank(s, { models: ['cheap', 'pricier', 'pricier'] }).excluded.length, 1);
  const fast = snapshot([row('quick', { intelligence: 50, speed: 200 }), row('slow', { intelligence: 40, speed: 100 })]);
  assert.deepEqual(rank(fast, { models: ['quick', 'slow'], by: 'speed' }).excluded.map(e => [e.id, e.reason]), [['slow', 'Beaten by quick: scores at least as high and is at least as fast']]);
});

test('--min-score drops models below the floor on the ranked metric', () => {
  const s = snapshot([row('a', { intelligence: 30, price: 1 }), row('b', { intelligence: 50, price: 2 }), row('c', { intelligence: 60, price: 3 })]);
  assert.deepEqual(rank(s, { minScore: 45 }).models.map(m => m.id), ['b', 'c']);
  assert.equal(rank(s, { minScore: 45 }).ranked, 2);
  assert.throws(() => checkOptions('aa', { minScore: Number('x') }), /min-score/);
});

test('the table keeps three significant digits so close prices stay distinct', () => {
  const s = snapshot([row('a', { intelligence: 40, price: 0.0275, taskCost: 0.131, speed: 50 }), row('b', { intelligence: 45, price: 0.54, taskCost: 0.1332, speed: 50 }), row('c', { intelligence: 50, price: 20, taskCost: 123.4, speed: 50 })]);
  const text = format(rank(s, { by: 'task-cost' }));
  for (const value of ['0.0275', '0.131', '0.540', '0.133', '20.0', '123']) assert.ok(text.includes(` ${value}`), value);
});

test('options a source cannot answer fail before any request', () => {
  assert.throws(() => checkOptions('arena', { by: 'speed' }), /needs ARTIFICIAL_ANALYSIS_API_KEY/);
  assert.throws(() => checkOptions('arena', { metric: 'coding' }), /needs ARTIFICIAL_ANALYSIS_API_KEY/);
  assert.throws(() => checkOptions('aa', { by: 'vibes' }), /Unknown axis/);
  assert.throws(() => checkOptions('aa', { models: [' '] }), /non-empty/);
  const result = spawnSync(process.execPath, [cli, '--by', 'speed'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs ARTIFICIAL_ANALYSIS_API_KEY/);
});

test('Artificial Analysis: reads every page with the key, never follows redirects, caches privately without the key', async t => {
  const cache = join(await temp(t), 'aa.json');
  const model = (slug, extra = {}) => ({ slug, name: slug, model_creator: { name: 'Lab' }, release_date: '2026-09-01',
    evaluations: { artificial_analysis_intelligence_index: 40, artificial_analysis_coding_index: null },
    pricing: { price_1m_input_tokens: 2, price_1m_output_tokens: 10 }, performance: { median_output_tokens_per_second: 100 },
    artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 0.3 } }, ...extra });
  const requests = mockFetch(t, url => url.endsWith('page=1')
    ? { data: [model('a')], pagination: { has_more: true } }
    : { data: [model('b', { pricing: { price_1m_input_tokens: 0, price_1m_output_tokens: 0 } })], pagination: { has_more: false } });
  process.env.ARTIFICIAL_ANALYSIS_API_KEY = 'test-secret-key';
  t.after(() => { delete process.env.ARTIFICIAL_ANALYSIS_API_KEY; });

  const s = await loadModels({ source: 'aa', cache });
  assert.equal(requests.length, 2);
  for (const r of requests) {
    assert.equal(r.init.headers['x-api-key'], 'test-secret-key');
    assert.equal(r.init.redirect, 'error');
  }
  assert.deepEqual(s.models.map(m => [m.id, m.price, m.taskCost, m.speed]), [['a', 4, 0.3, 100], ['b', null, 0.3, 100]]);
  assert.equal((await stat(cache)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(cache, 'utf8'), /test-secret-key/);

  await loadModels({ source: 'aa', cache });
  assert.equal(requests.length, 2, 'fresh cache is reused');
  await writeFile(cache, JSON.stringify({ ...s, fetchedAt: Date.now() - ttl }));
  await loadModels({ source: 'aa', cache });
  assert.equal(requests.length, 4, 'stale cache is refetched');
});

test('LMArena: prices each variant from its base model, preferring the first-party entry over its discount tiers, and maps organization names', async t => {
  const cache = join(await temp(t), 'arena.json');
  const arena = [['openai', 'gpt-6-luna-max', 1700], ['openai', 'gpt-6-high', 1650], ['moonshot', 'kimi-k3-max', 1600], ['openai', 'gpt-6-luna-mini', 1500], ['acme', 'unpriced', 1400]];
  mockFetch(t, url => url.startsWith('https://models.dev')
    ? {
      openai: { models: { 'gpt-6': { id: 'gpt-6', canonical_model_id: 'openai/gpt-6', cost: { input: 4, output: 20 } }, 'gpt-6-luna': { id: 'gpt-6-luna', canonical_model_id: 'openai/gpt-6-luna', cost: { input: 1, output: 4 } }, 'gpt-6-contributor': { id: 'gpt-6-contributor', canonical_model_id: 'openai/gpt-6', cost: { input: 0.1, output: 0.2 } } } },
      openrouter: { models: { 'openai/gpt-6-luna': { canonical_model_id: 'openai/gpt-6-luna', cost: { input: 9, output: 9 } }, 'moonshotai/kimi-k3': { canonical_model_id: 'moonshotai/kimi-k3', cost: { input: 2, output: 2 } } } },
      other: { models: { 'kimi-k3': { canonical_model_id: 'moonshotai/kimi-k3', cost: { input: 4, output: 4 } } } },
    }
    : { num_rows_total: arena.length, rows: arena.map(([organization, model_name, rating]) => ({ row: { organization, model_name, rating, category: 'overall' } })) });
  const s = await loadModels({ source: 'arena', cache });
  assert.deepEqual(Object.fromEntries(s.models.map(m => [m.id, m.price])), { 'gpt-6-luna-max': 1.75, 'gpt-6-high': 8, 'kimi-k3-max': 3, 'gpt-6-luna-mini': null, unpriced: null });
});

test('the CLI names its data source in text and JSON output', async t => {
  const dir = await temp(t);
  await mkdir(join(dir, 'model-frontier'), { recursive: true });
  await writeFile(join(dir, 'model-frontier', 'arena.json'), JSON.stringify(snapshot([{ ...row('m'), scores: { arena: 1500 }, price: 2 }], 'arena')));
  const env = { PATH: process.env.PATH, XDG_CACHE_HOME: dir };
  const text = spawnSync(process.execPath, [cli, '--offline'], { encoding: 'utf8', env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /lmarena-ai\/leaderboard-dataset\), CC BY 4\.0 \(https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/\)/);
  const json = JSON.parse(spawnSync(process.execPath, [cli, '--offline', '--json'], { encoding: 'utf8', env }).stdout);
  assert.match(json.attribution, /LMArena/);
  assert.deepEqual(json.models.map(m => m.id), ['m']);
});

test('margin shows up to three close alternatives per cost tier without relaxing the score floor', () => {
  const s = snapshot([
    row('cheap', { intelligence: 40, price: 1 }),
    row('same-price', { intelligence: 39, price: 1 }),
    row('near', { intelligence: 38, price: 2 }),
    row('third', { intelligence: 37, price: 3 }),
    row('fourth', { intelligence: 36, price: 3 }),
    row('far', { intelligence: 34, price: 2 }),
    row('best', { intelligence: 50, price: 4 }),
    row('best-tie', { intelligence: 49, price: 4 }),
    row('past-tier', { intelligence: 39, price: 4 }),
    row('too-pricey', { intelligence: 49, price: 5 }),
    row('unpriced', { intelligence: 39 }), row('unscored', { price: 1 }),
  ]);
  assert.deepEqual(rank(s).models.map(m => m.id), ['cheap', 'best']);
  assert.deepEqual(rank(s).alternatives, []);
  const result = rank(s, { margin: 5 });
  assert.deepEqual(result.alternatives.map(m => [m.id, m.alternativeTo, m.scoreGap]), [
    ['same-price', 'cheap', 1], ['near', 'cheap', 2], ['third', 'cheap', 3], ['best-tie', 'best', 1],
  ]);
  assert.deepEqual(rank(s, { margin: 5, minScore: 39 }).alternatives.map(m => m.id), ['same-price', 'best-tie']);
  assert.deepEqual(rank(s, { margin: 1 }).alternatives.map(m => m.id), ['same-price', 'best-tie']);
  assert.match(format(result), /Indented: alternatives within 5 points/);
  assert.match(format(result), /\n\s+same-price\s+39\.0/);
  assert.match(format(result), /4 more models omitted/);
  const styled = format(result, { style: (name, text) => `<${name}>${text}</${name}>` }).split('\n');
  assert.match(styled.find(line => line.includes('same-price')), /^<dim>.*same-price.*<\/dim>$/);
  assert.match(styled.find(line => /\bcheap\s+40\.0/.test(line)), /^1\s+cheap/);
  const requested = rank(s, { margin: 5, models: ['cheap', 'near', 'far', 'best'] });
  assert.deepEqual(requested.excluded.map(m => m.id), ['far']);
  assert.deepEqual(rank(snapshot([]), { margin: 5 }).alternatives, []);
});

test('decimal margins include exact-boundary contenders and expose clean gaps with stable tie ordering', () => {
  const s = snapshot([row('best', { intelligence: 50.2, price: 1 }),
    ...['z', 'a', 'Z', 'A'].map(id => row(id, { intelligence: 48.1, price: 1 }))]);
  assert.deepEqual(rank(s, { margin: 2.1 }).alternatives.map(m => [m.id, m.scoreGap]), [['A', 2.1], ['Z', 2.1], ['a', 2.1]]);
  assert.deepEqual(rank(s, { margin: 2.09 }).alternatives, []);
  for (const margin of [-1, NaN, Infinity, '5', null]) assert.throws(() => checkOptions('aa', { margin }), /margin must be a non-negative number/);
  assert.throws(() => rank(s, { margin: -1 }), /margin must be a non-negative number/);
});

test('alternatives use the selected coding metric and task-cost or speed axis', () => {
  const s = snapshot([
    row('a', { intelligence: 20, coding: 50, taskCost: 1, speed: 300 }),
    row('b', { intelligence: 80, coding: 47, taskCost: 2, speed: 200 }),
    row('c', { intelligence: 30, coding: 60, taskCost: 3, speed: 100 }),
    row('no-coding', { intelligence: 90, taskCost: 2, speed: 200 }),
  ]);
  for (const by of ['task-cost', 'speed']) {
    const result = rank(s, { metric: 'coding', by, margin: 3 });
    assert.deepEqual(result.models.map(m => m.id), ['a', 'c']);
    assert.deepEqual(result.alternatives.map(m => [m.id, m.alternativeTo, m.scoreGap]), [['b', 'a', 3]]);
    assert.deepEqual(result.notYetScored.map(m => m.id), ['no-coding']);
  }
});

test('CLI defaults to close contenders on each source and accepts strict or explicit margins', async t => {
  const dir = await temp(t);
  await mkdir(join(dir, 'model-frontier'));
  const aa = [row('a', { intelligence: 40, price: 1 }), row('b', { intelligence: 35, price: 1 }), row('c', { intelligence: 34, price: 1 })];
  const arena = aa.map((m, i) => ({ ...m, scores: { arena: [1500, 1450, 1449][i] } }));
  for (const [source, models, margin] of [['aa', aa, 5], ['arena', arena, 50]]) {
    await writeFile(join(dir, 'model-frontier', `${source}.json`), JSON.stringify(snapshot(models, source)));
    const run = args => spawnSync(process.execPath, [cli, '--source', source, '--offline', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, XDG_CACHE_HOME: dir } });
    const defaults = run(['--json']);
    assert.equal(defaults.status, 0, defaults.stderr);
    const result = JSON.parse(defaults.stdout);
    assert.equal(result.margin, margin);
    assert.deepEqual(result.models.map(m => m.id), ['a']);
    assert.deepEqual(result.alternatives.map(m => m.id), ['b']);
    assert.match(run([]).stdout, new RegExp(`Indented: alternatives within ${margin} points`));
    assert.deepEqual(JSON.parse(run(['--json', '--margin', '0']).stdout).alternatives, []);
    assert.deepEqual(JSON.parse(run(['--json', '--margin', String(margin + 1)]).stdout).alternatives.map(m => m.id), ['b', 'c']);
  }
  for (const margin of ['-1', 'NaN', 'Infinity', '']) {
    const bad = spawnSync(process.execPath, [cli, `--margin=${margin}`, '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, XDG_CACHE_HOME: await temp(t) } });
    assert.equal(bad.status, 1);
    assert.match(JSON.parse(bad.stderr).error, /margin/);
  }
});

test('provider filters model makers before frontier, alternatives and missing-score ranking', () => {
  const s = snapshot([
    { ...row('other', { intelligence: 90, coding: 90, price: 0.5 }), creator: 'OpenAI' },
    { ...row('grok-small', { intelligence: 40, coding: 40, price: 1 }), creator: 'xAI' },
    { ...row('grok-close', { intelligence: 38, coding: 38, price: 1 }), creator: 'xAI' },
    { ...row('grok-new', { intelligence: 60, price: 2 }), creator: 'SpaceXAI' },
    { ...row('unknown-maker', { intelligence: 99, price: 0.1 }), creator: null },
  ]);
  const result = rank(s, { provider: ' XAI ', metric: 'coding', margin: 5 });
  assert.equal(result.provider, 'xai');
  assert.deepEqual(rank(s, { provider: 'SpaceXAI' }).models.map(m => m.id), ['grok-small', 'grok-new']);
  assert.deepEqual(result.models.map(m => m.id), ['grok-small']);
  assert.deepEqual(result.alternatives.map(m => m.id), ['grok-close']);
  assert.deepEqual(result.notYetScored.map(m => m.id), ['grok-new']);
  assert.equal(result.ranked, 2);
  assert.match(format(result), /provider: xai/);
  const selected = rank(s, { provider: 'xai', models: ['grok-small', 'other'] });
  assert.deepEqual(selected.models.map(m => m.id), ['grok-small']);
  assert.deepEqual(selected.unmatched, ['other']);
  assert.deepEqual(rank(s, { provider: 'openrouter' }).models, []);
  assert.deepEqual(rank(s, { provider: 'ai' }).models, [], 'maker matching is exact, not a substring');
  const arena = snapshot(s.models.map(m => ({ ...m, creator: m.creator?.toLowerCase() ?? null, scores: { arena: m.scores.intelligence } })), 'arena');
  assert.deepEqual(rank(arena, { provider: 'xAI' }).models.map(m => m.id), ['grok-small', 'grok-new']);
  assert.equal(checkOptions('aa', { provider: '\txai\n' }).provider, 'xai');
  assert.equal(Object.hasOwn(checkOptions('aa'), 'provider'), false);
  assert.equal(Object.hasOwn(rank(s), 'provider'), false);
  for (const provider of ['', ' ', 1, null, 'x\nai', 'x\x85ai']) assert.throws(() => checkOptions('aa', { provider }), /provider/);
});

test('multiple providers share one frontier and intersect model IDs', () => {
  const s = snapshot([
    { ...row('gpt', { intelligence: 40, price: 1 }), creator: 'OpenAI' },
    { ...row('claude', { intelligence: 50, price: 2 }), creator: 'Anthropic' },
    { ...row('claude-close', { intelligence: 48, price: 2 }), creator: 'Anthropic' },
    { ...row('grok', { intelligence: 90, price: 0.1 }), creator: 'xAI' },
  ]);
  const result = rank(s, { provider: '\tOpenAI,\n ANTHROPIC,openai\n ', margin: 5 });
  assert.equal(result.provider, 'openai,anthropic');
  assert.deepEqual(result.models.map(m => m.id), ['gpt', 'claude']);
  assert.deepEqual(result.alternatives.map(m => m.id), ['claude-close']);
  assert.equal(result.ranked, 3);
  assert.deepEqual(rank(s, { provider: 'openai,xai' }).models.map(m => m.id), ['grok'], 'selected makers compete on one frontier');
  const selected = rank(s, { provider: 'openai,anthropic', models: ['gpt', 'grok'] });
  assert.deepEqual(selected.models.map(m => m.id), ['gpt']);
  assert.deepEqual(selected.unmatched, ['grok']);
  assert.equal(checkOptions('aa', { provider: 'xai,SpaceXAI' }).provider, 'xai');
  for (const provider of ['openai,', ',anthropic', 'openai,,anthropic', 'openai, ']) assert.throws(() => checkOptions('aa', { provider }), /provider/);
});

test('CLI provider option filters both sources and rejects empty input before loading data', async t => {
  const dir = await temp(t);
  await mkdir(join(dir, 'model-frontier'));
  for (const source of ['aa', 'arena']) {
    const models = [{ ...row('grok', { intelligence: 40, price: 1 }), creator: 'xAI' },
      { ...row('other', { intelligence: 90, price: 0.1 }), creator: 'OpenAI' }];
    if (source === 'arena') for (const m of models) m.scores = { arena: m.scores.intelligence };
    await writeFile(join(dir, 'model-frontier', `${source}.json`), JSON.stringify(snapshot(models, source)));
    const run = args => spawnSync(process.execPath, [cli, '--source', source, '--offline', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, XDG_CACHE_HOME: dir } });
    const out = run(['--provider', 'XAI', '--json']);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout).models.map(m => m.id), ['grok']);
    assert.match(run(['--provider', 'xai']).stdout, /provider: xai/);
    assert.equal(run(['--provider', 'not-a-maker']).status, 2);
    const multiple = run(['--provider', ' XAI, OpenAI ', '--json']);
    assert.equal(multiple.status, 0, multiple.stderr);
    assert.equal(JSON.parse(multiple.stdout).provider, 'xai,openai');
    assert.deepEqual(JSON.parse(multiple.stdout).models.map(m => m.id), ['other']);
    assert.equal(run(['--provider', 'xai,']).status, 1);
  }
  const bad = spawnSync(process.execPath, [cli, '--provider=', '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, XDG_CACHE_HOME: await temp(t) } });
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stderr).error, /provider/);
});

test('a corrupt cache fails loudly instead of being silently replaced', async t => {
  const cache = join(await temp(t), 'aa.json');
  await writeFile(cache, JSON.stringify({ version: 1, source: 'aa', fetchedAt: Date.now(), models: [{ id: 'x' }] }));
  await assert.rejects(loadModels({ source: 'aa', cache, offline: true }), /Invalid snapshot model in .*refresh/);
});

test('a malformed API key never appears in errors, in the library or either CLI output mode', async t => {
  const secret = 'FAKE_SECRET_VALUE\nSUFFIX';
  process.env.ARTIFICIAL_ANALYSIS_API_KEY = secret;
  t.after(() => { delete process.env.ARTIFICIAL_ANALYSIS_API_KEY; });
  const requests = mockFetch(t, () => ({}));
  const error = await loadModels({ source: 'aa', cache: join(await temp(t), 'aa.json') }).catch(e => e);
  assert.match(error.message, /invalid|whitespace/i);
  assert.doesNotMatch(error.message, /FAKE_SECRET/);
  assert.equal(requests.length, 0);
  for (const args of [[], ['--json']]) {
    const out = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, XDG_CACHE_HOME: await temp(t), ARTIFICIAL_ANALYSIS_API_KEY: secret } });
    assert.equal(out.status, 1);
    assert.doesNotMatch(out.stdout + out.stderr, /FAKE_SECRET/);
  }
});

test('a cache missing score keys or with an impossible timestamp is rejected', async t => {
  const cache = join(await temp(t), 'aa.json');
  const valid = row('x', { intelligence: 40, price: 1 });
  for (const bad of [{ ...snapshot([{ ...valid, scores: {} }]) }, { ...snapshot([valid]), fetchedAt: 1e100 }, { ...snapshot([valid]), fetchedAt: Date.now() + 365 * 86400000 }]) {
    await writeFile(cache, JSON.stringify(bad));
    await assert.rejects(loadModels({ source: 'aa', cache, offline: true }), /Invalid snapshot/);
  }
});

test('the reseller median averages the two middle prices', async t => {
  mockFetch(t, url => url.startsWith('https://models.dev')
    ? { a: { models: { m: { canonical_model_id: 'lab/m', cost: { input: 2, output: 2 } } } }, b: { models: { m: { canonical_model_id: 'lab/m', cost: { input: 6, output: 6 } } } } }
    : { num_rows_total: 1, rows: [{ row: { organization: 'lab', model_name: 'm', rating: 1500, category: 'overall' } }] });
  const s = await loadModels({ source: 'arena', cache: join(await temp(t), 'arena.json') });
  assert.equal(s.models[0].price, 4);
});

test('truncated or inconsistent LMArena pages fail instead of being cached', async t => {
  const cache = join(await temp(t), 'arena.json');
  const one = { row: { organization: 'lab', model_name: 'm', rating: 1500, category: 'overall' } };
  for (const arena of [{ num_rows_total: 201, rows: [] }, { num_rows_total: Number.MAX_SAFE_INTEGER, rows: [one] }, { num_rows_total: 2, rows: [one] }]) {
    mockFetch(t, url => url.startsWith('https://models.dev') ? {} : arena);
    await assert.rejects(loadModels({ source: 'arena', cache, refresh: true }), /LMArena/);
  }
  await assert.rejects(readFile(cache), { code: 'ENOENT' });
});
