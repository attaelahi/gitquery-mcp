import { z } from 'zod';
import { GitProvider } from '../providers/types.js';
import { ICache } from '../cache/memory.js';
import { isRepoPermitted } from '../config.js';
import { RepoNotAllowedError } from '../util/errors.js';

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolContext {
  provider: GitProvider;
  cache: ICache;
  allowedRepos: string[];
}

export type McpToolResult = CallToolResult;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute(args: unknown, context: ToolContext): Promise<McpToolResult>;
}

export const OwnerSchema = z
  .string()
  .min(1, 'Owner must not be empty.')
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Owner must contain only alphanumerics, dashes, underscores, or dots.');

export const RepoSchema = z
  .string()
  .min(1, 'Repo must not be empty.')
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Repo must contain only alphanumerics, dashes, underscores, or dots.');

export const PathSchema = z
  .string()
  .min(1, 'Path must not be empty.')
  .refine(
    (p) => !p.split(/[/\\]/).includes('..') && !p.startsWith('../') && !p.includes('/../'),
    'Path must not contain ".." segments.'
  );

export const RefSchema = z.string().min(1, 'Ref must not be empty.').default('HEAD');

export function checkRepoAllowed(owner: string, repo: string, allowedRepos: string[]): void {
  if (!isRepoPermitted(owner, repo, allowedRepos)) {
    throw new RepoNotAllowedError(owner, repo);
  }
}

export function formatSuccessResponse(summary: string, data?: unknown): McpToolResult {
  let text = summary;
  if (data !== undefined) {
    text += `\n\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`;
  }
  return {
    content: [{ type: 'text', text }],
  };
}
