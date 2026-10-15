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
  sha: z.string().min(1, 'Commit SHA or ref must not be empty.'),
});

export const findPrForCommitTool: McpTool = {
  name: 'find_pr_for_commit',
  description:
    'Finds merged pull requests associated with a commit SHA. Use to discover original PR discussions, reviews, and context for an existing commit. Returns PR number, title, URL, merged date, and author.',
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
      sha: {
        type: 'string',
        description: 'Commit SHA, branch, or tag to look up.',
      },
    },
    required: ['owner', 'repo', 'sha'],
  },
  async execute(args, context) {
    try {
      const parsed = InputSchema.safeParse(args);
      if (!parsed.success) {
        throw new InvalidInputError(parsed.error.issues.map((i) => i.message).join(' '));
      }

      const { owner, repo, sha } = parsed.data;
      checkRepoAllowed(owner, repo, context.allowedRepos);

      const resolved = await context.provider.resolveRef(owner, repo, sha);
      const prs = await context.provider.getPullRequestsForCommit(owner, repo, resolved.sha);

      const summary = `Found ${prs.length} merged pull request(s) associated with commit ${resolved.sha.slice(0, 7)}`;

      return formatSuccessResponse(summary, {
        owner,
        repo,
        sha: resolved.sha,
        pullRequests: prs,
      });
    } catch (err: unknown) {
      return formatMcpError(err);
    }
  },
};
