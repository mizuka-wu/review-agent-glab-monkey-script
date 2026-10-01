[简体中文](../capability-boundary.md) | **English**

# Capability Boundaries: Browser and GitLab API

This document answers one core question: which features the userscript can do on its own, which must depend on the GitLab API, and which require a local service.

> **Current scope**: a pure browser-side implementation, with no local Gateway / CI Bot. Capabilities that need a server or local process are explicitly excluded.
> Exception (planned, optional): the MCP local relay bridge acts as an **optional integration process** playing the standard MCP server role,
> see the repository root [TODO.md](https://github.com/mizuka-wu/review-agent-glab-monkey-script/blob/main/TODO.md); the default installation path does not include it.

## 1. Overall Conclusion

| Capability | Userscript | GitLab API / page | Conclusion |
| --- | --- | --- | --- |
| Page injection, select-to-ask, floating toolbar | Implemented directly | Not needed | Possible in a pure browser |
| Reading selected text, file names, current URL | Implemented directly | DOM-assisted | Possible in a pure browser |
| Chatbox, session UI, Markdown rendering | Implemented directly | Not needed | Possible in a pure browser |
| Reading MR title, description, changed files, diffs | Can issue requests | Requires REST | Browser + GitLab API |
| Reading full files, historical versions | Can request on demand | Requires API | Possible in the browser |
| Agent tool loop (file_read/search/git_log) | Can issue requests | Requires API | Possible in the browser |
| Calling OpenAI/Anthropic/Gemini models | Direct connection | Not applicable | Possible in the browser |
| Enterprise gateway authentication (custom header/query) | Implemented directly | Not applicable | Possible in the browser |
| MCP extension tools (Streamable HTTP) | GM.xmlHttpRequest | Not applicable | Possible in the browser |
| Repository-level symbol search, call chains | Unreliable | Limited API capability | Requires a local process (excluded) |
| Running tests, lint, builds | Not possible | Not possible | Requires a local process (excluded) |
| Publishing precise line comments | Can be invoked | Requires the Discussions API | Possible in the browser; confirmation required |
| Comment deduplication, idempotent updates | Can be implemented | Requires reading Discussions | Possible in the browser |
| Team rules, rule pack management | Can store local configuration | — | Possible in the browser |
| Secure key storage | Obfuscated storage | — | Possible in the browser |

## 2. What the Userscript Can Accomplish on Its Own

### 2.1 Page Host Capabilities

- Injects a Shadow DOM UI to avoid polluting GitLab styles.
- Listens for `selectionchange` / `mouseup` / `keyup` and shows the selection toolbar.
- Extracts the project path, MR IID, file path, and line numbers from the URL, breadcrumbs, and diff DOM.
- Opens the sidebar, chat, Review results, settings, and diagnostics pages.
- Copies or submits comment drafts after the user confirms.

### 2.2 Shallow Context Building

- The currently selected code plus several surrounding lines.
- The diff hunk of the current file.
- The current MR description, title, and source / target branches.
- The current list of changed files and the file range the user selected.
- Discussion content already rendered on the page (optional).

This context is sufficient for explanation, local risk analysis, and lightweight Review, but it does not equal repository-level understanding.

## 3. What Must Use the GitLab API

| Data / operation | Recommended endpoint | Notes |
| --- | --- | --- |
| MR metadata | `GET /projects/:id/merge_requests/:iid` | Fetches title, state, diff_refs, version |
| Change list | `GET .../merge_requests/:iid/diffs` | Paginated; better suited to large MRs than `changes` |
| Diff refs | MR metadata or `GET .../versions` | Required for publishing a position |
| File content | `GET /projects/:id/repository/files/:path/raw` | Readable by ref |
| Single-file diff | `GET .../diffs` or GraphQL | Avoids fetching everything at once |
| Create line comment | `POST .../merge_requests/:iid/discussions` | Must submit a position |
| Read existing comments | `GET .../merge_requests/:iid/discussions` | Deduplication, incremental Review |
| Pipeline / Commit | REST or GraphQL | Can serve as evidence; no command execution in the MVP |

For detailed endpoints, fields, and fallback strategies, see [GitLab Integration](gitlab-integration.md).

## 4. What Requires Local Support

### 4.1 Local Agent Gateway

The Gateway is an optional service on the user's machine, responsible for:

- Holding model API keys and provider adapter configuration.
- Mapping `gitlabHost + projectPath` to a local clone / bare mirror.
- Providing tools such as file reading, Git history, search, and rule matching.
- Running multi-stage Reviews, concurrent file groups, budgets, and cancellation.
- Producing structured Findings and returning streaming progress.
- Caching repositories, rules, and non-sensitive session metadata.

### 4.2 Why These Capabilities Don't Fit the Browser

- A browser cannot read a local repository directly, nor run Git / test commands reliably.
- CORS, enterprise IdPs, self-signed certificates, and provider protocol differences substantially increase front-end complexity.
- Long-running tasks are affected by page refreshes, script updates, and browser reclamation.
- Storing model / GitLab tokens in `GM.setValue` provides limited security.
- Repository-level search and indexing need a local file system and background caching.

## 5. Recommended Responsibility Split

```text
Userscript
  - page recognition, select-to-ask, UI, user confirmation
  - reading GitLab data accessible from the current browser session
  - sending minimal context to the model or the Gateway
  - writing to GitLab only after user confirmation

GitLab API
  - source of truth for MR / Diff / File / Discussion
  - validation of diff refs and comment positions

Local Agent Gateway (optional)
  - model keys, providers, repository tools, rules, long-running tasks, caching
  - holds no GitLab write permissions
```

## 6. Capability Differences Across the Three Modes

### Mode A: Browser Direct Connection to the Model

- Suited for: select-to-ask Q&A, single-hunk Review, quick drafts.
- Requires: the user to fill in the model base URL, model name, and API key; the site allows requests, or userscript cross-origin permissions are available.
- Not supported: reliable repository search, builds / tests, complex Agent tools, recovery of long-running tasks.
- Risks: key storage, CORS, self-hosted TLS, token leakage surface.

### Mode B: Local Gateway

- Suited for: full MR Review, cross-file context, team rules, stable streaming tasks.
- Requires: a local service, project mapping, model provider configuration.
- Advantages: keys never leave the local machine, protocol adaptation is centralized, caching is possible, tools can run.

### Mode C: CI Bot

- Suited for: automatic triggering, unattended operation, a unified bot identity.
- Requires: a GitLab Runner, service account token, pipeline configuration.
- Distinction: not a userscript capability, but a server-side executor that reuses the Finding contract.

## 7. Compatibility Strategy for Self-Hosted GitLab-Like Sites

Do not judge capability by domain name; probe in the following order:

1. Whether the URL matches GitLab project / MR routes.
2. Whether `GET /api/v4/version` or unauthenticated project metadata is accessible.
3. Whether the MR API returns fields such as `diff_refs`, `sha`, and `versions`.
4. Whether the Discussions position API supports the target version.
5. Whether the DOM retains stable data attributes; prefer the API when they are unreliable.

Adaptation results are classified as:

- `full`: reading, comment anchoring, and comment publishing are all available.
- `read-only`: analysis is possible, but safe anchoring / publishing is not.
- `dom-only`: only current page content can be used; suited to select-to-ask.
- `unsupported`: no Review entry point is injected; only diagnostics are shown.

## 8. When to Upgrade to the Gateway

When any of the following needs arises, a direct browser connection is no longer appropriate:

- Reading definitions, call sites, or tests that are not in the diff.
- The Review scope exceeds a single model context budget.
- Running lint, unit tests, type checks, or custom scripts.
- Generating Findings consistently from team rule packs.
- Resuming from checkpoints, concurrency, caching, auditing, or cost accounting.
- The model provider does not support a secure direct browser connection.

## 9. Explicitly Not Supported

- Running local shell commands securely from the browser.
- Storing long-lived, high-privilege GitLab / model keys in the pure front end without warning about the risk.
- Automatically fixing and committing code.
- Guessing comment line positions without diff refs.
- Promising full compatibility with the custom DOM of arbitrary GitLab forks.
