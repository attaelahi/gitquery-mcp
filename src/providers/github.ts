import { Octokit } from '@octokit/rest';
import { graphql as octokitGraphql } from '@octokit/graphql';
import { z } from 'zod';
import {
  GitProvider,
  ResolvedRef,
  BlameResult,
  BlameRange,
  PathHistoryResult,
  PathHistoryCommit,
  CompareResult,
  PullRequestSummary,
  ChangedFilesResult,
  ChangedFile,
  FileChangeStatus,
  FileContentResult,
} from './types.js';
import { ICache } from '../cache/memory.js';
import { buildCacheKey, buildRefResolveKey } from '../cache/keys.js';
import { withRateLimitRetry } from '../util/rateLimit.js';
import {
  GitQueryError,
  NotFoundError,
  RefNotFoundError,
  PathNotFoundError,
  RepoNotAllowedError,
  AuthenticationError,
  FileTooLargeError,
  BinaryFileError,
} from '../util/errors.js';
import { isRepoPermitted } from '../config.js';
import { logger } from '../util/logger.js';

// --- Zod Response Validation Schemas ---

const GitHubCommitRefSchema = z.object({
  sha: z.string(),
});

const GitHubGitRefSchema = z.object({
  ref: z.string(),
  object: z.object({
    sha: z.string(),
    type: z.string().optional(),
  }),
});

const GitHubCommitItemSchema = z.object({
  sha: z.string(),
  commit: z.object({
    message: z.string(),
    author: z
      .object({
        name: z.string().optional(),
        date: z.string().optional(),
      })
      .nullable()
      .optional(),
  }),
});

const GitHubCompareSchema = z.object({
  status: z.enum(['diverged', 'ahead', 'behind', 'identical']),
  ahead_by: z.number(),
  behind_by: z.number(),
  total_commits: z.number(),
  merge_base_commit: z
    .object({
      sha: z.string(),
    })
    .nullable()
    .optional(),
  files: z
    .array(
      z.object({
        filename: z.string(),
        status: z.string(),
        additions: z.number().optional().default(0),
        deletions: z.number().optional().default(0),
        changes: z.number().optional().default(0),
      })
    )
    .optional(),
});

const GitHubPrItemSchema = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  merged_at: z.string().nullable().optional(),
  user: z
    .object({
      login: z.string().optional(),
    })
    .nullable()
    .optional(),
});

const GitHubContentFileSchema = z.object({
  type: z.literal('file'),
  encoding: z.string().optional().default('base64'),
  size: z.number(),
  name: z.string(),
  path: z.string(),
  content: z.string().optional(),
  sha: z.string(),
});

