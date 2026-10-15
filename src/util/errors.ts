export class GitQueryError extends Error {
  public readonly code: string;

  constructor(message: string, code: string = 'GITQUERY_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RepoNotAllowedError extends GitQueryError {
  constructor(owner: string, repo: string) {
    super(
      `Access to repository '${owner}/${repo}' is prohibited by ALLOWED_REPOS configuration.`,
      'REPO_NOT_ALLOWED'
    );
  }
}

export class AuthenticationError extends GitQueryError {
  constructor(message = 'GitHub authentication failed or GITHUB_TOKEN is invalid/missing.') {
    super(message, 'AUTHENTICATION_FAILED');
  }
}

export class NotFoundError extends GitQueryError {
  constructor(owner: string, repo: string) {
    super(
      `Repository '${owner}/${repo}' was not found or the provided token lacks permission to view it.`,
      'REPO_NOT_FOUND'
    );
  }
}

export class RefNotFoundError extends GitQueryError {
  constructor(owner: string, repo: string, ref: string) {
    super(
      `Reference '${ref}' was not found in repository '${owner}/${repo}'.`,
      'REF_NOT_FOUND'
    );
  }
}

export class PathNotFoundError extends GitQueryError {
  constructor(path: string, ref: string) {
    super(
      `Path '${path}' does not exist at reference '${ref}'.`,
      'PATH_NOT_FOUND'
    );
  }
}

export class RateLimitExceededError extends GitQueryError {
  public readonly resetTimeMs: number;

  constructor(resetTimeMs: number, message?: string) {
    const formattedReset = new Date(resetTimeMs).toISOString();
    super(
      message ?? `GitHub API rate limit exceeded. Limit resets at ${formattedReset}.`,
      'RATE_LIMIT_EXCEEDED'
    );
    this.resetTimeMs = resetTimeMs;
  }
}

export class FileTooLargeError extends GitQueryError {
  constructor(path: string, sizeBytes: number, limitBytes = 1048576) {
    super(
      `File '${path}' is ${(sizeBytes / 1024 / 1024).toFixed(2)} MB, exceeding the 1.00 MB limit (${limitBytes} bytes). Query a specific line range or use git clone.`,
      'FILE_TOO_LARGE'
    );
  }
}

export class BinaryFileError extends GitQueryError {
  constructor(path: string) {
    super(
      `File '${path}' appears to be binary and cannot be returned as text.`,
      'BINARY_FILE'
    );
  }
}

export class InvalidInputError extends GitQueryError {
  constructor(message: string) {
    super(`Invalid input: ${message}`, 'INVALID_INPUT');
  }
}

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Normalizes any error into an MCP tool error response.
 * Strictly guarantees no stack traces, raw system paths, or secret tokens leak.
 */
export function formatMcpError(err: unknown): CallToolResult {
  let message: string;

  if (err instanceof GitQueryError) {
    message = err.message;
  } else if (err instanceof Error) {
    // Check for standard Octokit errors or parse them safely
    const status = (err as { status?: number }).status;
    if (status === 401) {
      message = 'GitHub authentication failed. Check your GITHUB_TOKEN.';
    } else if (status === 404) {
      message = 'The requested GitHub resource was not found. Verify repository, ref, and path.';
    } else if (status === 403 || status === 429) {
      message = 'GitHub API rate limit reached or access forbidden. Check permissions and rate limits.';
    } else {
      // General sanitization of message
      message = err.message.replace(/https:\/\/[^@\s]+@github\.com/gi, 'https://github.com');
    }
  } else {
    message = 'An unexpected error occurred while processing the request.';
  }

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Error: ${message}`,
      },
    ],
  };
}
