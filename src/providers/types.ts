export type RefType = 'sha' | 'branch' | 'tag';

export interface ResolvedRef {
  sha: string;
  refType: RefType;
}

export interface BlamePullRequest {
  number: number;
  title: string;
  url: string;
}

export interface BlameRange {
  startLine: number;
  endLine: number;
  commitSha: string;
  authorName: string;
  authorDate: string;
  messageHeadline: string;
  pullRequest?: BlamePullRequest;
}

export interface BlameResult {
  ranges: BlameRange[];
  totalLines: number;
  path: string;
  refSha: string;
}

export interface PathHistoryCommit {
  sha: string;
  author: string;
  date: string;
  messageHeadline: string;
}

export interface PathHistoryResult {
  commits: PathHistoryCommit[];
  truncated: boolean;
}

export type CompareStatus = 'diverged' | 'ahead' | 'behind' | 'identical';

export interface CompareResult {
  mergeBaseSha: string;
  aheadBy: number;
  behindBy: number;
  status: CompareStatus;
  totalCommits: number;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  mergedAt?: string;
  author: string;
}

export type FileChangeStatus =
  | 'added'
  | 'removed'
  | 'modified'
  | 'renamed'
  | 'copied'
  | 'changed'
  | 'unchanged';

export interface ChangedFile {
  filename: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  changes: number;
}

export interface ChangedFilesResult {
  files: ChangedFile[];
  totalCount: number;
  truncated: boolean;
}

export interface FileContentResult {
  content: string;
  path: string;
  sha: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  isTruncated: boolean;
}

/**
 * Common GitProvider abstraction.
 * All repository data tools interact strictly via this interface.
 */
export interface GitProvider {
  readonly name: string;

  /**
   * Resolves a reference (branch, tag, or short/full SHA) to a 40-character commit SHA.
   */
  resolveRef(owner: string, repo: string, ref: string): Promise<ResolvedRef>;

  /**
   * Retrieves line-by-line git blame for a path at a specific commit SHA.
   */
  getBlame(
    owner: string,
    repo: string,
    path: string,
    sha: string,
    startLine?: number,
    endLine?: number
  ): Promise<BlameResult>;

  /**
   * Lists commits that modified the specified path up to the given commit SHA.
   */
  getPathHistory(
    owner: string,
    repo: string,
    path: string,
    sha: string,
    limit?: number,
    since?: string,
    until?: string
  ): Promise<PathHistoryResult>;

  /**
   * Compares two commits and identifies the merge base and ahead/behind counts.
   */
  compare(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string
  ): Promise<CompareResult>;

  /**
   * Retrieves merged pull requests associated with a specific commit SHA.
   */
  getPullRequestsForCommit(
    owner: string,
    repo: string,
    sha: string
  ): Promise<PullRequestSummary[]>;

  /**
   * Lists files modified between baseSha and headSha, optionally filtered by pathPrefix.
   */
  listChangedFiles(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
    pathPrefix?: string
  ): Promise<ChangedFilesResult>;

  /**
   * Retrieves the raw unified git diff between baseSha and headSha, optionally restricted to specific file paths.
   */
  getDiff(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
    paths?: string[]
  ): Promise<string>;

  /**
   * Fetches the text content of a file at a specific commit SHA, optionally slicing lines.
   */
  getFileAtRef(
    owner: string,
    repo: string,
    path: string,
    sha: string,
    startLine?: number,
    endLine?: number
  ): Promise<FileContentResult>;
}
