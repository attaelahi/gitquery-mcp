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

const InputSchema = z
  .object({
    owner: OwnerSchema,
    repo: RepoSchema,
    path: PathSchema,
    ref: RefSchema.optional(),
    start_line: z.coerce.number().int().positive().optional(),
    end_line: z.coerce.number().int().positive().optional(),
  })
  .refine(
    (data) => {
      if (data.start_line !== undefined && data.end_line !== undefined) {
        return data.start_line <= data.end_line;
      }
      return true;
    },
    { message: 'start_line must be less than or equal to end_line.' }
  );

export const getBlameTool: McpTool = {
  name: 'get_blame',
  description:
    'Returns line-by-line git blame annotations for a file at a commit or ref. Use to identify who changed specific lines, when, in which commit, and via which PR. Returns ranges of lines with commit, author, and PR metadata. Use start_line and end_line to slice.',
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
        description: 'File path inside repository.',
      },
      ref: {
        type: 'string',
        description: 'Branch, tag, or commit SHA (default: default branch / HEAD).',
      },
      start_line: {
        type: 'number',
        description: 'Optional 1-indexed starting line number.',
      },
      end_line: {
        type: 'number',
        description: 'Optional 1-indexed ending line number.',
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

      const { owner, repo, path, ref, start_line, end_line } = parsed.data;
      checkRepoAllowed(owner, repo, context.allowedRepos);

      // Resolve ref to full commit SHA first
      const resolved = await context.provider.resolveRef(owner, repo, ref ?? 'HEAD');
      const blame = await context.provider.getBlame(
        owner,
        repo,
        path,
        resolved.sha,
        start_line,
        end_line
      );

      const lineRangeStr =
        start_line || end_line
          ? ` (lines ${start_line ?? 1}-${end_line ?? blame.totalLines})`
          : ` (${blame.totalLines} lines total)`;

      const summary = `Blame for '${path}' at commit ${resolved.sha.slice(0, 7)}${lineRangeStr}: ${blame.ranges.length} range(s)`;

      return formatSuccessResponse(summary, {
        owner,
        repo,
        path,
        refSha: resolved.sha,
        totalLines: blame.totalLines,
        startLine: start_line ?? 1,
        endLine: end_line ?? blame.totalLines,
        ranges: blame.ranges,
      });
    } catch (err: unknown) {
      return formatMcpError(err);
    }
  },
};
