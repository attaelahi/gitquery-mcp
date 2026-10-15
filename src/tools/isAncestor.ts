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
  ancestor: z.string().min(1, 'Ancestor ref must not be empty.'),
  descendant: z.string().min(1, 'Descendant ref must not be empty.'),
});

export const isAncestorTool: McpTool = {
  name: 'is_ancestor',
  description:
    "Determines whether commit 'ancestor' is an ancestor of commit 'descendant'. Use to verify whether a fix or feature branch is already contained within another branch without cloning. Returns a boolean and explanation.",
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
      ancestor: {
        type: 'string',
        description: 'Candidate ancestor commit SHA, branch, or tag.',
      },
      descendant: {
        type: 'string',
        description: 'Candidate descendant commit SHA, branch, or tag.',
      },
    },
    required: ['owner', 'repo', 'ancestor', 'descendant'],
  },
  async execute(args, context) {
    try {
      const parsed = InputSchema.safeParse(args);
      if (!parsed.success) {
        throw new InvalidInputError(parsed.error.issues.map((i) => i.message).join(' '));
      }

      const { owner, repo, ancestor, descendant } = parsed.data;
      checkRepoAllowed(owner, repo, context.allowedRepos);

      const [ancResolved, descResolved] = await Promise.all([
        context.provider.resolveRef(owner, repo, ancestor),
        context.provider.resolveRef(owner, repo, descendant),
      ]);

      const ancSha = ancResolved.sha;
      const descSha = descResolved.sha;

      if (ancSha === descSha) {
        const summary = `${ancSha.slice(0, 7)} is identical to ${descSha.slice(0, 7)} (a commit is an ancestor of itself)`;
        return formatSuccessResponse(summary, {
          isAncestor: true,
          ancestor: { ref: ancestor, sha: ancSha },
          descendant: { ref: descendant, sha: descSha },
          mergeBaseSha: ancSha,
          aheadBy: 0,
          behindBy: 0,
          explanation: 'Ancestor and descendant resolve to the exact same commit.',
        });
      }

      // In git compare(base, head):
      // base=ancestor, head=descendant
      // descendant is ahead of ancestor with 0 behind commits if ancestor is an ancestor of descendant
      const cmp = await context.provider.compare(owner, repo, ancSha, descSha);
      const isAncestor = cmp.behindBy === 0 || cmp.mergeBaseSha === ancSha;

      let explanation: string;
      if (isAncestor) {
        explanation = `Commit ${ancSha.slice(0, 7)} is an ancestor of ${descSha.slice(0, 7)} (${descSha.slice(0, 7)} is ${cmp.aheadBy} commit(s) ahead with 0 behind).`;
      } else {
        explanation = `Commit ${ancSha.slice(0, 7)} is NOT an ancestor of ${descSha.slice(0, 7)} (branches diverged with merge base ${cmp.mergeBaseSha.slice(0, 7)}; descendant is ${cmp.behindBy} commit(s) behind ancestor).`;
      }

      const summary = `${ancSha.slice(0, 7)} is ${isAncestor ? '' : 'NOT '}an ancestor of ${descSha.slice(0, 7)}`;

      return formatSuccessResponse(summary, {
        isAncestor,
        ancestor: { ref: ancestor, sha: ancSha },
        descendant: { ref: descendant, sha: descSha },
        mergeBaseSha: cmp.mergeBaseSha,
        aheadBy: cmp.aheadBy,
        behindBy: cmp.behindBy,
        explanation,
      });
    } catch (err: unknown) {
      return formatMcpError(err);
    }
  },
};
