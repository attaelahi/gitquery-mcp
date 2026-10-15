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
});

export const findMergeBaseTool: McpTool = {
  name: 'find_merge_base',
  description:
    'Finds the common ancestor commit (merge base) between two git refs and reports ahead/behind commit counts. Use to check branch divergence before merging or comparing histories. Returns mergeBaseSha, aheadBy, behindBy, and status.',
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
    },
    required: ['owner', 'repo', 'base', 'head'],
  },
  async execute(args, context) {
    try {
      const parsed = InputSchema.safeParse(args);
      if (!parsed.success) {
        throw new InvalidInputError(parsed.error.issues.map((i) => i.message).join(' '));
      }

      const { owner, repo, base, head } = parsed.data;
      checkRepoAllowed(owner, repo, context.allowedRepos);

      const [baseResolved, headResolved] = await Promise.all([
        context.provider.resolveRef(owner, repo, base),
        context.provider.resolveRef(owner, repo, head),
      ]);

      const result = await context.provider.compare(
        owner,
        repo,
        baseResolved.sha,
        headResolved.sha
      );

      const summary = `Merge base of ${baseResolved.sha.slice(0, 7)} and ${headResolved.sha.slice(0, 7)} is ${result.mergeBaseSha.slice(0, 7)} (status: ${result.status}, ahead: ${result.aheadBy}, behind: ${result.behindBy})`;

      return formatSuccessResponse(summary, {
        owner,
        repo,
        base: { ref: base, sha: baseResolved.sha },
        head: { ref: head, sha: headResolved.sha },
        mergeBaseSha: result.mergeBaseSha,
        aheadBy: result.aheadBy,
        behindBy: result.behindBy,
        status: result.status,
        totalCommits: result.totalCommits,
      });
    } catch (err: unknown) {
      return formatMcpError(err);
    }
  },
};
