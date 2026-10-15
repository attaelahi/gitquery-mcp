import { RateLimitExceededError } from './errors.js';
import { logger } from './logger.js';

export interface RateLimitInfo {
  remaining: number;
  resetTimeMs: number;
  limit?: number;
}

export function extractRateLimitInfo(headers: Record<string, unknown> | undefined): RateLimitInfo | null {
  if (!headers) return null;

  const remainingHeader = headers['x-ratelimit-remaining'];
  const resetHeader = headers['x-ratelimit-reset'];
  const limitHeader = headers['x-ratelimit-limit'];

  if (remainingHeader === undefined && resetHeader === undefined) {
    return null;
  }

  const remaining = remainingHeader !== undefined ? Number(remainingHeader) : -1;
  const resetSeconds = resetHeader !== undefined ? Number(resetHeader) : 0;
  const resetTimeMs = resetSeconds > 0 ? resetSeconds * 1000 : Date.now() + 60000;
  const limit = limitHeader !== undefined ? Number(limitHeader) : undefined;

  return {
    remaining,
    resetTimeMs,
    limit,
  };
}

export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    maxBackoffMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const maxBackoffMs = options.maxBackoffMs ?? 15000; // If required sleep > 15s, throw RateLimitExceeded immediately
  const sleep = options.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt++;

      const isRateLimitError = checkIsRateLimitError(err);
      if (!isRateLimitError || attempt > maxRetries) {
        if (isRateLimitError) {
          const resetTimeMs = getResetTimeMs(err);
          throw new RateLimitExceededError(resetTimeMs);
        }
        throw err;
      }

      const waitMs = calculateBackoffMs(err, attempt);
      if (waitMs > maxBackoffMs) {
        const resetTimeMs = getResetTimeMs(err);
        logger.warn(`Rate limit wait time (${waitMs}ms) exceeds max allowable backoff (${maxBackoffMs}ms). Aborting retries.`);
        throw new RateLimitExceededError(resetTimeMs);
      }

      logger.warn(`Rate limit or secondary rate limit encountered (attempt ${attempt}/${maxRetries}). Retrying in ${waitMs}ms...`);
      await sleep(waitMs);
    }
  }
}

function checkIsRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const status = (err as { status?: number }).status;
  const message = ((err as { message?: string }).message || '').toLowerCase();
  const response = (err as { response?: { headers?: Record<string, unknown> } }).response;
  const headers = response?.headers;

  if (status === 429) {
    return true;
  }

  if (status === 403) {
    if (message.includes('rate limit') || message.includes('secondary rate limit')) {
      return true;
    }
    if (headers && headers['x-ratelimit-remaining'] === '0') {
      return true;
    }
    if (headers && headers['retry-after'] !== undefined) {
      return true;
    }
  }

  return false;
}

function getResetTimeMs(err: unknown): number {
  if (err && typeof err === 'object') {
    const response = (err as { response?: { headers?: Record<string, unknown> } }).response;
    const rateLimit = extractRateLimitInfo(response?.headers);
    if (rateLimit && rateLimit.resetTimeMs > 0) {
      return rateLimit.resetTimeMs;
    }
  }
  return Date.now() + 60000;
}

function calculateBackoffMs(err: unknown, attempt: number): number {
  if (err && typeof err === 'object') {
    const response = (err as { response?: { headers?: Record<string, unknown> } }).response;
    const retryAfter = response?.headers?.['retry-after'];
    if (retryAfter !== undefined) {
      const seconds = Number(retryAfter);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }

    const resetHeader = response?.headers?.['x-ratelimit-reset'];
    if (resetHeader !== undefined) {
      const resetEpochSec = Number(resetHeader);
      if (!isNaN(resetEpochSec) && resetEpochSec > 0) {
        const diff = resetEpochSec * 1000 - Date.now();
        if (diff > 0) {
          return diff;
        }
      }
    }
  }

  // Exponential backoff with jitter: 1s, 2s, 4s + jitter
  const baseDelay = 1000 * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 500);
  return baseDelay + jitter;
}
