#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { configureLogger, logger } from './util/logger.js';
import { MemoryCache } from './cache/memory.js';
import { GitHubProvider } from './providers/github.js';
import { allTools, toolsByName } from './tools/index.js';
import { ToolContext } from './tools/common.js';

import { DiskCache } from './cache/disk.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  configureLogger({
    level: config.logLevel,
    tokenToRedact: config.githubToken,
  });

  logger.info('Starting gitquery-mcp server...', {
    allowedRepos: config.allowedRepos.length > 0 ? config.allowedRepos : 'all',
    cacheSize: config.cacheSize,
    cacheTtlMutableSeconds: config.cacheTtlMutableSeconds,
    diskCacheDir: config.diskCacheDir ?? 'disabled',
    hasToken: Boolean(config.githubToken),
  });

  const diskCache = config.diskCacheDir
    ? new DiskCache({
        cacheDir: config.diskCacheDir,
        maxSizeBytes: config.diskCacheMaxBytes,
      })
    : undefined;

  const cache = new MemoryCache(config.cacheSize, diskCache);
  const provider = new GitHubProvider({
    token: config.githubToken,
    cache,
    allowedRepos: config.allowedRepos,
    cacheTtlMutableSeconds: config.cacheTtlMutableSeconds,
  });

  const toolContext: ToolContext = {
    provider,
    cache,
    allowedRepos: config.allowedRepos,
  };

  const server = new Server(
    {
      name: 'gitquery-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List all available git history query tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('ListTools requested');
    return {
      tools: allTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // Dispatch tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolsByName.get(name);

    if (!tool) {
      logger.warn(`CallTool invoked on unknown tool: ${name}`);
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }

    logger.debug(`Executing tool: ${name}`);
    try {
      const result = await tool.execute(args, toolContext);
      return result;
    } catch (err: unknown) {
      logger.error(`Error executing tool: ${name}`, err);
      throw err;
    }
  });

  const transport = new StdioServerTransport();

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gitquery-mcp server...');
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gitquery-mcp server...');
    await server.close();
    process.exit(0);
  });

  await server.connect(transport);
  logger.info(`gitquery-mcp server is running and listening on stdio with ${allTools.length} tools registered.`);
}

main().catch((err: unknown) => {
  logger.error('Fatal error starting gitquery-mcp server', err);
  process.exit(1);
});
