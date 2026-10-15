import { McpTool, formatSuccessResponse } from './common.js';
import { formatMcpError } from '../util/errors.js';

export const cacheStatsTool: McpTool = {
  name: 'cache_stats',
  description:
    'Returns in-memory cache metrics including total cache hits, misses, current entry count, and hit rate percentage. Use to inspect caching performance and verify cache hits.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute(_args, context) {
    try {
      const stats = context.cache.getStats();
      const pct = (stats.hitRate * 100).toFixed(1);
      const summary = `Cache stats: ${stats.hits} hit(s), ${stats.misses} miss(es), ${stats.size} item(s) cached (${pct}% hit rate)`;

      return formatSuccessResponse(summary, {
        hits: stats.hits,
        misses: stats.misses,
        size: stats.size,
        hitRate: stats.hitRate,
        hitRatePercentage: `${pct}%`,
      });
    } catch (err: unknown) {
      return formatMcpError(err);
    }
  },
};
