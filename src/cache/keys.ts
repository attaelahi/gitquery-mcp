/**
 * Cache key generators following the format:
 * `provider:owner/repo:tool:sha(s):normalizedArgs`
 */

function normalizeString(val: string | undefined): string {
  return val ? val.trim().toLowerCase() : '';
}

function normalizeArgs(args: Record<string, unknown>): string {
  const sortedKeys = Object.keys(args).sort();
  const pairs = sortedKeys
    .filter((k) => args[k] !== undefined && args[k] !== null)
    .map((k) => `${k}=${JSON.stringify(args[k])}`);
  return pairs.join('&');
}

export function buildCacheKey(
  provider: string,
  owner: string,
  repo: string,
  tool: string,
  shas: string | string[],
  args: Record<string, unknown> = {}
): string {
  const normOwner = normalizeString(owner);
  const normRepo = normalizeString(repo);
  const normShas = Array.isArray(shas) ? shas.map(normalizeString).join('..') : normalizeString(shas);
  const normArgs = normalizeArgs(args);

  return `${provider}:${normOwner}/${normRepo}:${tool}:${normShas}${normArgs ? `:${normArgs}` : ''}`;
}

export function buildRefResolveKey(
  provider: string,
  owner: string,
  repo: string,
  ref: string
): string {
  return `${provider}:${normalizeString(owner)}/${normalizeString(repo)}:resolveRef:${normalizeString(ref)}`;
}
