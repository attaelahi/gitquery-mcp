import { z } from 'zod';

const ConfigSchema = z.object({
  GITHUB_TOKEN: z.string().optional().transform((val) => (val && val.trim().length > 0 ? val.trim() : undefined)),
  ALLOWED_REPOS: z.string().optional().default('').transform((val) => {
    if (!val || val.trim().length === 0) return [];
    return val
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0);
  }),
  CACHE_SIZE: z.coerce.number().int().positive().default(5000),
  CACHE_TTL_MUTABLE_SECONDS: z.coerce.number().int().positive().default(30),
  GITQUERY_CACHE_DIR: z.string().optional().transform((val) => (val && val.trim().length > 0 ? val.trim() : undefined)),
  DISK_CACHE_DIR: z.string().optional().transform((val) => (val && val.trim().length > 0 ? val.trim() : undefined)),
  GITQUERY_CACHE_MAX_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024), // 200 MB default
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type RawConfig = z.infer<typeof ConfigSchema>;

export interface AppConfig {
  githubToken?: string;
  allowedRepos: string[];
  cacheSize: number;
  cacheTtlMutableSeconds: number;
  diskCacheDir?: string;
  diskCacheMaxBytes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const formatted = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Configuration validation failed: ${formatted}`);
  }

  const cacheDir = parsed.data.GITQUERY_CACHE_DIR || parsed.data.DISK_CACHE_DIR;

  return {
    githubToken: parsed.data.GITHUB_TOKEN,
    allowedRepos: parsed.data.ALLOWED_REPOS,
    cacheSize: parsed.data.CACHE_SIZE,
    cacheTtlMutableSeconds: parsed.data.CACHE_TTL_MUTABLE_SECONDS,
    diskCacheDir: cacheDir,
    diskCacheMaxBytes: parsed.data.GITQUERY_CACHE_MAX_BYTES,
    logLevel: parsed.data.LOG_LEVEL,
  };
}

/**
 * Checks whether a given repository (owner/repo) is permitted by the configured ALLOWED_REPOS list.
 * If ALLOWED_REPOS is empty, all repositories are permitted.
 * Supported patterns in ALLOWED_REPOS:
 *  - "owner/repo" (exact match, case-insensitive)
 *  - "owner/*" (all repositories under owner, case-insensitive)
 */
export function isRepoPermitted(owner: string, repo: string, allowedRepos: string[]): boolean {
  if (!allowedRepos || allowedRepos.length === 0) {
    return true;
  }

  const normalizedTarget = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const ownerWildcard = `${owner.toLowerCase()}/*`;

  return allowedRepos.some((rule) => {
    const lowerRule = rule.toLowerCase();
    return lowerRule === normalizedTarget || lowerRule === ownerWildcard;
  });
}
