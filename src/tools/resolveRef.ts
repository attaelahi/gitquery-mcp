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
  ref: z.string().min(1, 'Ref must not be empty.'),
});

export const resolveRefTool: McpTool = {
  name: 'resolve_ref',
  description:
    'Resolves a git reference (branch name, tag, or partial SHA) to a full 40-character commit SHA. Use before queries when you need the canonical immutable commit identifier. Returns {sha, refType}. Fast and cached.',
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
      ref: {
        type: 'string',
        description: 'Branch name, tag name, or commit SHA to resolve.',
      },
    },
    required: ['owner', 'repo', 'ref'],
  },
  async execute(args, context) {
    try {
      const parsed = InputSchema.safeParse(args);
      if (!parsed.success) {
        throw new InvalidInputError(parsed.error.issues.map((i) => i.message).join(' '));
      }

      const { owner, repo, ref } = parsed.data;
      checkRepoAllowed(owner, repo, context.allowedRepos);

      const resolved = await context.provider.resolveRef(owner, repo, ref);
      const summary = `Resolved ref '${ref}' to commit ${resolved.sha} (${resolved.refType}) in ${owner}/${repo}`;

      return formatSuccessResponse(summary, {
        owner,
        repo,
        ref,
        sha: resolved.sha,
        refType: resolved.refType,
      });
    } catch (err: unknown) {
      return formatMcpError(err);
    }
  },
};
