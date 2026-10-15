import { LRUCache } from 'lru-cache';
import { DiskCache } from './disk.js';

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
  diskFiles?: number;
  diskSizeBytes?: number;
}

export interface ICache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs?: number): void;
  has(key: string): boolean;
  clear(): void;
  getStats(): CacheStats;
}

export class MemoryCache implements ICache {
  private readonly lru: LRUCache<string, {}>;
  private readonly diskCache?: DiskCache;
  private hits = 0;
  private misses = 0;

  constructor(maxSize = 5000, diskCache?: DiskCache) {
    this.lru = new LRUCache<string, {}>({
      max: maxSize,
      ttlAutopurge: true,
    });
    this.diskCache = diskCache;
  }

  public get<T>(key: string): T | undefined {
    const value = this.lru.get(key) as T | undefined;
    if (value !== undefined) {
      this.hits++;
      return value;
    }

    if (this.diskCache) {
      const fromDisk = this.diskCache.get<T>(key);
      if (fromDisk !== undefined) {
        this.lru.set(key, fromDisk as {}, { ttl: 0 });
        this.hits++;
        return fromDisk;
      }
    }

    this.misses++;
    return undefined;
  }

  public set<T>(key: string, value: T, ttlMs?: number): void {
    if (ttlMs !== undefined && ttlMs > 0) {
      this.lru.set(key, value as {}, { ttl: ttlMs });
    } else {
      this.lru.set(key, value as {}, { ttl: 0 });
      // Immutable SHA-addressed data: persist to disk if configured
      if (this.diskCache) {
        this.diskCache.set(key, value);
      }
    }
  }

  public has(key: string): boolean {
    if (this.lru.has(key)) {
      return true;
    }
    if (this.diskCache) {
      return this.diskCache.get(key) !== undefined;
    }
    return false;
  }

  public clear(): void {
    this.lru.clear();
    this.diskCache?.clear();
    this.hits = 0;
    this.misses = 0;
  }

  public getStats(): CacheStats {
    const total = this.hits + this.misses;
    const stats: CacheStats = {
      hits: this.hits,
      misses: this.misses,
      size: this.lru.size,
      hitRate: total > 0 ? Number((this.hits / total).toFixed(4)) : 0,
    };

    if (this.diskCache) {
      const diskStats = this.diskCache.getStats();
      stats.diskFiles = diskStats.totalFiles;
      stats.diskSizeBytes = diskStats.totalSizeBytes;
    }

    return stats;
  }
}
