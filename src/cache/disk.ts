import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../util/logger.js';

export interface DiskCacheOptions {
  cacheDir: string;
  maxSizeBytes?: number; // default 200 MB
}

interface CacheEnvelope<T = unknown> {
  key: string;
  data: T;
  createdAt: number;
}

export class DiskCache {
  public readonly cacheDir: string;
  public readonly maxSizeBytes: number;

  constructor(options: DiskCacheOptions) {
    this.cacheDir = path.resolve(options.cacheDir);
    this.maxSizeBytes = options.maxSizeBytes ?? 200 * 1024 * 1024;

    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (err: unknown) {
      logger.warn(`Failed to create disk cache directory '${this.cacheDir}'`, err);
    }
  }

  /**
   * Hashes key to safe filename using sha256.
   */
  private getFilePath(key: string): string {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(this.cacheDir, `${hash}.json`);
  }

  /**
   * Checks whether key is immutable (SHA-addressed) and eligible for disk persistence.
   * Mutable ref resolutions (:resolveRef:) must NEVER be stored on disk.
   */
  public isEligible(key: string): boolean {
    if (key.includes(':resolveRef:')) {
      return false;
    }
    return true;
  }

  public get<T>(key: string): T | undefined {
    if (!this.isEligible(key)) {
      return undefined;
    }

    const filePath = this.getFilePath(key);
    try {
      if (!fs.existsSync(filePath)) {
        return undefined;
      }

      const raw = fs.readFileSync(filePath, 'utf-8');
      const envelope = JSON.parse(raw) as CacheEnvelope<T>;

      if (envelope.key !== key) {
        // Hash collision or mismatched key
        return undefined;
      }

      // Touch file update mtime for LRU eviction tracking
      const now = new Date();
      try {
        fs.utimesSync(filePath, now, now);
      } catch {
        // Ignore utimes failure
      }

      return envelope.data;
    } catch (err: unknown) {
      // Corrupt or unreadable file: remove it safely and do NOT crash
      logger.warn(`Ignoring corrupt or unreadable cache file for key '${key}'`, err);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Ignore unlink failure
      }
      return undefined;
    }
  }

  public set<T>(key: string, data: T): void {
    if (!this.isEligible(key)) {
      return;
    }

    const filePath = this.getFilePath(key);
    try {
      const envelope: CacheEnvelope<T> = {
        key,
        data,
        createdAt: Date.now(),
      };

      const serialized = JSON.stringify(envelope);
      const tempPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;

      // Atomic write via temp file rename
      fs.writeFileSync(tempPath, serialized, 'utf-8');
      fs.renameSync(tempPath, filePath);

      // Perform eviction if total size exceeds limit
      this.evictIfNeeded();
    } catch (err: unknown) {
      logger.warn(`Failed to write disk cache entry for key '${key}'`, err);
    }
  }

  /**
   * Evicts oldest cache files when total disk cache exceeds maxSizeBytes.
   */
  public evictIfNeeded(): void {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        return;
      }

      const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.json'));
      const fileStats: Array<{ filePath: string; size: number; mtime: number }> = [];
      let totalSize = 0;

      for (const file of files) {
        const fullPath = path.join(this.cacheDir, file);
        try {
          const stat = fs.statSync(fullPath);
          fileStats.push({ filePath: fullPath, size: stat.size, mtime: stat.mtimeMs });
          totalSize += stat.size;
        } catch {
          // File might have been removed concurrently
        }
      }

      if (totalSize <= this.maxSizeBytes) {
        return;
      }

      // Sort by mtime ascending (oldest first)
      fileStats.sort((a, b) => a.mtime - b.mtime);

      for (const item of fileStats) {
        if (totalSize <= this.maxSizeBytes) {
          break;
        }
        try {
          fs.unlinkSync(item.filePath);
          totalSize -= item.size;
          logger.debug(`Evicted oldest disk cache file: ${path.basename(item.filePath)}`);
        } catch {
          // Ignore unlink errors
        }
      }
    } catch (err: unknown) {
      logger.warn('Error during disk cache eviction check', err);
    }
  }

  public clear(): void {
    try {
      if (!fs.existsSync(this.cacheDir)) return;
      const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.json') || f.endsWith('.tmp'));
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(this.cacheDir, file));
        } catch {}
      }
    } catch (err: unknown) {
      logger.warn('Failed to clear disk cache', err);
    }
  }

  public getStats(): { totalFiles: number; totalSizeBytes: number } {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        return { totalFiles: 0, totalSizeBytes: 0 };
      }
      const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.json'));
      let totalSize = 0;
      for (const file of files) {
        try {
          const stat = fs.statSync(path.join(this.cacheDir, file));
          totalSize += stat.size;
        } catch {}
      }
      return { totalFiles: files.length, totalSizeBytes: totalSize };
    } catch {
      return { totalFiles: 0, totalSizeBytes: 0 };
    }
  }
}
