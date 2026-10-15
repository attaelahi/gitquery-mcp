import { z } from 'zod';
import {
  McpTool,
  OwnerSchema,
  RepoSchema,
  checkRepoAllowed,
} from './common.js';
import { formatMcpError, InvalidInputError } from '../util/errors.js';
import { truncateUtf8Bytes } from '../util/truncate.js';

const InputSchema = z.object({
  owner: OwnerSchema,
  repo: RepoSchema,
  base: z.string().min(1, 'Base ref must not be empty.'),
  head: z.string().min(1, 'Head ref must not be empty.'),
  paths: z.array(z.string().min(1)).optional(),
  max_bytes: z.coerce.number().int().positive().default(60000),
});

export const getDiffTool: McpTool = {
  name: 'get_diff',
  description:
    'Returns the unified git diff between two refs, optionally restricted to specific file paths. Use to inspect code changes without cloning. Output is truncated at max_bytes (default 60KB; narrow with paths).',
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
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional file paths to restrict diff output.',
      },
      max_bytes: {
        type: 'number',
        description: 'Maximum UTF-8 bytes to return before truncation (default: 60000).',
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

      const { owner, repo, base, head, paths, max_bytes } = parsed.data;
      checkRepoAllowed(owner, repo, context.allowedRepos);

      const [baseResolved, headResolved] = await Promise.all([
        context.provider.resolveRef(owner, repo, base),
        context.provider.resolveRef(owner, repo, head),
      ]);

      const rawDiff = await context.provider.getDiff(
        owner,
        repo,
        baseResolved.sha,
        headResolved.sha,
        paths
      );

      const truncated = truncateUtf8Bytes(rawDiff, max_bytes, 'narrow with `paths`');

      const pathNote = paths && paths.length > 0 ? ` for ${paths.length} path(s)` : '';
      const sizeNote = truncated.isTruncated
        ? ` (truncated at ${max_bytes} bytes; ${truncated.excessBytes} bytes cut; narrow with 'paths')`
        : ` (${truncated.originalBytes} bytes)`;

      const summary = `Diff between ${baseResolved.sha.slice(0, 7)} and ${headResolved.sha.slice(0, 7)}${pathNote}${sizeNote}`;

      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\n${truncated.text}`,
          },
        ],
      };
    } catch (err: unknown) {
      return formatMcpError(err);
    }
  },
};
