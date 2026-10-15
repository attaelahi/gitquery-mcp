import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DiskCache } from '../src/cache/disk.js';
import { MemoryCache } from '../src/cache/memory.js';

describe('DiskCache', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `gitquery-disk-test-${crypto.randomBytes(6).toString('hex')}`);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('writes and reads back immutable entries', () => {
    const diskCache = new DiskCache({ cacheDir: tempDir });
    const key = 'github:owner/repo:blame:1111111111111111111111111111111111111111:path="index.ts"';
    const payload = { ranges: [{ line: 1, author: 'Alice' }] };

    diskCache.set(key, payload);
    const retrieved = diskCache.get<typeof payload>(key);
    expect(retrieved).toEqual(payload);
  });

  it('never persists ref-to-SHA mutable resolutions on disk', () => {
    const diskCache = new DiskCache({ cacheDir: tempDir });
    const mutableKey = 'github:owner/repo:resolveRef:main';
    const payload = { sha: '1'.repeat(40), refType: 'branch' };

    diskCache.set(mutableKey, payload);
    const retrieved = diskCache.get(mutableKey);
    expect(retrieved).toBeUndefined();

    // Verify directory has 0 files
    const stats = diskCache.getStats();
    expect(stats.totalFiles).toBe(0);
  });

  it('evicts oldest entries when total size exceeds maxSizeBytes', async () => {
    // 500 bytes limit
    const diskCache = new DiskCache({ cacheDir: tempDir, maxSizeBytes: 500 });

    const key1 = 'github:owner/repo:tool:1111111111111111111111111111111111111111:1';
    const key2 = 'github:owner/repo:tool:2222222222222222222222222222222222222222:2';
    const key3 = 'github:owner/repo:tool:3333333333333333333333333333333333333333:3';

    // Each large value is ~250 bytes serialized
    const largeData = { text: 'X'.repeat(200) };

    diskCache.set(key1, largeData);
    await new Promise((r) => setTimeout(r, 50));
    diskCache.set(key2, largeData);
    await new Promise((r) => setTimeout(r, 50));
    diskCache.set(key3, largeData);

    // key1 is oldest and should have been evicted to keep total size <= 500 bytes
    expect(diskCache.get(key1)).toBeUndefined();
    expect(diskCache.get(key3)).toBeDefined();
  });

  it('ignores corrupted cache files without crashing and cleans them up', () => {
    const diskCache = new DiskCache({ cacheDir: tempDir });
    const key = 'github:owner/repo:tool:4444444444444444444444444444444444444444';

    diskCache.set(key, { valid: true });

    // Corrupt the underlying file on disk
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const filePath = path.join(tempDir, `${hash}.json`);
    fs.writeFileSync(filePath, '{ bad json content ...', 'utf-8');

    // Should return undefined and safely delete the bad file
    const res = diskCache.get(key);
    expect(res).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('integrates seamlessly with MemoryCache tiering', () => {
    const diskCache = new DiskCache({ cacheDir: tempDir });
    const memCache = new MemoryCache(10, diskCache);

    const key = 'github:owner/repo:tool:5555555555555555555555555555555555555555';
    memCache.set(key, { tiered: true });

    // Create a new MemoryCache instance pointing to the same disk directory
    const newMemCache = new MemoryCache(10, diskCache);

    // Initial memory cache should miss and load from disk cache
    const loaded = newMemCache.get<{ tiered: boolean }>(key);
    expect(loaded).toEqual({ tiered: true });

    // Second read should now be a memory hit
    const stats = newMemCache.getStats();
    expect(stats.hits).toBe(1);
  });
});
