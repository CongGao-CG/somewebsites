import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseOpenAlex, parseScholar, refreshFile, refreshResearchers, selectSource } from '../scripts/update-citations.mjs';

const initial = () => [{
  id: 'researcher',
  name: 'Researcher @ University',
  publication_url: 'https://example.org/publications',
  scholar: { id: 'abcdAAAAAJ', url: 'https://scholar.google.com/citations?user=abcdAAAAAJ', citations: 100, updated_at: '2026-06-05' },
  openalex: { id: 'A123', url: 'https://openalex.org/A123', citations: 80, updated_at: '2026-06-05' },
}];
const now = () => new Date('2026-11-18T08:43:00.000Z');
const response = (payload) => ({ ok: true, json: async () => payload });

test('daily and weekly schedules select only their intended source', () => {
  assert.equal(selectSource('', '43 8 * * *'), 'openalex');
  assert.equal(selectSource('', '17 8 * * 1'), 'scholar');
  assert.equal(selectSource('all'), 'all');
  assert.equal(selectSource('scholar'), 'scholar');
  assert.throws(() => selectSource('', 'unknown'));
  assert.throws(() => selectSource('unknown'));
});

test('workflow cron entries agree with the updater source mappings', async () => {
  const workflow = await readFile(new URL('../.github/workflows/update-citations.yml', import.meta.url), 'utf8');
  const schedules = [...workflow.matchAll(/^\s*- cron: '([^']+)'$/gm)].map((match) => match[1]);
  assert.equal(schedules.length, 2);
  assert.deepEqual(schedules.map((schedule) => selectSource('', schedule)).sort(), ['openalex', 'scholar']);
  for (const schedule of schedules) {
    const [, , dayOfMonth, month, dayOfWeek] = schedule.split(' ');
    assert.equal(dayOfMonth, '*');
    assert.equal(month, '*');
    if (selectSource('', schedule) === 'openalex') assert.equal(dayOfWeek, '*');
    else assert.match(dayOfWeek, /^[0-6]$/);
  }
});

test('a daily refresh updates OpenAlex, accepts zero, and leaves Scholar untouched', async () => {
  const data = initial();
  const result = await refreshResearchers(data, {
    source: 'openalex', now, env: { OPENALEX_API_KEY: 'private-key' },
    fetchImpl: async (url, options) => {
      assert.equal(url.hostname, 'api.openalex.org');
      assert.equal(url.pathname, '/authors/A123');
      assert.equal(options.headers.Authorization, 'Bearer private-key');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return response({ id: 'https://openalex.org/A123', cited_by_count: 0 });
    },
  });
  assert.equal(result.updated, 1);
  assert.equal(result.data[0].openalex.citations, 0);
  assert.equal(result.data[0].openalex.updated_at, now().toISOString());
  assert.deepEqual(result.data[0].scholar, data[0].scholar);
  assert.equal(data[0].openalex.citations, 80);
});

test('Scholar refresh uses the all-time total and leaves the profile link intact', async () => {
  const data = initial();
  const result = await refreshResearchers(data, {
    source: 'scholar', now, env: { SERPAPI_API_KEY: 'private-key' },
    fetchImpl: async (url) => {
      assert.equal(url.hostname, 'serpapi.com');
      assert.equal(url.searchParams.get('author_id'), data[0].scholar.id);
      assert.equal(url.searchParams.get('api_key'), 'private-key');
      return response({
        search_metadata: { status: 'Success' },
        search_parameters: { author_id: data[0].scholar.id },
        cited_by: { table: [{ citations: { all: 123, since_2021: 45 } }] },
      });
    },
  });
  assert.equal(result.data[0].scholar.citations, 123);
  assert.equal(result.data[0].scholar.url, data[0].scholar.url);
  assert.deepEqual(result.data[0].openalex, data[0].openalex);
});

test('missing Scholar credentials do not prevent OpenAlex updates', async () => {
  let requests = 0;
  const data = initial();
  const result = await refreshResearchers(data, {
    now, env: {},
    fetchImpl: async () => {
      requests += 1;
      return response({ id: 'https://openalex.org/A123', cited_by_count: 90 });
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /SERPAPI_API_KEY/);
  assert.deepEqual(result.data[0].scholar, data[0].scholar);
});

test('malformed totals and author mismatches are rejected', () => {
  for (const value of [undefined, null, '100', -1, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseOpenAlex({ id: 'https://openalex.org/A123', cited_by_count: value }, 'A123'));
    assert.throws(() => parseScholar({ cited_by: { table: [{ citations: { all: value } }] } }, 'abcdAAAAAJ'));
  }
  assert.throws(() => parseOpenAlex({ id: 'https://openalex.org/A999', cited_by_count: 100 }, 'A123'));
  assert.throws(() => parseScholar({ search_parameters: { author_id: 'other' }, cited_by: { table: [{ citations: { all: 100 } }] } }, 'abcdAAAAAJ'));
  assert.throws(() => parseScholar({ error: 'secret-containing provider message' }, 'abcdAAAAAJ'));
  assert.throws(() => parseScholar({ search_metadata: { status: 'Processing' }, cited_by: { table: [{ citations: { all: 100 } }] } }, 'abcdAAAAAJ'));
});

test('failed requests preserve count and date without exposing credentials', async () => {
  const data = initial();
  const result = await refreshResearchers(data, {
    source: 'scholar', env: { SERPAPI_API_KEY: 'private-key' },
    fetchImpl: async (url) => { throw new Error(`Network error: ${url}`); },
  });
  assert.deepEqual(result.data, data);
  assert.equal(result.errors.length, 1);
  assert.doesNotMatch(JSON.stringify(result.errors), /private-key|api_key=/);
});

test('HTTP failures, malformed JSON, and mismatched profiles preserve snapshots', async () => {
  for (const mock of [
    async () => ({ ok: false, status: 429 }),
    async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }),
    async () => response({ id: 'https://openalex.org/A999', cited_by_count: 123 }),
  ]) {
    const data = initial();
    const result = await refreshResearchers(data, { source: 'openalex', fetchImpl: mock, env: {} });
    assert.deepEqual(result.data, data);
    assert.equal(result.errors.length, 1);
  }
});

test('unverified profiles never trigger name searches or API requests', async () => {
  const data = initial();
  data[0].scholar.id = null;
  data[0].openalex.id = null;
  const result = await refreshResearchers(data, { fetchImpl: async () => assert.fail('Unexpected request') });
  assert.equal(result.skipped, 2);
  assert.equal(result.updated, 0);
  assert.deepEqual(result.data, data);
});

test('partial successes are written even when another provider fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'citation-refresh-'));
  try {
    const file = join(directory, 'researchers.json');
    await writeFile(file, `${JSON.stringify(initial(), null, 2)}\n`);
    const result = await refreshFile(file, {
      env: {}, now,
      fetchImpl: async () => response({ id: 'https://openalex.org/A123', cited_by_count: 95 }),
    });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(result.errors.length, 1);
    assert.equal(saved[0].openalex.citations, 95);
    assert.equal(saved[0].openalex.updated_at, now().toISOString());
    assert.deepEqual(saved[0].scholar, initial()[0].scholar);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
