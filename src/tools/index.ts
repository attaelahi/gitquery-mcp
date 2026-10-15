import { McpTool } from './common.js';
import { resolveRefTool } from './resolveRef.js';
import { getBlameTool } from './blame.js';
import { getPathHistoryTool } from './pathHistory.js';
import { findMergeBaseTool } from './mergeBase.js';
import { isAncestorTool } from './isAncestor.js';
import { findPrForCommitTool } from './prForCommit.js';
import { listChangedFilesTool } from './changedFiles.js';
import { getDiffTool } from './diff.js';
import { getFileAtRefTool } from './fileAtRef.js';
import { cacheStatsTool } from './cacheStats.js';

export const allTools: McpTool[] = [
  resolveRefTool,
  getBlameTool,
  getPathHistoryTool,
  findMergeBaseTool,
  isAncestorTool,
  findPrForCommitTool,
  listChangedFilesTool,
  getDiffTool,
  getFileAtRefTool,
  cacheStatsTool,
];

export const toolsByName = new Map<string, McpTool>(
  allTools.map((t) => [t.name, t])
);

export {
  resolveRefTool,
  getBlameTool,
  getPathHistoryTool,
  findMergeBaseTool,
  isAncestorTool,
  findPrForCommitTool,
  listChangedFilesTool,
  getDiffTool,
  getFileAtRefTool,
  cacheStatsTool,
};
