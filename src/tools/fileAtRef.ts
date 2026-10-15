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

export const getFileAtRefTool: McpTool = {
  name: 'get_file_at_ref',
  description:
    'Retrieves file content at a specific ref or commit, with optional line slicing. Use to inspect historical code without cloning. Rejects binary files and files exceeding 1 MB. Narrow with start_line and end_line.',
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

      const resolved = await context.provider.resolveRef(owner, repo, ref ?? 'HEAD');
      const result = await context.provider.getFileAtRef(
        owner,
        repo,
        path,
        resolved.sha,
        start_line,
        end_line
      );

      const sliceNote = result.isTruncated
        ? ` (sliced lines ${result.startLine}-${result.endLine} of ${result.totalLines} total; narrow with 'start_line' and 'end_line')`
        : ` (${result.totalLines} lines total)`;

      const summary = `Content of '${path}' at commit ${resolved.sha.slice(0, 7)}${sliceNote}`;

      return formatSuccessResponse(summary, {
        owner,
        repo,
        path,
        refSha: resolved.sha,
        totalLines: result.totalLines,
        startLine: result.startLine,
        endLine: result.endLine,
        isTruncated: result.isTruncated,
        content: result.content,
      });
    } catch (err: unknown) {
      return formatMcpError(err);
    }
  },
};
