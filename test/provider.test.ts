import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubProvider } from '../src/providers/github.js';
import { MemoryCache } from '../src/cache/memory.js';
import { RepoNotAllowedError, RateLimitExceededError, FileTooLargeError, BinaryFileError } from '../src/util/errors.js';

describe('GitHubProvider & Cache', () => {
  let cache: MemoryCache;
  let mockOctokit: any;
  let mockGraphql: any;

  beforeEach(() => {
    cache = new MemoryCache(100);
    mockOctokit = {
      rest: {
        git: {
          getRef: vi.fn(),
        },
        repos: {
          getCommit: vi.fn(),
          listCommits: vi.fn(),
          compareCommits: vi.fn(),
          listPullRequestsAssociatedWithCommit: vi.fn(),
          getContent: vi.fn(),
        },
      },
    };
    mockGraphql = vi.fn();
  });

  function createProvider(options: { allowedRepos?: string[]; cacheTtl?: number } = {}) {
    return new GitHubProvider({
      token: 'test-token',
      cache,
      allowedRepos: options.allowedRepos ?? [],
      cacheTtlMutableSeconds: options.cacheTtl ?? 30,
      octokitClient: mockOctokit as any,
      graphqlClient: mockGraphql,
    });
  }

  describe('Repository Access Control', () => {
    it('throws RepoNotAllowedError if repository is not permitted', async () => {
      const provider = createProvider({ allowedRepos: ['allowed/repo'] });
      await expect(
        provider.resolveRef('forbidden', 'repo', 'main')
      ).rejects.toThrow(RepoNotAllowedError);
    });
  });

  describe('resolveRef', () => {
    it('returns 40-char SHA directly without calling GitHub API', async () => {
      const provider = createProvider();
      const sha = 'a'.repeat(40);
      const res = await provider.resolveRef('owner', 'repo', sha);
      expect(res).toEqual({ sha, refType: 'sha' });
      expect(mockOctokit.rest.git.getRef).not.toHaveBeenCalled();
      expect(mockOctokit.rest.repos.getCommit).not.toHaveBeenCalled();
    });

    it('resolves branch reference and caches with mutable TTL', async () => {
      const provider = createProvider();
      const commitSha = 'b'.repeat(40);
      mockOctokit.rest.git.getRef.mockResolvedValueOnce({
        data: {
          ref: 'refs/heads/main',
          object: { sha: commitSha, type: 'commit' },
        },
      });

      const res1 = await provider.resolveRef('owner', 'repo', 'main');
      expect(res1).toEqual({ sha: commitSha, refType: 'branch' });
      expect(mockOctokit.rest.git.getRef).toHaveBeenCalledTimes(1);

      // Second call must hit cache without invoking mockOctokit again
      const res2 = await provider.resolveRef('owner', 'repo', 'main');
      expect(res2).toEqual({ sha: commitSha, refType: 'branch' });
      expect(mockOctokit.rest.git.getRef).toHaveBeenCalledTimes(1);
    });
  });

  describe('getBlame via GraphQL & Immutable Caching', () => {
    it('fetches blame data via GraphQL and caches by immutable SHA with zero extra API calls on second call', async () => {
      const provider = createProvider();
      const commitSha = 'c'.repeat(40);

      mockGraphql.mockResolvedValueOnce({
        repository: {
          object: {
            oid: commitSha,
            blame: {
              ranges: [
                {
                  startingLine: 1,
                  endingLine: 10,
                  commit: {
                    oid: commitSha,
                    messageHeadline: 'Initial commit',
                    committedDate: '2026-01-01T00:00:00Z',
                    author: { name: 'Alice', user: { login: 'alice' } },
                    associatedPullRequests: {
                      nodes: [{ number: 42, title: 'Add feature', url: 'https://github.com/pull/42' }],
                    },
                  },
                },
              ],
            },
          },
        },
      });

      // Call 1: Misses cache, calls GraphQL
      const blame1 = await provider.getBlame('owner', 'repo', 'src/app.ts', commitSha);
      expect(blame1.ranges).toHaveLength(1);
      expect(blame1.ranges[0]?.authorName).toBe('Alice');
      expect(blame1.ranges[0]?.pullRequest?.number).toBe(42);
      expect(mockGraphql).toHaveBeenCalledTimes(1);

      // Call 2: Must be a cache hit (zero additional GraphQL calls)
      const blame2 = await provider.getBlame('owner', 'repo', 'src/app.ts', commitSha);
      expect(blame2.ranges).toHaveLength(1);
      expect(mockGraphql).toHaveBeenCalledTimes(1);

      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(0.5);
    });

    it('filters blame ranges when startLine and endLine are specified', async () => {
      const provider = createProvider();
      const commitSha = 'd'.repeat(40);

      mockGraphql.mockResolvedValueOnce({
        repository: {
          object: {
            oid: commitSha,
            blame: {
              ranges: [
                {
                  startingLine: 1,
                  endingLine: 10,
                  commit: {
                    oid: commitSha,
                    messageHeadline: 'First chunk',
                    committedDate: '2026-01-01T00:00:00Z',
                    author: { name: 'Alice' },
                  },
                },
                {
                  startingLine: 11,
                  endingLine: 20,
                  commit: {
                    oid: commitSha,
                    messageHeadline: 'Second chunk',
                    committedDate: '2026-01-02T00:00:00Z',
                    author: { name: 'Bob' },
                  },
                },
              ],
            },
          },
        },
      });

      const sliced = await provider.getBlame('owner', 'repo', 'src/app.ts', commitSha, 5, 15);
      expect(sliced.ranges).toHaveLength(2);
      expect(sliced.ranges[0]?.startLine).toBe(5);
      expect(sliced.ranges[0]?.endLine).toBe(10);
      expect(sliced.ranges[1]?.startLine).toBe(11);
      expect(sliced.ranges[1]?.endLine).toBe(15);
    });
  });

  describe('compare', () => {
    it('compares two SHAs and identifies merge base and status', async () => {
      const provider = createProvider();
      const baseSha = '1'.repeat(40);
      const headSha = '2'.repeat(40);
      const mergeBase = '0'.repeat(40);

      mockOctokit.rest.repos.compareCommits.mockResolvedValueOnce({
        data: {
          status: 'ahead',
          ahead_by: 3,
          behind_by: 0,
          total_commits: 3,
          merge_base_commit: { sha: mergeBase },
        },
      });

      const result1 = await provider.compare('owner', 'repo', baseSha, headSha);
      expect(result1).toEqual({
        mergeBaseSha: mergeBase,
        aheadBy: 3,
        behindBy: 0,
        status: 'ahead',
        totalCommits: 3,
      });
      expect(mockOctokit.rest.repos.compareCommits).toHaveBeenCalledTimes(1);

      // Cache hit on identical compare call
      const result2 = await provider.compare('owner', 'repo', baseSha, headSha);
      expect(result2).toEqual(result1);
      expect(mockOctokit.rest.repos.compareCommits).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPathHistory', () => {
    it('fetches commit history for path and caches results', async () => {
      const provider = createProvider();
      const sha = '3'.repeat(40);

      mockOctokit.rest.repos.listCommits.mockResolvedValueOnce({
        data: [
          {
            sha: 'commit-1',
            commit: {
              message: 'feat: add feature\n\nDetailed description',
              author: { name: 'Carol', date: '2026-02-01T00:00:00Z' },
            },
          },
        ],
      });

      const hist1 = await provider.getPathHistory('owner', 'repo', 'README.md', sha, 10);
      expect(hist1.commits).toHaveLength(1);
      expect(hist1.commits[0]?.messageHeadline).toBe('feat: add feature');
      expect(mockOctokit.rest.repos.listCommits).toHaveBeenCalledTimes(1);

      // Second call hits cache
      const hist2 = await provider.getPathHistory('owner', 'repo', 'README.md', sha, 10);
      expect(hist2.commits).toHaveLength(1);
      expect(mockOctokit.rest.repos.listCommits).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPullRequestsForCommit', () => {
    it('returns merged pull requests associated with commit', async () => {
      const provider = createProvider();
      const sha = '4'.repeat(40);

      mockOctokit.rest.repos.listPullRequestsAssociatedWithCommit.mockResolvedValueOnce({
        data: [
          {
            number: 101,
            title: 'Fix issue',
            html_url: 'https://github.com/pull/101',
            merged_at: '2026-03-01T12:00:00Z',
            user: { login: 'dave' },
          },
          {
            number: 102,
            title: 'Unmerged PR',
            html_url: 'https://github.com/pull/102',
            merged_at: null,
            user: { login: 'eve' },
          },
        ],
      });

      const prs = await provider.getPullRequestsForCommit('owner', 'repo', sha);
      expect(prs).toHaveLength(1);
      expect(prs[0]?.number).toBe(101);
      expect(prs[0]?.author).toBe('dave');
    });
  });

  describe('getFileAtRef', () => {
    it('fetches and decodes UTF-8 base64 content with line slicing', async () => {
      const provider = createProvider();
      const sha = '5'.repeat(40);
      const textContent = 'line 1\nline 2\nline 3\nline 4\nline 5';
      const base64Content = Buffer.from(textContent).toString('base64');

      mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
        data: {
          type: 'file',
          size: textContent.length,
          name: 'hello.txt',
          path: 'hello.txt',
          content: base64Content,
          sha: 'blob-sha',
        },
      });

      const res = await provider.getFileAtRef('owner', 'repo', 'hello.txt', sha, 2, 4);
      expect(res.content).toBe('line 2\nline 3\nline 4');
      expect(res.totalLines).toBe(5);
      expect(res.startLine).toBe(2);
      expect(res.endLine).toBe(4);
      expect(res.isTruncated).toBe(true);
    });

    it('rejects binary files containing null bytes', async () => {
      const provider = createProvider();
      const sha = '6'.repeat(40);
      const binaryBuffer = Buffer.from([0x00, 0x01, 0x02, 0xff]);

      mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
        data: {
          type: 'file',
          size: binaryBuffer.length,
          name: 'image.png',
          path: 'image.png',
          content: binaryBuffer.toString('base64'),
          sha: 'blob-sha',
        },
      });

      await expect(
        provider.getFileAtRef('owner', 'repo', 'image.png', sha)
      ).rejects.toThrow(BinaryFileError);
    });

    it('rejects files larger than 1 MB', async () => {
      const provider = createProvider();
      const sha = '7'.repeat(40);

      mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
        data: {
          type: 'file',
          size: 2 * 1024 * 1024,
          name: 'large.log',
          path: 'large.log',
          content: '',
          sha: 'blob-sha',
        },
      });

      await expect(
        provider.getFileAtRef('owner', 'repo', 'large.log', sha)
      ).rejects.toThrow(FileTooLargeError);
    });
  });

  describe('Rate Limiting & Retries', () => {
    it('retries on 403 secondary rate limit and succeeds on retry', async () => {
      const provider = createProvider();
      const baseSha = '8'.repeat(40);
      const headSha = '9'.repeat(40);

      const rateLimitError = Object.assign(new Error('You have exceeded a secondary rate limit.'), {
        status: 403,
        response: {
          headers: {
            'retry-after': '1',
          },
        },
      });

      mockOctokit.rest.repos.compareCommits
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          data: {
            status: 'identical',
            ahead_by: 0,
            behind_by: 0,
            total_commits: 0,
            merge_base_commit: { sha: baseSha },
          },
        });

      const res = await provider.compare('owner', 'repo', baseSha, headSha);
      expect(res.status).toBe('identical');
      expect(mockOctokit.rest.repos.compareCommits).toHaveBeenCalledTimes(2);
    });

    it('throws RateLimitExceededError when retries are exhausted or wait time is too long', async () => {
      const provider = createProvider();
      const baseSha = 'a'.repeat(40);
      const headSha = 'b'.repeat(40);

      const hardRateLimitError = Object.assign(new Error('API rate limit exceeded'), {
        status: 403,
        response: {
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600), // 1 hour wait
          },
        },
      });

      mockOctokit.rest.repos.compareCommits.mockRejectedValue(hardRateLimitError);

      await expect(
        provider.compare('owner', 'repo', baseSha, headSha)
      ).rejects.toThrow(RateLimitExceededError);
    });
  });
});