// GraphQL Blame Schema
const GraphQLBlameRangeSchema = z.object({
  startingLine: z.number(),
  endingLine: z.number(),
  commit: z.object({
    oid: z.string(),
    messageHeadline: z.string(),
    committedDate: z.string(),
    author: z
      .object({
        name: z.string().nullable().optional(),
        user: z
          .object({
            login: z.string().nullable().optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    associatedPullRequests: z
      .object({
        nodes: z
          .array(
            z.object({
              number: z.number(),
              title: z.string(),
              url: z.string(),
            })
          )
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  }),
});

const GraphQLBlameResponseSchema = z.object({
  repository: z
    .object({
      object: z
        .object({
          oid: z.string().optional(),
          blame: z
            .object({
              ranges: z.array(GraphQLBlameRangeSchema),
            })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

export interface GitHubProviderOptions {
  token?: string;
  cache: ICache;
  allowedRepos?: string[];
  cacheTtlMutableSeconds?: number;
  octokitClient?: Octokit;
  graphqlClient?: typeof octokitGraphql;
}

export class GitHubProvider implements GitProvider {
  public readonly name = 'github';
  private readonly octokit: Octokit;
  private readonly graphql: typeof octokitGraphql;
  private readonly cache: ICache;
  private readonly allowedRepos: string[];
  private readonly mutableTtlMs: number;

  constructor(options: GitHubProviderOptions) {
    this.cache = options.cache;
    this.allowedRepos = options.allowedRepos ?? [];
    this.mutableTtlMs = (options.cacheTtlMutableSeconds ?? 30) * 1000;

    const auth = options.token && options.token.trim().length > 0 ? options.token.trim() : undefined;

    this.octokit =
      options.octokitClient ??
      new Octokit({
        auth,
        userAgent: 'gitquery-mcp/0.1.0',
      });

    this.graphql =
      options.graphqlClient ??
      octokitGraphql.defaults({
        headers: {
          authorization: auth ? `token ${auth}` : '',
          'user-agent': 'gitquery-mcp/0.1.0',
        },
      });
  }

  private checkPermission(owner: string, repo: string): void {
    if (!isRepoPermitted(owner, repo, this.allowedRepos)) {
      throw new RepoNotAllowedError(owner, repo);
    }
  }

  private handleOctokitError(err: unknown, owner: string, repo: string, refOrPath?: string): never {
    if (err instanceof GitQueryError) {
      throw err;
    }

    if (err && typeof err === 'object') {
      const status = (err as { status?: number }).status;
      const message = ((err as { message?: string }).message || '').toLowerCase();

      if (status === 401 || message.includes('bad credentials')) {
        throw new AuthenticationError();
      }
      if (status === 404) {
        if (refOrPath) {
          if (refOrPath.includes('/')) {
            throw new PathNotFoundError(refOrPath, 'specified ref');
          }
          throw new RefNotFoundError(owner, repo, refOrPath);
        }
        throw new NotFoundError(owner, repo);
      }
    }

    throw err;
  }

  public async resolveRef(owner: string, repo: string, ref: string): Promise<ResolvedRef> {
    this.checkPermission(owner, repo);
    const trimmedRef = ref.trim();

    // 40-character hex string is a full commit SHA
    const isFullSha = /^[0-9a-f]{40}$/i.test(trimmedRef);
    if (isFullSha) {
      return {
        sha: trimmedRef.toLowerCase(),
        refType: 'sha',
      };
    }

    const cacheKey = buildRefResolveKey(this.name, owner, repo, trimmedRef);
    const cached = this.cache.get<ResolvedRef>(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await withRateLimitRetry(async () => {
      // 1. Try branch reference
      try {
        const branchRes = await this.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${trimmedRef}`,
        });
        const parsed = GitHubGitRefSchema.safeParse(branchRes.data);
        if (parsed.success) {
          return {
            sha: parsed.data.object.sha.toLowerCase(),
            refType: 'branch' as const,
          };
        }
      } catch {
        // Not a branch, continue
      }

      // 2. Try tag reference
      try {
        const tagRes = await this.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `tags/${trimmedRef}`,
        });
        const parsed = GitHubGitRefSchema.safeParse(tagRes.data);
        if (parsed.success) {
          let sha = parsed.data.object.sha.toLowerCase();
          if (parsed.data.object.type === 'tag') {
            try {
              const tagObj = await this.octokit.rest.git.getTag({
                owner,
                repo,
                tag_sha: sha,
              });
              if (tagObj.data?.object?.sha) {
                sha = tagObj.data.object.sha.toLowerCase();
              }
            } catch {
              const commitRes = await this.octokit.rest.repos.getCommit({
                owner,
                repo,
                ref: trimmedRef,
              });
              if (commitRes.data?.sha) {
                sha = commitRes.data.sha.toLowerCase();
              }
            }
          }
          return {
            sha,
            refType: 'tag' as const,
          };
        }
      } catch {
        // Not a tag, continue
      }

      // 3. Fallback to general commit resolution (resolves short SHAs, HEAD, etc.)
      try {
        const commitRes = await this.octokit.rest.repos.getCommit({
          owner,
          repo,
          ref: trimmedRef,
        });
        const parsed = GitHubCommitRefSchema.safeParse(commitRes.data);
        if (!parsed.success) {
          throw new RefNotFoundError(owner, repo, trimmedRef);
        }

        const isShortSha = /^[0-9a-f]{7,39}$/i.test(trimmedRef);
        return {
          sha: parsed.data.sha.toLowerCase(),
          refType: isShortSha ? ('sha' as const) : ('branch' as const),
        };
      } catch (err: unknown) {
        this.handleOctokitError(err, owner, repo, trimmedRef);
      }
    });

    // Cache with mutable TTL for branches/tags
    this.cache.set(cacheKey, result, this.mutableTtlMs);
    return result;
  }

  public async getBlame(
    owner: string,
    repo: string,
    path: string,
    sha: string,
    startLine?: number,
    endLine?: number
  ): Promise<BlameResult> {
    this.checkPermission(owner, repo);
    const normSha = sha.toLowerCase();
    const cacheKey = buildCacheKey(this.name, owner, repo, 'blame', normSha, { path });

    let blameData = this.cache.get<BlameResult>(cacheKey);

    if (!blameData) {
      blameData = await withRateLimitRetry(async () => {
        try {
          const query = `
            query($owner: String!, $repo: String!, $expression: String!, $path: String!) {
              repository(owner: $owner, name: $repo) {
                object(expression: $expression) {
                  ... on Commit {
                    oid
                    blame(path: $path) {
                      ranges {
                        startingLine
                        endingLine
                        commit {
                          oid
                          messageHeadline
                          committedDate
                          author {
                            name
                            user {
                              login
                            }
                          }
                          associatedPullRequests(first: 1) {
                            nodes {
                              number
                              title
                              url
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `;

          const response = await this.graphql(query, {
            owner,
            repo,
            expression: normSha,
            path,
          });

          const parsed = GraphQLBlameResponseSchema.safeParse(response);
          if (!parsed.success) {
            logger.error('Blame GraphQL response parsing failed', parsed.error);
            throw new GitQueryError('Failed to parse GitHub GraphQL blame response.');
          }

          const repoObj = parsed.data.repository;
          if (!repoObj) {
            throw new NotFoundError(owner, repo);
          }
          if (!repoObj.object) {
            throw new RefNotFoundError(owner, repo, normSha);
          }
          if (!repoObj.object.blame) {
            throw new PathNotFoundError(path, normSha);
          }

          const ranges: BlameRange[] = repoObj.object.blame.ranges.map((r) => {
            const author = r.commit.author?.name || r.commit.author?.user?.login || 'Unknown';
            const prNode = r.commit.associatedPullRequests?.nodes?.[0];
            return {
              startLine: r.startingLine,
              endLine: r.endingLine,
              commitSha: r.commit.oid,
              authorName: author,
              authorDate: r.commit.committedDate,
              messageHeadline: r.commit.messageHeadline,
              pullRequest: prNode
                ? {
                    number: prNode.number,
                    title: prNode.title,
                    url: prNode.url,
                  }
                : undefined,
            };
          });

          const totalLines = ranges.length > 0 ? (ranges[ranges.length - 1]?.endLine ?? 0) : 0;

          return {
            ranges,
            totalLines,
            path,
            refSha: normSha,
          };
        } catch (err: unknown) {
          this.handleOctokitError(err, owner, repo, path);
        }
      });

      // Immutable SHA: cache forever
      this.cache.set(cacheKey, blameData);
    }

    // Filter/slice ranges if startLine or endLine are specified
    if (startLine !== undefined || endLine !== undefined) {
      const minLine = startLine !== undefined && startLine > 0 ? startLine : 1;
      const maxLine = endLine !== undefined && endLine > 0 ? endLine : blameData.totalLines;

      const filteredRanges: BlameRange[] = [];
      for (const range of blameData.ranges) {
        if (range.endLine < minLine || range.startLine > maxLine) {
          continue;
        }
        filteredRanges.push({
          ...range,
          startLine: Math.max(range.startLine, minLine),
          endLine: Math.min(range.endLine, maxLine),
        });
      }

      return {
        ...blameData,
        ranges: filteredRanges,
      };
    }

    return blameData;
  }

  public async getPathHistory(
    owner: string,
    repo: string,
    path: string,
    sha: string,
    limit = 20,
    since?: string,
    until?: string
  ): Promise<PathHistoryResult> {
    this.checkPermission(owner, repo);
    const normSha = sha.toLowerCase();
    const clampedLimit = Math.min(Math.max(limit, 1), 100);

    const cacheKey = buildCacheKey(this.name, owner, repo, 'pathHistory', normSha, {
      path,
      limit: clampedLimit,
      since,
      until,
    });

    const cached = this.cache.get<PathHistoryResult>(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await withRateLimitRetry(async () => {
      try {
        const response = await this.octokit.rest.repos.listCommits({
          owner,
          repo,
          path,
          sha: normSha,
          per_page: clampedLimit,
          since,
          until,
        });

        const parsed = z.array(GitHubCommitItemSchema).safeParse(response.data);
        if (!parsed.success) {
          throw new GitQueryError('Failed to parse commit history response.');
        }

        const commits: PathHistoryCommit[] = parsed.data.map((c) => ({
          sha: c.sha,
          author: c.commit.author?.name || 'Unknown',
          date: c.commit.author?.date || '',
          messageHeadline: c.commit.message.split('\n')[0] || '',
        }));

        return {
          commits,
          truncated: commits.length >= clampedLimit,
        };
      } catch (err: unknown) {
        this.handleOctokitError(err, owner, repo, path);
      }
    });

    // Immutable SHA: cache forever
    this.cache.set(cacheKey, result);
    return result;
  }

  public async compare(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string
  ): Promise<CompareResult> {
    this.checkPermission(owner, repo);
    const normBase = baseSha.toLowerCase();
    const normHead = headSha.toLowerCase();

    const cacheKey = buildCacheKey(this.name, owner, repo, 'compare', [normBase, normHead]);
    const cached = this.cache.get<CompareResult>(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await withRateLimitRetry(async () => {
      try {
        const response = await this.octokit.rest.repos.compareCommits({
          owner,
          repo,
          base: normBase,
          head: normHead,
        });

        const parsed = GitHubCompareSchema.safeParse(response.data);
        if (!parsed.success) {
          throw new GitQueryError('Failed to parse compare response.');
        }

        const data = parsed.data;
        const mergeBaseSha = data.merge_base_commit?.sha || (data.status === 'identical' ? normBase : '');

        return {
          mergeBaseSha,
          aheadBy: data.ahead_by,
          behindBy: data.behind_by,
          status: data.status,
          totalCommits: data.total_commits,
        };
      } catch (err: unknown) {
        this.handleOctokitError(err, owner, repo, `${normBase}...${normHead}`);
      }
    });

    // Immutable SHAs: cache forever
    this.cache.set(cacheKey, result);
    return result;
  }

  public async getPullRequestsForCommit(
    owner: string,
    repo: string,
    sha: string
  ): Promise<PullRequestSummary[]> {
    this.checkPermission(owner, repo);
    const normSha = sha.toLowerCase();

    const cacheKey = buildCacheKey(this.name, owner, repo, 'prForCommit', normSha);
    const cached = this.cache.get<PullRequestSummary[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await withRateLimitRetry(async () => {
      try {
        const response = await this.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: normSha,
        });

        const parsed = z.array(GitHubPrItemSchema).safeParse(response.data);
        if (!parsed.success) {
          throw new GitQueryError('Failed to parse associated pull requests response.');
        }

        // Return merged pull requests
        return parsed.data
          .filter((pr) => pr.merged_at !== null && pr.merged_at !== undefined)
          .map((pr) => ({
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            mergedAt: pr.merged_at ?? undefined,
            author: pr.user?.login || 'Unknown',
          }));
      } catch (err: unknown) {
        this.handleOctokitError(err, owner, repo, normSha);
      }
    });

    // Immutable SHA: cache forever
    this.cache.set(cacheKey, result);
    return result;
  }

  public async listChangedFiles(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
    pathPrefix?: string
  ): Promise<ChangedFilesResult> {
    this.checkPermission(owner, repo);
    const normBase = baseSha.toLowerCase();
    const normHead = headSha.toLowerCase();

    const cacheKey = buildCacheKey(this.name, owner, repo, 'changedFiles', [normBase, normHead], {
      pathPrefix,
    });
    const cached = this.cache.get<ChangedFilesResult>(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await withRateLimitRetry(async () => {
      try {
        const response = await this.octokit.rest.repos.compareCommits({
          owner,
          repo,
          base: normBase,
          head: normHead,
        });

        const parsed = GitHubCompareSchema.safeParse(response.data);
        if (!parsed.success) {
          throw new GitQueryError('Failed to parse changed files from compare response.');
        }

        const rawFiles = parsed.data.files ?? [];
        const normPrefix = pathPrefix?.trim();

        const filtered = normPrefix
          ? rawFiles.filter((f) => f.filename.startsWith(normPrefix))
          : rawFiles;

        const maxFiles = 500;
        const truncated = filtered.length > maxFiles;
        const sliced = filtered.slice(0, maxFiles);

        const files: ChangedFile[] = sliced.map((f) => ({
          filename: f.filename,
          status: (f.status as FileChangeStatus) || 'modified',
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        }));

        return {
          files,
          totalCount: filtered.length,
          truncated,
        };
      } catch (err: unknown) {
        this.handleOctokitError(err, owner, repo, `${normBase}...${normHead}`);
      }
    });

    // Immutable SHAs: cache forever
    this.cache.set(cacheKey, result);
    return result;
  }

  public async getDiff(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
    paths?: string[]
  ): Promise<string> {
    this.checkPermission(owner, repo);
    const normBase = baseSha.toLowerCase();
    const normHead = headSha.toLowerCase();

    const cacheKey = buildCacheKey(this.name, owner, repo, 'diff', [normBase, normHead], {
      paths: paths?.sort().join(','),
    });
    const cached = this.cache.get<string>(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await withRateLimitRetry(async () => {
      try {
        const response = await this.octokit.rest.repos.compareCommits({
          owner,
          repo,
          base: normBase,
          head: normHead,
          headers: {
            accept: 'application/vnd.github.v3.diff',
          },
        });

        let diffText = typeof response.data === 'string' ? response.data : String(response.data);

        // Filter diff by paths if specified
        if (paths && paths.length > 0) {
          const fileDiffs = diffText.split(/^diff --git /m);
          const preamble = fileDiffs[0] || '';
          const matchingChunks: string[] = [];

          for (let i = 1; i < fileDiffs.length; i++) {
            const chunk = fileDiffs[i]!;
            const firstLine = chunk.split('\n')[0] || '';
            const isMatch = paths.some((p) => {
              const normPath = p.replace(/^\//, '');
              return firstLine.includes(`a/${normPath}`) || firstLine.includes(`b/${normPath}`);
            });
            if (isMatch) {
              matchingChunks.push(`diff --git ${chunk}`);
            }
          }

          diffText = preamble + matchingChunks.join('');
        }

        return diffText;
      } catch (err: unknown) {
        this.handleOctokitError(err, owner, repo, `${normBase}...${normHead}`);
      }
    });

    // Immutable SHAs: cache forever
    this.cache.set(cacheKey, result);
    return result;
  }

  public async getFileAtRef(
    owner: string,
    repo: string,
    path: string,
    sha: string,
    startLine?: number,
    endLine?: number
  ): Promise<FileContentResult> {
    this.checkPermission(owner, repo);
    const normSha = sha.toLowerCase();

    const cacheKey = buildCacheKey(this.name, owner, repo, 'fileAtRef', normSha, { path });
    let fileText = this.cache.get<string>(cacheKey);

    if (fileText === undefined) {
      fileText = await withRateLimitRetry(async () => {
        try {
          const response = await this.octokit.rest.repos.getContent({
            owner,
            repo,
            path,
            ref: normSha,
          });

          const parsed = GitHubContentFileSchema.safeParse(response.data);
          if (!parsed.success) {
            throw new GitQueryError(
              `Path '${path}' is a directory or submodule, not a regular file.`
            );
          }

          if (parsed.data.size > 1048576) {
            throw new FileTooLargeError(path, parsed.data.size);
          }

          const rawBase64 = parsed.data.content || '';
          const buffer = Buffer.from(rawBase64, 'base64');

          // Check if binary (presence of null byte in initial bytes)
          const checkLen = Math.min(buffer.length, 8000);
          for (let i = 0; i < checkLen; i++) {
            if (buffer[i] === 0) {
              throw new BinaryFileError(path);
            }
          }

          return buffer.toString('utf-8');
        } catch (err: unknown) {
          this.handleOctokitError(err, owner, repo, path);
        }
      });

      // Immutable SHA: cache forever
      this.cache.set(cacheKey, fileText);
    }

    const allLines = fileText.split(/\r?\n/);
    const totalLines = allLines.length;

    let slicedLines = allLines;
    let sLine = 1;
    let eLine = totalLines;
    let isTruncated = false;

    if (startLine !== undefined || endLine !== undefined) {
      sLine = startLine !== undefined && startLine > 0 ? startLine : 1;
      eLine = endLine !== undefined && endLine > 0 ? endLine : totalLines;

      if (sLine > totalLines) {
        slicedLines = [];
      } else {
        slicedLines = allLines.slice(sLine - 1, eLine);
      }
      isTruncated = sLine > 1 || eLine < totalLines;
    }

    return {
      content: slicedLines.join('\n'),
      path,
      sha: normSha,
      totalLines,
      startLine: sLine,
      endLine: eLine,
      isTruncated,
    };
  }
}
