import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_FILE = fileURLToPath(new URL('../data/researchers.json', import.meta.url));
const SOURCES = ['scholar', 'openalex'];
const SCHEDULES = new Map([
  ['17 8 * * 1', 'scholar'],
  ['43 8 * * *', 'openalex'],
]);

class CitationError extends Error {}

export function selectSource(source = '', schedule = '') {
  const selected = source || (schedule ? SCHEDULES.get(schedule) : 'all');
  if (selected !== 'all' && !SOURCES.includes(selected)) {
    throw new CitationError('Unknown citation source or schedule.');
  }
  return selected;
}

function validCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CitationError('Response has no valid citation count.');
  }
  return value;
}

export function parseOpenAlex(payload, id) {
  if (payload?.id !== `https://openalex.org/${id}`) {
    throw new CitationError('Response author ID does not match the requested profile.');
  }
  return validCount(payload.cited_by_count);
}

export function parseScholar(payload, id) {
  if (payload?.error || (payload?.search_metadata?.status && payload.search_metadata.status !== 'Success')) {
    throw new CitationError('Provider returned an unsuccessful search.');
  }
  if (payload?.search_parameters?.author_id && payload.search_parameters.author_id !== id) {
    throw new CitationError('Response author ID does not match the requested profile.');
  }
  const table = payload?.cited_by?.table;
  const citations = Array.isArray(table) ? table.find((row) => row?.citations)?.citations : undefined;
  return validCount(citations?.all);
}

async function fetchCount(source, id, { fetchImpl, env, timeoutMs }) {
  let url;
  const headers = { Accept: 'application/json' };
  if (source === 'openalex') {
    if (!/^A\d+$/.test(id)) throw new CitationError('Invalid OpenAlex author ID.');
    url = new URL(`https://api.openalex.org/authors/${id}`);
    url.searchParams.set('select', 'id,cited_by_count');
    if (env.OPENALEX_API_KEY) headers.Authorization = `Bearer ${env.OPENALEX_API_KEY}`;
  } else {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new CitationError('Invalid Google Scholar author ID.');
    if (!env.SERPAPI_API_KEY) throw new CitationError('SERPAPI_API_KEY is not configured.');
    url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google_scholar_author');
    url.searchParams.set('author_id', id);
    url.searchParams.set('hl', 'en');
    url.searchParams.set('api_key', env.SERPAPI_API_KEY);
  }

  let response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch {
    // Fetch errors can contain the request URL, including provider credentials.
    throw new CitationError('Request failed or timed out.');
  }
  if (!response.ok) throw new CitationError(`Provider returned HTTP ${response.status}.`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CitationError('Provider returned invalid JSON.');
  }
  return source === 'openalex' ? parseOpenAlex(payload, id) : parseScholar(payload, id);
}

export async function refreshResearchers(researchers, {
  source = 'all',
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
  timeoutMs = 30_000,
} = {}) {
  const selected = selectSource(source);
  if (!Array.isArray(researchers)) throw new CitationError('Researcher data must be an array.');
  const data = structuredClone(researchers);
  const sources = selected === 'all' ? SOURCES : [selected];
  const result = { data, updated: 0, skipped: 0, errors: [] };
  for (const researcher of data) {
    for (const provider of sources) {
      const profile = researcher[provider];
      if (!profile?.id) {
        result.skipped += 1;
        continue;
      }
      try {
        const citations = await fetchCount(provider, profile.id, { fetchImpl, env, timeoutMs });
        profile.citations = citations;
        profile.updated_at = now().toISOString();
        result.updated += 1;
      } catch (error) {
        result.errors.push({
          researcher: researcher.id,
          source: provider,
          message: error instanceof CitationError ? error.message : 'Unable to refresh this profile.',
        });
      }
    }
  }
  return result;
}

export async function refreshFile(file, options = {}) {
  const original = await readFile(file, 'utf8');
  const result = await refreshResearchers(JSON.parse(original), options);
  const output = `${JSON.stringify(result.data, null, 2)}\n`;
  if (result.updated && output !== original) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, output);
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  let source = process.env.CITATION_SOURCE || '';
  let file = DATA_FILE;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--help') {
      console.log('Usage: node scripts/update-citations.mjs [--source all|scholar|openalex] [--data PATH]');
      return;
    }
    if (!['--source', '--data'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new CitationError('Expected --source all|scholar|openalex or --data PATH.');
    }
    if (args[index] === '--source') source = args[++index];
    else file = resolve(args[++index]);
  }
  const selected = selectSource(source, process.env.CITATION_SCHEDULE || '');
  const result = await refreshFile(file, { source: selected });
  for (const error of result.errors) {
    console.error(`${error.researcher} (${error.source}): ${error.message} Previous count retained.`);
  }
  console.log(`Citation refresh: ${result.updated} updated, ${result.skipped} without a verified profile, ${result.errors.length} failed.`);
  if (result.errors.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof CitationError ? error.message : 'Citation refresh failed; check the data file and file permissions.');
    process.exitCode = 1;
  });
}
