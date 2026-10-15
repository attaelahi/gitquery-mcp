import { z } from 'zod';
import {
  McpTool,
  OwnerSchema,
  RepoSchema,
  checkRepoAllowed,
  formatSuccessResponse,
} from './common.js';
import { formatMcpError, InvalidInputError } from '../util/errors.js';

const InputSchema = z.object({
  owner: OwnerSchema,
  repo: RepoSchema,
  base: z.string().min(1, 'Base ref must not be empty.'),
  head: z.string().min(1, 'Head ref must not be empty.'),
  path_prefix: z.string().optional(),
});

export const listChangedFilesTool: McpTool = {
  name: 'list_changed_files',
  description:
    'Lists all files modified, added, or deleted between two git refs with change statistics. Use to survey changes across commits or branches. Capped at 500 files; narrow with path_prefix.',
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
      base: {
        type: 'string',
        description: 'Base branch, tag, or commit SHA.',
      },
      head: {
        type: 'string',
        description: 'Head branch, tag, or commit SHA.',
      },
      path_prefix: {
        type: 'string',
        description: 'Optional path prefix to restrict results (e.g. "src/").',
      },
    },
    required: ['owner', 'repo', 'base', 'head'],
  },
  async execute(args, context) {
    try {
      const parsed = InputSchema.safeParse(args);
      if (!parsed.success) {
        throw new InvalidInputError(parsed.error.issues.map((i) => i.message).join(' '));
      }

      const { owner, repo, base, head, path_prefix } = parsed.data;
      checkRepoAllowed(owner, repo, context.allowedRepos);

      const [baseResolved, headResolved] = await Promise.all([
        context.provider.resolveRef(owner, repo, base),
        context.provider.resolveRef(owner, repo, head),
      ]);

      const result = await context.provider.listChangedFiles(
        owner,
        repo,
        baseResolved.sha,
        headResolved.sha,
        path_prefix
      );

      const truncMsg = result.truncated
        ? ` [truncated at 500 files from ${result.totalCount} total; narrow with 'path_prefix']`
        : '';
      const summary = `Changed files between ${baseResolved.sha.slice(0, 7)} and ${headResolved.sha.slice(0, 7)}: ${result.files.length} file(s)${truncMsg}`;

      return formatSuccessResponse(summary, {
        owner,
        repo,
        baseSha: baseResolved.sha,
        headSha: headResolved.sha,
        totalCount: result.totalCount,
        filesReturned: result.files.length,
        truncated: result.truncated,
        pathPrefix: path_prefix,
        files: result.files,
      });
    } catch (err: unknown) {
      return formatMcpError(err);
    }
  },
};
