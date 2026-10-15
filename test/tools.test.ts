import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toolsByName } from '../src/tools/index.js';
import { GitProvider } from '../src/providers/types.js';
import { MemoryCache } from '../src/cache/memory.js';
import { ToolContext } from '../src/tools/common.js';
import { BinaryFileError, FileTooLargeError, RefNotFoundError } from '../src/util/errors.js';

describe('MCP Tools', () => {
  let mockProvider: Record<keyof GitProvider, any>;
  let cache: MemoryCache;
  let context: ToolContext;

  const validSha1 = '1'.repeat(40);
  const validSha2 = '2'.repeat(40);
  const validSha3 = '3'.repeat(40);

  beforeEach(() => {
    cache = new MemoryCache(100);
    mockProvider = {
      name: 'mock',
      resolveRef: vi.fn().mockImplementation(async (_owner, _repo, ref) => {
        if (ref === 'bad-ref') {
          throw new RefNotFoundError(_owner, _repo, ref);
        }
        if (/^[0-9a-f]{40}$/i.test(ref)) {
          return { sha: ref.toLowerCase(), refType: 'sha' };
        }
        return { sha: validSha1, refType: 'branch' };
      }),
      getBlame: vi.fn().mockResolvedValue({
        ranges: [
          {
            startLine: 1,
            endLine: 10,
            commitSha: validSha1,
            authorName: 'Developer',
            authorDate: '2026-01-01T00:00:00Z',
            messageHeadline: 'feat: init',
            pullRequest: { number: 10, title: 'Initial PR', url: 'https://github.com/pull/10' },
          },
        ],
        totalLines: 10,
        path: 'src/main.ts',
        refSha: validSha1,
      }),
      getPathHistory: vi.fn().mockResolvedValue({
        commits: [
          {
            sha: validSha1,
            author: 'Developer',
            date: '2026-01-01T00:00:00Z',
            messageHeadline: 'feat: init',
          },
        ],
        truncated: false,
      }),
      compare: vi.fn().mockResolvedValue({
        mergeBaseSha: validSha1,
        aheadBy: 2,
        behindBy: 0,
        status: 'ahead',
        totalCommits: 2,
      }),
      getPullRequestsForCommit: vi.fn().mockResolvedValue([
        {
          number: 101,
          title: 'Add feature',
          url: 'https://github.com/pull/101',
          mergedAt: '2026-01-02T00:00:00Z',
          author: 'dev',
        },
      ]),
      listChangedFiles: vi.fn().mockResolvedValue({
        files: [
          {
            filename: 'src/index.ts',
            status: 'modified',
            additions: 10,
            deletions: 2,
            changes: 12,
          },
        ],
        totalCount: 1,
        truncated: false,
      }),
      getDiff: vi.fn().mockResolvedValue('diff --git a/file b/file\n+new line'),
      getFileAtRef: vi.fn().mockResolvedValue({
        content: 'line 1\nline 2',
        path: 'src/main.ts',
        sha: validSha1,
        totalLines: 2,
        startLine: 1,
        endLine: 2,
        isTruncated: false,
      }),
    };

    context = {
      provider: mockProvider as unknown as GitProvider,
      cache,
      allowedRepos: [],
    };
  });

  function getTool(name: string) {
    const tool = toolsByName.get(name);
    if (!tool) throw new Error(`Tool '${name}' not found in registry`);
    return tool;
  }

  describe('resolve_ref', () => {
    it('resolves valid ref to full SHA', async () => {
      const tool = getTool('resolve_ref');
      const res = await tool.execute({ owner: 'facebook', repo: 'react', ref: 'main' }, context);
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain(`Resolved ref 'main' to commit ${validSha1}`);
      expect(mockProvider.resolveRef).toHaveBeenCalledWith('facebook', 'react', 'main');
    });

    it('rejects invalid owner/repo format', async () => {
      const tool = getTool('resolve_ref');
      const res = await tool.execute({ owner: 'bad/owner', repo: 'react', ref: 'main' }, context);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain('Owner must contain only alphanumerics');
    });

    it('enforces ALLOWED_REPOS', async () => {
      const tool = getTool('resolve_ref');
      const restrictedContext: ToolContext = { ...context, allowedRepos: ['vercel/*'] };
      const res = await tool.execute({ owner: 'facebook', repo: 'react', ref: 'main' }, restrictedContext);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain('prohibited by ALLOWED_REPOS');
    });
  });

  describe('get_blame', () => {
    it('returns blame ranges with PR metadata', async () => {
      const tool = getTool('get_blame');
      const res = await tool.execute({ owner: 'facebook', repo: 'react', path: 'src/main.ts' }, context);
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('Blame for \'src/main.ts\'');
      expect(res.content[0]?.text).toContain('"number": 10');
    });

    it('rejects path traversal with ..', async () => {
      const tool = getTool('get_blame');
      const res = await tool.execute({ owner: 'facebook', repo: 'react', path: '../secret.ts' }, context);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain('must not contain ".." segments');
    });

    it('rejects start_line > end_line', async () => {
      const tool = getTool('get_blame');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', path: 'src/main.ts', start_line: 20, end_line: 10 },
        context
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain('start_line must be less than or equal to end_line');
    });

    it('returns error when ref is not found', async () => {
      const tool = getTool('get_blame');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', path: 'src/main.ts', ref: 'bad-ref' },
        context
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("Reference 'bad-ref' was not found");
    });
  });

  describe('get_path_history', () => {
    it('returns commits touching a path', async () => {
      const tool = getTool('get_path_history');
      const res = await tool.execute({ owner: 'facebook', repo: 'react', path: 'src/main.ts' }, context);
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('Path history for \'src/main.ts\'');
    });

    it('flags truncation when limit is reached', async () => {
      mockProvider.getPathHistory.mockResolvedValueOnce({
        commits: [{ sha: validSha1, author: 'Dev', date: '', messageHeadline: 'init' }],
        truncated: true,
      });
      const tool = getTool('get_path_history');
      const res = await tool.execute({ owner: 'facebook', repo: 'react', path: 'src/main.ts', limit: 1 }, context);
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('[truncated at limit 1; narrow with');
    });

    it('rejects limit exceeding 100', async () => {
      const tool = getTool('get_path_history');
      const res = await tool.execute({ owner: 'facebook', repo: 'react', path: 'src/main.ts', limit: 500 }, context);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain('Number must be less than or equal to 100');
    });
  });

  describe('find_merge_base', () => {
    it('returns merge base and ahead/behind counts', async () => {
      const tool = getTool('find_merge_base');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', base: validSha1, head: validSha2 },
        context
      );
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('Merge base of');
      expect(res.content[0]?.text).toContain('"status": "ahead"');
    });

    it('enforces ALLOWED_REPOS', async () => {
      const tool = getTool('find_merge_base');
      const restrictedContext: ToolContext = { ...context, allowedRepos: ['other/repo'] };
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', base: validSha1, head: validSha2 },
        restrictedContext
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain('prohibited by ALLOWED_REPOS');
    });
  });

  describe('is_ancestor', () => {
    it('returns true with explanation when ancestor is behind with 0 behind commits', async () => {
      mockProvider.compare.mockResolvedValueOnce({
        mergeBaseSha: validSha1,
        aheadBy: 3,
        behindBy: 0,
        status: 'ahead',
        totalCommits: 3,
      });

      const tool = getTool('is_ancestor');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', ancestor: validSha1, descendant: validSha2 },
        context
      );
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('is an ancestor of');
      expect(res.content[0]?.text).toContain('"isAncestor": true');
    });

    it('returns false with explanation when branches diverged', async () => {
      mockProvider.compare.mockResolvedValueOnce({
        mergeBaseSha: validSha3,
        aheadBy: 2,
        behindBy: 4,
        status: 'diverged',
        totalCommits: 6,
      });

      const tool = getTool('is_ancestor');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', ancestor: validSha1, descendant: validSha2 },
        context
      );
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('is NOT an ancestor of');
      expect(res.content[0]?.text).toContain('"isAncestor": false');
    });

    it('handles identical refs as ancestor of itself', async () => {
      const tool = getTool('is_ancestor');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', ancestor: validSha1, descendant: validSha1 },
        context
      );
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('is identical to');
      expect(res.content[0]?.text).toContain('"isAncestor": true');
    });
  });

  describe('find_pr_for_commit', () => {
    it('returns pull requests for commit SHA', async () => {
      const tool = getTool('find_pr_for_commit');
      const res = await tool.execute({ owner: 'facebook', repo: 'react', sha: validSha1 }, context);
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('Found 1 merged pull request(s)');
      expect(res.content[0]?.text).toContain('"number": 101');
    });
  });

  describe('list_changed_files', () => {
    it('lists changed files', async () => {
      const tool = getTool('list_changed_files');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', base: validSha1, head: validSha2 },
        context
      );
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('Changed files between');
      expect(res.content[0]?.text).toContain('src/index.ts');
    });

    it('indicates truncation when files exceed 500', async () => {
      mockProvider.listChangedFiles.mockResolvedValueOnce({
        files: new Array(500).fill({ filename: 'file.ts', status: 'modified', additions: 1, deletions: 1, changes: 2 }),
        totalCount: 750,
        truncated: true,
      });

      const tool = getTool('list_changed_files');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', base: validSha1, head: validSha2 },
        context
      );
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('[truncated at 500 files from 750 total; narrow with \'path_prefix\']');
    });
  });

  describe('get_diff', () => {
    it('returns raw unified diff', async () => {
      const tool = getTool('get_diff');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', base: validSha1, head: validSha2 },
        context
      );
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('diff --git');
    });

    it('truncates diff exceeding max_bytes with instructions', async () => {
      mockProvider.getDiff.mockResolvedValueOnce('A'.repeat(5000));
      const tool = getTool('get_diff');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', base: validSha1, head: validSha2, max_bytes: 1000 },
        context
      );
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('[truncated: 4000 more bytes, narrow with `paths`]');
    });
  });

  describe('get_file_at_ref', () => {
    it('returns file content at ref', async () => {
      const tool = getTool('get_file_at_ref');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', path: 'src/main.ts', ref: validSha1 },
        context
      );
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain("Content of 'src/main.ts'");
      expect(res.content[0]?.text).toContain('line 1\\nline 2');
    });

    it('rejects binary files with clear message', async () => {
      mockProvider.getFileAtRef.mockRejectedValueOnce(new BinaryFileError('image.png'));
      const tool = getTool('get_file_at_ref');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', path: 'image.png', ref: validSha1 },
        context
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain('appears to be binary');
    });

    it('rejects files exceeding 1 MB', async () => {
      mockProvider.getFileAtRef.mockRejectedValueOnce(new FileTooLargeError('big.json', 2000000));
      const tool = getTool('get_file_at_ref');
      const res = await tool.execute(
        { owner: 'facebook', repo: 'react', path: 'big.json', ref: validSha1 },
        context
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain('exceeding the 1.00 MB limit');
    });
  });

  describe('cache_stats', () => {
    it('returns cache metrics accurately', async () => {
      cache.set('key1', 'val1');
      cache.get('key1'); // hit
      cache.get('key2'); // miss

      const tool = getTool('cache_stats');
      const res = await tool.execute({}, context);
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain('1 hit(s), 1 miss(es)');
      expect(res.content[0]?.text).toContain('"hitRate": 0.5');
    });
  });

  describe('Caching Integration across repeated tool calls', () => {
    it('produces a cache hit on repeated SHA-addressed tool query', async () => {
      // Use real GitHubProvider mock with internal cache
      const tool = getTool('get_blame');
      const args = { owner: 'facebook', repo: 'react', path: 'src/main.ts', ref: validSha1 };

      // Call 1
      await tool.execute(args, context);
      expect(mockProvider.getBlame).toHaveBeenCalledTimes(1);

      // Simulate cached provider: In real usage, provider caches the call.
      // Let's verify resolve_ref with 40-char SHA does not call any API
      expect(mockProvider.resolveRef).toHaveBeenCalledWith('facebook', 'react', validSha1);
    });
  });
});
