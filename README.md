# gitquery-mcp

> **"Ask your repo questions through an API, no clone required."**

A fast, lightweight [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that provides read-only repository history tools backed directly by GitHub APIs (GraphQL + REST), featuring aggressive caching of immutable data.

---

## Why gitquery-mcp?

AI coding agents frequently need answers about a repository's history:
* *Who last touched this function and why?*
* *Which pull request introduced this breaking change?*
* *What is the merge base between feature and main?*
* *What changed inside this specific directory between two release tags?*

Today, agents solve this by running `git clone` or shelling out to local `git`. This approach is heavy on disk, drains network bandwidth, and fails entirely in container sandboxes where local repositories do not exist.

The architectural inspiration comes from Anthropic's engineering post, [*"Redesigning source control at Anthropic"*](https://www.anthropic.com/engineering/redesigning-source-control):
> Source control queries should be fast, server-side API lookups. Clients and AI agents should never need a full local copy of a repository just to inspect history.

`gitquery-mcp` exposes read-only git history tools over standard MCP stdio transport, caches immutable commit-addressed results aggressively, and works with public or private repositories without cloning a single byte.

---

## Features

* 🚀 **Zero-Clone Operations**: Answers blame, diff, log, and merge-base questions over the GitHub API.
* ⚡ **Aggressive Caching**: Data addressed by a 40-character commit SHA is mathematically immutable and cached permanently. Symbolic branch/tag resolutions use a short, configurable TTL.
* 💾 **Two-Tier Cache**: High-speed in-memory LRU cache plus an optional persistent disk cache (`GITQUERY_CACHE_DIR`) that survives server restarts.
* 🛡️ **Strictly Read-Only & Secure**: Zero write operations exist. Auth tokens are read only from `GITHUB_TOKEN`, redacted from logs and errors, and never returned to the LLM.
* 🔒 **Repository Allowlisting**: Restrict the server to specific repositories or organizations via `ALLOWED_REPOS`.
* 📏 **Output Discipline**: Diff and history outputs are strictly bounded with explicit truncation markers and instructions for LLMs to narrow their queries.
* 🔌 **Provider Abstraction**: All GitHub operations sit behind a clean `GitProvider` interface, designed for future GitLab / Bitbucket backends.

---

## Quick Start (npx)

Run `gitquery-mcp` instantly without local installation:

```bash
npx -y gitquery-mcp
```

With GitHub authentication:

```bash
GITHUB_TOKEN=ghp_yourTokenHere npx -y gitquery-mcp
```

---

## Client Configuration

### 1. Claude Desktop
Add to your `claude_desktop_config.json`:
* **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
* **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gitquery": {
      "command": "npx",
      "args": ["-y", "gitquery-mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_yourPersonalAccessTokenHere",
        "ALLOWED_REPOS": ""
      }
    }
  }
}
```

### 2. Claude Code CLI
Add using the Claude Code MCP command:

```bash
claude mcp add gitquery -- npx -y gitquery-mcp
```

*(Note: Ensure `GITHUB_TOKEN` is exported in your active shell or passed in your environment).*

### 3. Gemini CLI / Generic MCP Client
For MCP-compliant clients configuring servers via JSON:

```json
{
  "name": "gitquery",
  "command": "npx",
  "args": ["-y", "gitquery-mcp"],
  "env": {
    "GITHUB_TOKEN": "ghp_yourTokenHere",
    "GITQUERY_CACHE_DIR": ".gitquery-cache"
  }
}
```

> [!NOTE]
> Client syntax for Claude Desktop and Claude Code was verified against official MCP specifications. If your client uses a custom schema or runner, adjust the `command`, `args`, and `env` properties accordingly.

---

## Available Tools

All 10 tools validate input via Zod, enforce `ALLOWED_REPOS`, and return a one-line summary followed by compact structured JSON:

| Tool | Description | Example Prompt |
| :--- | :--- | :--- |
| **`resolve_ref`** | Resolves a branch, tag, or partial SHA to a full 40-character commit SHA. | *"What is the exact commit SHA of branch 'release-2.4' in vercel/next.js?"* |
| **`get_blame`** | Line-by-line blame ranges with author, date, and associated merged PR. | *"Who last edited lines 40 to 80 of src/router.ts in expressjs/express and in what PR?"* |
| **`get_path_history`** | Lists commits that modified a file or folder (capped at 100). | *"Show me the last 5 commits that touched the docs/ folder in facebook/react."* |
| **`find_merge_base`** | Finds the common ancestor commit and ahead/behind counts between two refs. | *"Find the merge base between 'main' and 'feature/login' in myorg/webapp."* |
| **`is_ancestor`** | Evaluates whether commit A is an ancestor of commit B with full explanation. | *"Is commit a419aa7 an ancestor of master in expressjs/express?"* |
| **`find_pr_for_commit`** | Finds merged pull requests associated with a commit SHA. | *"Find the pull request that merged commit 7e562c6 in expressjs/express."* |
| **`list_changed_files`** | Lists modified, added, or deleted files between two refs (capped at 500). | *"What files changed between v4.21.0 and v4.21.1 in expressjs/express?"* |
| **`get_diff`** | Returns unified git diff between refs, truncated at `max_bytes` (default 60KB). | *"Show me the diff of package.json between tag 4.21.0 and 4.21.1 in expressjs/express."* |
| **`get_file_at_ref`** | Retrieves text content of a file at a ref, with optional line range slicing. | *"Show lines 1 to 50 of README.md at commit f1573b8 in expressjs/express."* |
| **`cache_stats`** | Returns cache hits, misses, entry count, and hit rate percentage. | *"Check the gitquery cache hit rate."* |

---

## How Caching Works

Caching is the core architectural value of `gitquery-mcp`:

1. **Immutable by Commit SHA**: Anything addressed by a 40-character commit SHA (`get_blame`, `compare`, `get_diff`, `get_file_at_ref`, `get_path_history`) is mathematically immutable. Results are cached **forever** in memory.
2. **Short TTL for Mutable Refs**: Resolving branches or tags (`main`, `HEAD`, `v1.0`) to a SHA is cached for a short TTL (default: 30 seconds, configurable via `CACHE_TTL_MUTABLE_SECONDS`).
3. **Optional Persistent Disk Cache**: Set `GITQUERY_CACHE_DIR=.gitquery-cache`. All immutable SHA-addressed queries are written atomically to disk and survive server restarts. Mutable ref resolutions are never written to disk. Total disk size is capped (default: 200 MB), automatically evicting the oldest entries first.
4. **Resilience**: Unreadable or corrupted cache files are deleted safely without interrupting requests or crashing the server.

---

## Security & Best Practices

* **Read-Only**: `gitquery-mcp` does not contain a single write or mutating API endpoint.
* **Token Safety**: The GitHub token is loaded **only** from the `GITHUB_TOKEN` environment variable. It is never logged (auto-redacted by `src/util/logger.ts`) and never exposed in MCP tool responses.
* **Minimal Scope**: A GitHub Fine-Grained Personal Access Token with read-only permissions is recommended:
  * **Repository Permissions**:
    * `Contents`: Read-only *(for file content, blame, commits, diffs)*
    * `Pull requests`: Read-only *(for PR association)*
* **Repository Allowlist (`ALLOWED_REPOS`)**: Restrict access to approved repositories:
  ```env
  ALLOWED_REPOS=facebook/react,vercel/*,my-org/private-repo
  ```
  Any attempt to query unlisted repositories is rejected with an immediate error before dispatching API requests.

---

## Limits & Truncation Behavior

To protect LLM context windows and token budgets, responses are strictly bounded:
* **Diffs**: Default max size is 60,000 UTF-8 bytes (customizable via `max_bytes`). If a diff exceeds the limit, it is cleanly truncated with a notice:
  `[truncated: 12450 more bytes, narrow with paths]`
* **File Content**: Files over 1 MB (1,048,576 bytes) and binary files (detected by null bytes) are refused with a clear error advising line slicing or cloning.
* **Changed Files**: Capped at 500 files with advice to filter with `path_prefix`.
* **Path History**: Capped at 100 commits (default: 20) with advice to narrow with `since` or `until`.

---

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `GITHUB_TOKEN` | *(optional)* | GitHub Personal Access Token (classic or fine-grained). |
| `ALLOWED_REPOS` | `""` | Comma-separated list of allowed repos (`owner/repo` or `owner/*`). |
| `GITQUERY_CACHE_DIR` | *(disabled)* | Directory path for optional persistent on-disk cache. |
| `GITQUERY_CACHE_MAX_BYTES` | `209715200` | Disk cache capacity ceiling in bytes (default: 200 MB). |
| `CACHE_SIZE` | `5000` | In-memory LRU cache maximum entry count. |
| `CACHE_TTL_MUTABLE_SECONDS` | `30` | In-memory TTL for mutable branch/tag ref resolutions. |
| `LOG_LEVEL` | `"info"` | Stderr logging verbosity (`debug`, `info`, `warn`, `error`). |

---

## Roadmap

* [ ] **GitLab & Bitbucket Providers**: Implement `GitProvider` for GitLab (REST + GraphQL) and self-hosted instances.
* [ ] **AGENTS.md Repo-Rules Guard**: A tool checking candidate diffs against guidelines specified in an `AGENTS.md` file in the repository.
* [ ] **Intelligent Change Classifier**: Classify diff hunks into comment-only, documentation, test-only, logic, or security-sensitive changes.
* [ ] **Post-Merge Auto-Bisect & Revert**: Automated commit bisecting over the GitHub API to pinpoint regressions without local cloning.

---

## Contributing

Pull requests and issues are welcome!

```bash
git clone https://github.com/[your-org]/gitquery-mcp.git
cd gitquery-mcp
npm install
npm run build
npm test
```

---

## License

[MIT](LICENSE) © 2026 [Your Name or Organization]
