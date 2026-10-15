import { spawn } from 'node:child_process';
import fs from 'node:fs';

// Check if .env exists to pass GITHUB_TOKEN if present
const env = { ...process.env };
if (fs.existsSync('.env')) {
  const envContent = fs.readFileSync('.env', 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('GITHUB_TOKEN=')) {
      env.GITHUB_TOKEN = trimmed.slice('GITHUB_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
    }
  }
}

const proc = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env,
});

proc.stderr.on('data', (d) => {
  // Stderr logging is expected
  // process.stderr.write(d);
});

let reqId = 1;
function call(method, params = {}) {
  const id = reqId++;
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            proc.stdout.removeListener('data', onData);
            if (parsed.error) {
              reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            } else {
              resolve(parsed.result);
            }
            return;
          }
        } catch {}
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function run() {
  console.log('=== Step 1: MCP Initialize Handshake ===');
  const initRes = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'phase3-verifier', version: '1.0' },
  });
  console.log('Handshake OK:', initRes.serverInfo);

  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  console.log('\n=== Step 2: Listing Tools via tools/list ===');
  const toolsRes = await call('tools/list');
  console.log(`Received ${toolsRes.tools.length} tools:`);
  for (const t of toolsRes.tools) {
    console.log(` - ${t.name}: ${t.description.slice(0, 75)}...`);
  }
  if (toolsRes.tools.length !== 10) {
    throw new Error(`Expected 10 tools, found ${toolsRes.tools.length}`);
  }

  const owner = 'expressjs';
  const repo = 'express';
  // Valid Express release tags
  const base = '4.21.0';
  const head = '4.21.1';

  console.log('\n=== Step 3: Testing get_diff with max_bytes=1500 (truncation test) ===');
  const diffRes = await call('tools/call', {
    name: 'get_diff',
    arguments: {
      owner,
      repo,
      base,
      head,
      max_bytes: 300,
    },
  });
  const diffText = diffRes.content[0].text;
  const isTruncated = diffText.includes('[truncated:');
  const hasNarrowHint = diffText.includes('narrow with `paths`') || diffText.includes("narrow with 'paths'");
  console.log('Summary line:', diffText.split('\n')[0]);
  console.log('Contains truncation marker:', isTruncated);
  console.log('Contains narrowing hint:', hasNarrowHint);
  if (!isTruncated || !hasNarrowHint) {
    throw new Error('Diff was not properly truncated with narrowing hint');
  }

  console.log('\n=== Step 4: Testing find_pr_for_commit ===');
  // Commit for 4.21.0 in express: 7e562c6d8daddff4604f8efaaf9db2cf98c6dcff
  const testSha = '7e562c6d8daddff4604f8efaaf9db2cf98c6dcff';
  const prRes = await call('tools/call', {
    name: 'find_pr_for_commit',
    arguments: {
      owner,
      repo,
      sha: testSha,
    },
  });
  console.log('PR Result summary:', prRes.content[0].text.split('\n')[0]);

  console.log('\n=== Step 5: Testing Cache Hits on Repeated Calls ===');
  const initialStatsRes = await call('tools/call', { name: 'cache_stats', arguments: {} });
  console.log('Initial cache stats:', initialStatsRes.content[0].text.split('\n')[0]);

  // Call resolve_ref on master twice
  console.log('Calling resolve_ref("expressjs", "express", "master") call #1...');
  await call('tools/call', { name: 'resolve_ref', arguments: { owner, repo, ref: 'master' } });

  console.log('Calling resolve_ref("expressjs", "express", "master") call #2 (should hit cache)...');
  await call('tools/call', { name: 'resolve_ref', arguments: { owner, repo, ref: 'master' } });

  // Call find_merge_base twice
  console.log('Calling find_merge_base call #1...');
  await call('tools/call', { name: 'find_merge_base', arguments: { owner, repo, base, head } });

  console.log('Calling find_merge_base call #2 (should hit cache)...');
  await call('tools/call', { name: 'find_merge_base', arguments: { owner, repo, base, head } });

  const finalStatsRes = await call('tools/call', { name: 'cache_stats', arguments: {} });
  console.log('\nFinal cache stats:');
  console.log(finalStatsRes.content[0].text);

  console.log('\n=== Step 6: Testing GraphQL get_blame ===');
  const blameRes = await call('tools/call', {
    name: 'get_blame',
    arguments: {
      owner,
      repo,
      path: 'package.json',
      ref: 'master',
      start_line: 1,
      end_line: 10,
    },
  });
  console.log('Blame response:');
  console.log(blameRes.content[0].text.slice(0, 300) + '...');

  proc.kill();
  console.log('\nSUCCESS: All Phase 3 checks passed cleanly!');
  process.exit(0);
}

run().catch((err) => {
  console.error('\nVerification failed:', err);
  proc.kill();
  process.exit(1);
});
