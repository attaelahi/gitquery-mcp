import { z } from 'zod';
import {
  McpTool,
  OwnerSchema,
  RepoSchema,
  PathSchema,
  RefSchema,
  checkRepoAllowed,
  formatSuccessResponse,
} from './common.js';
import { formatMcpError, InvalidInputError } from '../util/errors.js';

const InputSchema = z.object({
  owner: OwnerSchema,
  repo: RepoSchema,
  path: PathSchema,
  ref: RefSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  since: z.string().optional(),
  until: z.string().optional(),
});

export const getPathHistoryTool: McpTool = {
  name: 'get_path_history',
  description:
    'Lists commits modifying a specific file or directory up to a ref. Use to trace when a path was touched or refactored. Returns commit SHA, author, date, and headline. Capped at 100 commits (default 20). Narrow with since, until, or limit.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: {
        type: 'string',
        description: 'Repository owner (organization or user).',
      },
      repo: {
        type: 'string',
        description: 'Repository name.',
      },
      path: {
        type: 'string',
        description: 'File or directory path inside repository.',
      },
      ref: {
        type: 'string',
        description: 'Branch, tag, or commit SHA (default: default branch / HEAD).',
      },
      limit: {
        type: 'number',
        description: 'Maximum commits to return (1-100, default: 20).',
      },
      since: {
        type: 'string',
        description: 'Optional ISO 8601 timestamp to filter commits after.',
      },
      until: {
        type: 'string',
        description: 'Optional ISO 8601 timestamp to filter commits before.',
      },
    },
    required: ['owner', 'repo', 'path'],
  },
  async execute(args, context) {
    try {
      const parsed = InputSchema.safeParse(args);
      if (!parsed.success) {
        throw new InvalidInputError(parsed.error.issues.map((i) => i.message).join(' '));
      }

      const { owner, repo, path, ref, limit, since, until } = parsed.data;
      checkRepoAllowed(owner, repo, context.allowedRepos);

      const resolved = await context.provider.resolveRef(owner, repo, ref ?? 'HEAD');
      const result = await context.provider.getPathHistory(
        owner,
        repo,
        path,
        resolved.sha,
        limit,
        since,
        until
      );

      const truncationNote = result.truncated
        ? ` [truncated at limit ${limit}; narrow with 'since', 'until', or a subpath]`
        : '';
      const summary = `Path history for '${path}' at commit ${resolved.sha.slice(0, 7)}: ${result.commits.length} commit(s)${truncationNote}`;

      return formatSuccessResponse(summary, {
        owner,
        repo,
        path,
        refSha: resolved.sha,
        limit,
        truncated: result.truncated,
        commits: result.commits,
      });
    } catch (err: unknown) {
      return formatMcpError(err);
    }
  },
};
