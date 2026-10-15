import { describe, it, expect } from 'vitest';
import { loadConfig, isRepoPermitted } from '../src/config.js';
import { formatMcpError, RepoNotAllowedError, RateLimitExceededError } from '../src/util/errors.js';

describe('Config', () => {
  it('loads defaults when no environment variables are set', () => {
    const config = loadConfig({});
    expect(config.githubToken).toBeUndefined();
    expect(config.allowedRepos).toEqual([]);
    expect(config.cacheSize).toBe(5000);
    expect(config.cacheTtlMutableSeconds).toBe(30);
    expect(config.logLevel).toBe('info');
  });

  it('parses custom ALLOWED_REPOS and GITHUB_TOKEN', () => {
    const config = loadConfig({
      GITHUB_TOKEN: 'ghp_test123456789012345678901234567890',
      ALLOWED_REPOS: 'facebook/react, vercel/*',
      CACHE_SIZE: '1000',
    });
    expect(config.githubToken).toBe('ghp_test123456789012345678901234567890');
    expect(config.allowedRepos).toEqual(['facebook/react', 'vercel/*']);
    expect(config.cacheSize).toBe(1000);
  });

  it('checks repository permissions correctly', () => {
    const allowed = ['facebook/react', 'vercel/*'];
    expect(isRepoPermitted('facebook', 'react', allowed)).toBe(true);
    expect(isRepoPermitted('Facebook', 'React', allowed)).toBe(true);
    expect(isRepoPermitted('vercel', 'next.js', allowed)).toBe(true);
    expect(isRepoPermitted('other', 'repo', allowed)).toBe(false);

    // Empty list allows everything
    expect(isRepoPermitted('other', 'repo', [])).toBe(true);
  });
});

describe('Error Handling', () => {
  it('formats RepoNotAllowedError cleanly without leaking stack trace', () => {
    const error = new RepoNotAllowedError('secret-org', 'private-repo');
    const mcpError = formatMcpError(error);
    expect(mcpError.isError).toBe(true);
    expect(mcpError.content[0]?.text).toContain('secret-org/private-repo');
    expect(mcpError.content[0]?.text).not.toContain('at Object');
  });

  it('formats RateLimitExceededError with reset timestamp', () => {
    const resetTime = 1700000000000;
    const error = new RateLimitExceededError(resetTime);
    const mcpError = formatMcpError(error);
    expect(mcpError.isError).toBe(true);
    expect(mcpError.content[0]?.text).toContain('API rate limit exceeded');
    expect(mcpError.content[0]?.text).toContain(new Date(resetTime).toISOString());
  });
});
