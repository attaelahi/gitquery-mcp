import fs from 'node:fs';
import path from 'node:path';
import { GitHubProvider } from '../src/providers/github.js';
import { MemoryCache } from '../src/cache/memory.js';

// Try reading GITHUB_TOKEN from process.env or .env file
let token = process.env.GITHUB_TOKEN;
if (!token && fs.existsSync('.env')) {
  const envContent = fs.readFileSync('.env', 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('GITHUB_TOKEN=')) {
      token = trimmed.slice('GITHUB_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
      break;
    }
  }
}

async function run() {
  console.log('=== GitQuery Live GitHub API Verification ===');
  console.log('Token detected:', token ? `Yes (${token.slice(0, 4)}...${token.slice(-4)})` : 'No (unauthenticated)');

  const cache = new MemoryCache();
  const provider = new GitHubProvider({
    token,
    cache,
  });

  const owner = 'expressjs';
  const repo = 'express';
  const branch = 'master';
  const testFile = 'package.json';

  console.log(`\n1. Testing resolveRef("${owner}", "${repo}", "${branch}")...`);
  const resolved = await provider.resolveRef(owner, repo, branch);
  console.log('-> Resolved:', resolved);

  console.log(`\n2. Testing getPathHistory("${owner}", "${repo}", "${testFile}", "${resolved.sha}", 3)...`);
  const history = await provider.getPathHistory(owner, repo, testFile, resolved.sha, 3);
  console.log(`-> Found ${history.commits.length} commits:`, history.commits.map(c => `[${c.sha.slice(0, 7)}] ${c.messageHeadline}`));

  console.log(`\n3. Testing getFileAtRef("${owner}", "${repo}", "${testFile}", "${resolved.sha}", 1, 5)...`);
  const fileContent = await provider.getFileAtRef(owner, repo, testFile, resolved.sha, 1, 5);
  console.log(`-> Sliced lines ${fileContent.startLine}-${fileContent.endLine} of ${fileContent.totalLines}:`);
  console.log(fileContent.content);

  console.log(`\n4. Testing GraphQL getBlame("${owner}", "${repo}", "${testFile}", "${resolved.sha}", 1, 5)...`);
  if (!token) {
    console.log('-> SKIPPED: GitHub GraphQL API strictly requires GITHUB_TOKEN.');
    console.log('   Add GITHUB_TOKEN=ghp_... to .env and re-run this script to verify GraphQL blame live.');
  } else {
    try {
      const blame = await provider.getBlame(owner, repo, testFile, resolved.sha, 1, 5);
      console.log(`-> Blame succeeded! ${blame.ranges.length} ranges returned:`);
      for (const r of blame.ranges) {
        console.log(`   Lines ${r.startLine}-${r.endLine} by ${r.authorName} (${r.commitSha.slice(0, 7)}) PR: ${r.pullRequest?.number ?? 'none'}`);
      }
    } catch (err) {
      console.error('-> GraphQL Blame Error:', err);
    }
  }

  console.log('\n=== Cache Stats ===');
  console.log(cache.getStats());
}

run().catch((err) => {
  console.error('Live check failed:', err);
  process.exit(1);
});
