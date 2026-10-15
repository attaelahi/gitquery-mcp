type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLogLevel: LogLevel = 'info';
let secretToken: string | undefined = undefined;

export function configureLogger(options: { level?: LogLevel; tokenToRedact?: string }): void {
  if (options.level) {
    currentLogLevel = options.level;
  }
  if (options.tokenToRedact && options.tokenToRedact.length >= 4) {
    secretToken = options.tokenToRedact;
  }
}

function sanitize(text: string): string {
  let cleaned = text;
  if (secretToken) {
    cleaned = cleaned.replaceAll(secretToken, '[REDACTED_TOKEN]');
  }
  // Generic GitHub token patterns (ghp_, gho_, ghu_, ghb_, github_pat_)
  cleaned = cleaned.replace(/gh[pousr]_[A-Za-z0-9_]{36,255}/g, '[REDACTED_GH_TOKEN]');
  cleaned = cleaned.replace(/github_pat_[A-Za-z0-9_]{82}/g, '[REDACTED_PAT_TOKEN]');
  // Bearer tokens
  cleaned = cleaned.replace(/(Bearer\s+)[A-Za-z0-9_\-\.]{10,}/gi, '$1[REDACTED_AUTH]');
  return cleaned;
}

function log(level: LogLevel, message: string, meta?: unknown): void {
  if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[currentLogLevel]) {
    return;
  }

  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

  if (meta !== undefined) {
    try {
      if (meta instanceof Error) {
        line += `\n${meta.name}: ${meta.message}`;
      } else {
        line += ` ${JSON.stringify(meta)}`;
      }
    } catch {
      line += ' [Unserializable metadata]';
    }
  }

  const sanitized = sanitize(line);
  process.stderr.write(`${sanitized}\n`);
}

export const logger = {
  debug: (message: string, meta?: unknown) => log('debug', message, meta),
  info: (message: string, meta?: unknown) => log('info', message, meta),
  warn: (message: string, meta?: unknown) => log('warn', message, meta),
  error: (message: string, meta?: unknown) => log('error', message, meta),
};
