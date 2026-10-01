[简体中文](README.md) | **English**

# Review Agent for GitLab

[![Release](https://img.shields.io/github/v/release/mizuka-wu/review-agent-glab-monkey-script)](https://github.com/mizuka-wu/review-agent-glab-monkey-script/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/mizuka-wu/review-agent-glab-monkey-script/ci.yml?branch=main)](https://github.com/mizuka-wu/review-agent-glab-monkey-script/actions/workflows/ci.yml) [![Docs](https://img.shields.io/badge/docs-VitePress-blue)](https://mizuka-wu.github.io/review-agent-glab-monkey-script/) [![DeepWiki](https://deepwiki.com/badge-maker?url=https%3A%2F%2Fdeepwiki.com%2Fmizuka-wu%2Freview-agent-glab-monkey-script)](https://deepwiki.com/mizuka-wu/review-agent-glab-monkey-script)

A Tampermonkey userscript for GitLab / self-hosted GitLab that provides code review capabilities on MR / Diff / File pages. It adopts the same **deterministic rules + LLM hybrid architecture** as [OpenCodeReview](https://github.com/alibaba/open-code-review): rule checks always run locally in the browser (no API key needed, zero tokens), and once a model is configured an AI deep review is layered on top — the two kinds of results are labeled separately, and hits on the same issue are merged automatically. Supports select-to-ask, structured Finding drafts, and batch publishing of GitLab Discussions.

## Core Features

### 🧩 Hybrid Review (works without an API key)
- **Rule stage always runs**: 24 built-in deterministic rules execute locally in the browser, with no network access and no token consumption; Review remains usable when no model is configured
- **Model stage optional**: three modes — `Rules + AI` / `Rules only` / `AI only`; when a model call fails it automatically degrades to the rule results
- **Distinguishable sources**: every Finding is labeled `Rules` / `AI` / `Rules + AI` (mutually corroborating); you can filter by source, view grouped by source, and see the matched rule id
- **Not-configured hints**: the sidebar and the settings page clearly list currently available capabilities and what is missing, with a one-click jump to configuration

### 🤖 Model Review
- **OpenAI-compatible API**: official endpoints, enterprise gateways, and local proxies all work; four authentication modes — Bearer Token, API Key Header, Query Parameter, Custom Header (the Key may be left empty when the gateway requires no auth)
- **Local model hints**: the "?" next to Base URL lists the default ports and `/v1`-suffixed compatible addresses for omlx / Ollama / LM Studio, clickable to fill in; localhost endpoints automatically fetch the `/v1/models` list; the model name is a combobox (type-in + dropdown suggestions), and when the current model is not in the server's list it automatically switches to the first available model and saves immediately; the model can also be switched directly at the top of the chat area; a "disable reasoning output" toggle can suppress reasoning leakage from omlx/vLLM
- **Agent tool loop**: the model can actively call the `file_read`, `search_code`, and `git_log` tools to gather repository context
- **MCP extensions**: connect to multiple MCP servers at once (Streamable HTTP / SSE); tool names are prefixed by server id to avoid conflicts and calls are routed by prefix; legacy single-server configs migrate automatically
- **Structured reasoning**: the reasoning pane is collapsed by default; expanding it shows key-point extraction and a prose/JSON/code segmented timeline; the raw stream can be toggled on or off
- **Session replay**: historical sessions are read-only replays; you can mark items as fixed/ignored, restore drafts, hide processed items, and restore the session as the current one
- **SSE streaming output**: chat renders token by token; the Review model stage also streams — the reasoning channel (`reasoning_content`) is presented as a collapsible typewriter effect (collapsed by default, live word count), findings enter the result list one by one incrementally as the stream flows, and the raw JSON is collapsed by default for troubleshooting only; you can "cancel" at any time to stop; when the server does not support SSE it automatically falls back to a one-shot read; rule results are rendered first as soon as the rule stage completes
- **Three review intensity levels**: fast (high confidence only), balanced (default), thorough (comprehensive)
- **Per-project supplementary requirements**: both the start page's "Start a hybrid review" and the settings page let you configure supplementary prompts for each project (injected into the review user message, remembered per project); the settings page can switch between cached projects and delete them

### 📋 Review Engine
- **Rule pack system**: 24 built-in multi-language rules (hardcoded secrets, URL credentials, SQL injection, XSS, command injection, disabled TLS verification, weak hashing, predictable randomness, static mutable shared state, Java `equals`, Kotlin `!!`, TS non-null assertion, weak typing, swallowed exceptions, Go discarded error, blocking sleep, skipped tests, debug output, intranet addresses, TODO, conflict markers, missing tests), matched by language and glob path scope, skipping comment lines, with a per-file hit cap; supports custom rule packs (regex, scope, language, JSON import/export, per-rule toggles), stored separately under **public / current project** scopes and loaded dynamically, with a project-custom pack overriding a public pack of the same id; built-in rules use the `rule_docs/*.md` language docs as the single source of truth (frontmatter + matching patterns + positive/negative examples), with a generator producing the code and a drift check
- **Context Builder**: Diff file filtering (lockfiles/generated files/secrets/binaries excluded), character budget truncation, omitted-reason recording
- **Finding anchoring**: multi-line exact matching of `existingCode`, old/new-side line-number inference, cross-file relocation
- **Large MR grouped concurrency**: changed files grouped by directory cohesion, each group reviewed concurrently with its own context (concurrency 3); a failed group keeps the remaining results
- **Comment reflection**: the model self-checks AI Findings (is it worth commenting / is it a duplicate / is the position correct); dropped items go into warnings; skipped at fast intensity
- **Review hardening**: evidence sufficiency check, severity calibration, merging same-origin similar Findings, cross-source corroboration merging, confidence filtering (applies only to AI results)
- **Idempotent publishing**: fingerprint dedup, `head_sha` validation, `stale_diff_refs` detection, Discussion sync
- **Evaluation benchmark**: 31 fixtures (one labeled sample per rule + clean negative samples), detection rate ≥ 80%, precision ≥ 70%, 100% on security rules, 0 false positives on clean code

### 🎯 Finding Management
- **Full lifecycle**: draft → edit → locate → copy → publish / ignore
- **In-page highlighting**: mark Finding locations on GitLab Diff pages, with severity color coding
- **Batch publishing**: checkbox multi-select → preview and confirm → create Discussions one by one
- **Quick actions**: one-click Approve, one-click inline comments (for all publishable drafts), publish a general MR comment; all are two-step confirmations to prevent misfires
- **Filter & sort**: filter by source/severity/category/status, sort by severity/source/file
- **Session/Resume**: restore the last Review session after refreshing the page
- **Result export**: one-click copy of the findings structured JSON (source/evidence/anchor/status) and the Delegation context (file selection + applicable rules + Diff + background, for external agents to review with their own models)

### 🔎 Repository Index (symbol search / call chain)
- **Local symbol table**: GitLab REST has no symbol-level API, so the script caches repository files in the browser's OPFS ([opfs-worker](https://github.com/kachurun/opfs-worker), independent Worker → main thread → memory three-level fallback) and builds a symbol table
- **Symbol search**: searches definitions and reference/call sites at identifier boundaries, more precise than keyword search; import-aware resolution (ts/js/py/go) resolves references to their definition files, and the call chain excludes false edges to same-named local definitions
- **Call chain**: heuristically traces upward "who called it, and who called the caller" to assess the impact scope of a change
- **Agent tools**: once the index is ready, the chat/Review agent can call `symbol_search` and `call_chain`
- **Review repository context**: injects "which symbols the changed files define, and who outside the Diff calls them" into the model prompt
- **Index management**: each branch / commit index is stored separately (a registry records ref, branch name, file count, size, symbol count); they can be loaded, deleted individually, or all cleared; when the retention count is exceeded the oldest are cleaned up automatically; site storage usage and quota are displayed
- **Stale protection**: a clear warning when a loaded index does not match the current head, and stale symbol context is never injected into the Review prompt
- **Cache reuse**: the same head ref restores the local index directly, with zero network overhead; file count / per-copy size / retention count are configurable
- **Full-file scan**: run deterministic rules over indexed files (aligned with `ocr scan`); scan-mode results cannot be published as line-level comments

### 🐞 Debug Tools (enabled in settings)
- **Off by default**: turn on in "Settings → Debug → Show debug tab"; the settings tab shows a red dot when there are error logs
- **Four-panel debugger**: logs / network / prompts / state, with keyword filtering, level filtering, and auto-scroll
- **Network panel**: method, status code, duration, and byte count for GitLab API, model calls, MCP, and index requests
- **Prompts panel**: the full system prompt, message contents, tool list, token usage, and response summary for each model call
- **console mirroring**: the page's `console.warn/error` automatically enter the logs; logs persist across refreshes
- **One-click export**: copy and download a JSON debug bundle (with a redacted settings snapshot), convenient for filing issues

### 🛠 Self-hosted Compatibility
- **Capability detection**: automatic detection of auth mode, API version, search, CSRF, DOM availability
- **DOM fallback**: parse the Diff from the page DOM when the API is unavailable
- **Diagnostics panel**: real-time display of GitLab instance status and compatibility warnings
- **Config export**: redacted export of site configuration to the clipboard
- **Log redaction**: automatically filters sensitive information such as Bearer tokens, API keys, PATs

### ⚡ Performance
- **Parallel loading**: paginated Diff requests run concurrently (3-way concurrency), full file reads run concurrently (5-way concurrency)
- **Batched rendering**: the Finding list loads in batches (30 items per batch)
- **Lightweight artifact**: the runtime only depends on React + lucide; the userscript is about 1.16 MB (255 KB gzipped), and Shadow DOM isolation keeps GitLab styles unpolluted
- **Large MR support**: 500 files / 20k lines without blocking the GitLab page

### 🔒 Security
- **Secret obfuscation at rest**: API Keys / GitLab PATs are stored after XOR + base64 obfuscation, never exposed in plaintext
- **Draft first**: all comments are drafts by default and are written to GitLab only after user confirmation
- **Token usage statistics**: automatically parses the `usage` in API responses, showing usage and cost estimates per model

### 💬 Interaction Experience
- **Markdown rendering**: code blocks, tables, blockquotes, ordered/unordered lists, inline code, links — XSS-safe
- **Chat persistence**: conversation history is saved automatically and restored after refresh
- **Keyboard shortcuts**: `Esc` closes dialogs, `Ctrl+Enter` starts a Review, `Ctrl+K` switches tabs
- **Offline detection**: shows a status notice when the network is disconnected
- **Multilingual prompts**: automatically switches between Chinese/English system prompts according to settings
- **Review session history**: view the list of past Review sessions

## Installation

**One-click install (recommended)**: after installing [Tampermonkey](https://www.tampermonkey.net/), just open
[review-agent-glab-monkey-script.user.js](https://github.com/mizuka-wu/review-agent-glab-monkey-script/releases/latest/download/review-agent-glab-monkey-script.user.js)
(a GitHub Release asset), and Tampermonkey will pop up the installation page to confirm the install.

- **Auto update**: the script's built-in `@updateURL` points to the Release `.meta.js`; Tampermonkey checks against `@version` and prompts for updates; releases are triggered by `v*` tags and the Release workflow uploads the assets automatically.
- **Edge channel**: GitHub Pages publishes the same artifact after every main build, suitable for following the latest development version:
  `https://mizuka-wu.github.io/review-agent-glab-monkey-script/review-agent-glab-monkey-script.user.js`
- **Self build**: run `pnpm build` and install `dist/review-agent-glab-monkey-script.user.js`; see below for dev mode.
- The script's `@match` covers all http(s) pages (to support any self-hosted GitLab domain), but the UI only mounts when a GitLab page is recognized.

After installation, open any GitLab MR / Diff / File page and click the floating button in the bottom-right corner to open Review Agent.

Rule checks, select-to-locate, Finding editing, and comment draft copying all work directly without an API key;
after filling in an OpenAI-compatible Base URL / model / API Key in "Settings", AI review and chat are layered on top.

## Development

```bash
# Install dependencies
pnpm install

# Dev mode (auto build + hot reload)
pnpm dev
# Install the dev version in Tampermonkey (note the /dist/ path; the root .user.js path 404s):
#   http://127.0.0.1:5173/dist/review-agent-glab-monkey-script.user.js
# After that, code changes rebuild automatically and Tampermonkey auto-updates

# Type check
pnpm typecheck

# Unit tests
pnpm test:unit

# E2E tests
pnpm test:e2e

# Build the release userscript
pnpm build

# Evaluation benchmark
EVAL_VERBOSE=1 npx vitest run tests/eval/
```

## Local GitLab Testing

```bash
# Start the GitLab container (interactive menu)
./scripts/gitlab.sh

# Open http://127.0.0.1:8929 in a browser, log in and create an MR
# Then run E2E:
GITLAB_URL=http://127.0.0.1:8929 \
GITLAB_MR_URL=http://127.0.0.1:8929/<项目>/-/merge_requests/<id>/diffs \
pnpm test:e2e

# Hybrid Review layered on a real local model (with login credentials specified):
GITLAB_URL=http://127.0.0.1:8929 \
GITLAB_MR_URL=http://127.0.0.1:8929/<项目>/-/merge_requests/<id>/diffs \
GITLAB_USER=root GITLAB_PASS=<password> \
MODEL_BASE_URL=http://localhost:8000/v1 MODEL_NAME=qwen35-a3b \
pnpm test:e2e
```

## Configuration

Configure in the sidebar "Settings":

| Setting | Description |
|--------|------|
| **Model provider** | OpenAI / Anthropic / Gemini; selecting one auto-fills the default URL and model |
| **Base URL** | Model API address; supports self-hosted/enterprise gateways |
| **API Key** | Model secret key (obfuscated at rest, never stored in plaintext) |
| **Auth mode** | Bearer / API Key Header / Query Param / Custom Header |
| **GitLab PAT** | Optional, used for cross-origin API access |
| **Review intensity** | fast / balanced / thorough |
| **Output language** | Simplified Chinese / English |
| **Rule pack** | Built-in rules + custom rule pack management (import/export/enable/disable); scope can switch between public / current project |
| **MCP** | Connect to local MCP servers (Streamable HTTP) |
| **Review mode** | `Rules + AI` / `Rules only` / `AI only`; automatically rules-only when no model is configured |
| **Reasoning output** | When off, sends `enable_thinking=false` to omlx/vLLM to keep reasoning text from mixing into results |
| **Debug tab** | Off by default; when enabled shows the four panes logs / network / prompts / state |
| **Repository index** | Enable OPFS indexing plus the file count / per-copy size / retention count limits |
| **Repository context** | When the index matches head, inject call sites outside the Diff into the Review prompt |

## Tools & Capability Matrix

| Capability | Direct from browser | Requires configuration |
|------|-----------|---------|
| Select-to-ask | ✅ | Model API |
| Selection Review | ✅ | Model API |
| Full MR Review | ✅ | Model API |
| Commit Review | ✅ | Model API |
| Rule-based Review | ✅ | None |
| Finding publishing | ✅ | GitLab same-origin/PAT |
| Agent tool loop | ✅ | Model API |
| MCP tool extensions | ✅ | MCP server |
| Full file context | ✅ | Model API |
| Cross-file relocation | ✅ | Model API |
| Capability detection/diagnostics | ✅ | None |
| Token cost statistics | ✅ | Model API |
| Symbol search / call chain | ✅ | None (index must be built first) |
| Repository context injected into Review | ✅ | Model API + index |

## Architecture

```
GitLab Page (MR / Diff / File / Commit)
  ↓ DOM + URL + Selection
Userscript Host (Shadow DOM · SPA routing · sidebar)
  ↓
GitLab Adapter ─── Context Builder ─── Review UI
  ↓                   ↓                    ↓
Model Runtime (OpenAI / Anthropic / Gemini)
  ↓
Agent Tool Loop (file_read / search_code / git_log) + MCP
  ↓
Repo Index (OPFS · opfs-worker) → symbol_search / call_chain → Review context
  ↓
Debug Bus (logs / network / prompts / state · enabled in settings)
  ↓
Finding Pipeline (normalize → anchor → harden → dedupe → filter)
  ↓
Draft → User Confirm → GitLab Discussion Publish
```

## Documentation

Read online (VitePress site, hosted on GitHub Pages): <https://mizuka-wu.github.io/review-agent-glab-monkey-script/>

1. [Product requirements & scope](docs/product-brief.md)
2. [Capability boundary](docs/capability-boundary.md)
3. [System architecture](docs/architecture.md)
4. [UX flows](docs/ux-flows-and-prototype.md)
5. [GitLab integration](docs/gitlab-integration.md)
6. [Agent Gateway contract](docs/agent-gateway-contract.md) (planned, not implemented)
7. [Security & privacy](docs/security-privacy.md)

Plans and backlog (MCP local relay bridge, remaining gaps vs OpenCodeReview, acceptance baselines) are in [TODO.md](TODO.md).

## Testing

- **229 unit tests**: rule engine, anchoring, hardening, providers, agent loop, MCP, capability detection, Markdown, secure storage, cost statistics, repository index/symbol table, debug bus
- **17 Playwright E2E**: 13 mock-mode tests (rule Review publishing, keyless rule Review, selection chat, repository index + symbol search, quick actions, streaming output, stopping mid-run, model failure banner, model auto-switch, select-to-ask hidden inside the panel, per-project supplementary prompts, session replay, metadata) + 4 real GitLab mode tests (reading an injected MR, rule Review, hybrid Review with a real local model, repository index/symbol/registry management); real mode requires `GITLAB_URL` + `GITLAB_MR_URL`, with optional `MODEL_BASE_URL` / `MODEL_NAME` / `GITLAB_USER` / `GITLAB_PASS`
- **8 evaluation fixtures**: security / debug logs / weak typing / missing tests / clean code / multi-file / performance / secret leaks
- **Merge gate**: `pnpm typecheck` + `pnpm test:unit` + `pnpm test:e2e` + `pnpm build`

## License

[MIT](LICENSE)
