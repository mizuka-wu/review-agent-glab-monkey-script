# Changelog

## 0.2.0 — 2026-10-01
- Model picker is now a typeable input with datalist suggestions (no more 下拉/手动 split); when the fetched server list does not contain the current model (e.g. switching from the OpenAI preset to a local server still holding `gpt-4o-mini`), it auto-switches to the first available model and persists immediately; a compact picker also appears atop the chat tab.
- Rule packs now live as language docs: `rule_docs/*.md` (frontmatter + pattern fence + examples) are the source of truth; `scripts/generate-rules.mjs` emits `builtin-rules.generated.ts` and `--check` guards drift in CI. Migration verified lossless by unit tests and the eval benchmark.
- Expand the eval benchmark from 8 to 31 fixtures (one annotated sample per built-in rule plus a clean negative).
- Symbol precision stage one: import-aware resolution (ts/js/python/go) records `resolvedPath` on refs and call chains drop same-name local-definition false edges.
- Close more OpenCodeReview gaps: directory-cohesive file bundling with concurrent per-bundle sub-reviews (partial-failure tolerant), a reflection pass where the model self-checks its own findings (keep/drop, skipped on fast effort), full-file rule scan over the cached repo index (ocr-scan parity, unpublishable results), one-click findings JSON export and a Delegation context export (file selection + resolved rules + diff + background + output schema) for external agents.
- Slim `docs/` to design documents only (numeric prefixes dropped); move plans and backlog (MCP bridge plan, OpenCodeReview gaps, acceptance baselines, open items) into root `TODO.md`; docs site sidebar/README links updated accordingly.
- Add `docs/11-mcp-bridge-and-agent-surface-plan.md`: a development plan for an optional local MCP relay bridge (stdio/Streamable HTTP to MCP hosts, outbound WS/long-poll to the userscript) exposing an MCP-isomorphic tool surface — review state/control, rule-pack read-write per scope, requirement/tech-doc context attachment, and cross-project GitLab context — plus in-page RPC so same-page extensions can call the same surface without any process.
- Codex-style streamed review presentation: the model thinking channel (`reasoning_content`) renders as a collapsed-by-default typewriter pane with a live character count, completed findings stream into the results list incrementally via a partial-JSON extractor, and the raw JSON draft is hidden behind an explicit 「查看原始输出」 toggle; thinking tokens are captured separately from content so `json_object` output stays clean.
- Stream the review model stage over SSE: the running banner shows the model's live output draft so it is obvious the AI is working, and 「取消」 aborts the stream mid-flight; servers that ignore `stream` or omit SSE fall back to a single read with one whole-text callback; stream chunks' `usage` (when sent) is now recorded. Rule-stage findings render immediately via a stage callback instead of waiting for the model.
- Add quick actions in the results footer: 一键 Approve (`POST .../approve`), 一键行内评论 (publish all publishable drafts as line discussions in one click) and 总评论 (one MR-level summary note with counts and a per-finding list); all use a two-step confirm button to prevent mis-clicks.
- Clarify cancel semantics: cancelling stops the model analysis, keeps already-completed rule findings, and shows a 「已取消」 banner explaining that rule results remain publishable.
- Remove the dead `plan()` runtime method and `review-plan.ts` (the unwired plan stage).
- Replace the inline oMLX preset with a Base URL 「?」hint listing omlx / Ollama / LM Studio default ports and their `/v1`-suffixed OpenAI-compatible addresses (click to fill); localhost endpoints still auto-fetch `/v1/models`.
- Add rule-pack scopes: packs are stored per scope (public, or per GitLab project path) under separate storage keys and loaded dynamically per project; project custom packs override same-id public packs while built-in rule toggles stay public.
- Fix the `typecheck` gate: `tsc --noEmit` against the solution-style `tsconfig.json` (`files: []`) type-checked nothing; switch to `tsc -b` so the app and node projects are actually checked.
- Remove dead code: unused `buildSelectionContext`, `isSelectionInsideHost`, and the unwired review-plan `planUserPrompt` / `parseReviewPlan` path.

- Align with OpenCodeReview's hybrid architecture: deterministic rule stage always runs (offline, zero tokens); model stage is optional and degrades gracefully to rule results on failure (`reviewMode`: hybrid / rules / ai).
- Expand built-in rule pack from 5 to 24 multi-language rules (secrets, credentials in URLs, SQL injection, XSS, command injection, disabled TLS verification, weak hashing, predictable randomness, static mutable shared state, Java `equals` on literals, Kotlin `!!`, TS non-null assertion, weak types, swallowed promises, bare except, discarded Go errors, blocking sleep, skipped tests, debug output, hardcoded internal endpoints, TODO, conflict markers, missing tests) with language scoping, glob scope, comment-line skipping and per-file hit caps.
- Add cross-source corroboration: rule and model hits on the same line/category merge into one finding tagged `规则 + AI` with higher severity and high confidence.
- Surface finding provenance: `source` / `corroborated` / `ruleId` / `rulePackId` badges, source grouping, source filter and counts, rule id shown on the card so noisy rules can be disabled from settings.
- Add unconfigured-model guidance: persistent dismissible banner, capability card in settings, FAB badge, and actionable refusals in chat/review paths; rule review, locate, edit and copy all work without an API key.
- Effort budget now only filters AI findings; deterministic findings are never dropped by confidence thresholds.
- Rebuild the panel UI: 结果 / 对话 / 设置 / 调试 tabs, draggable + resizable panel, collapsible finding cards with code preview, batch publish bar, session resume and history, per-rule toggles.
- Replace the assistant-ui chat with a self-contained streaming chat (markdown, attachments, tool trace) and drop tailwind/assistant-ui/ai-sdk runtime dependencies; userscript bundle 2.5 MB → 0.9 MB at the strip (current ~1.16 MB / gzip ~255 KB including the repo index and debugger).
- Fix markdown rendering (ordered lists, tables, blockquotes, safe URLs) and preserve multi-line comments through finding normalization.
- Add a local repository index (opfs-worker OPFS cache with worker → main-thread → memory fallback): symbol search, heuristic call chains, `symbol_search` / `call_chain` agent tools, and "callers outside the diff" context injected into review prompts; same-ref caches restore without network.
- Add an index manager: per-ref namespaces with a registry (ref / branch label / project / files / bytes / symbols), load + per-index delete + clear-all in the 索引 tab, `maxIndexes` pruning of the oldest entries, site storage usage/quota display, and a stale-index warning that also blocks repo context injection into review prompts.
- Gate the debug tab behind 设置 → 调试 → 显示调试标签页 (default off); settings tab shows a dot when error logs exist.
- Add a 本地 oMLX :8000 quick preset in model settings with automatic /v1/models fetch for localhost endpoints, plus a 关闭思考输出 toggle that sends `chat_template_kwargs.enable_thinking=false` for omlx/vLLM-style servers.
- Harden `parseModelFindings` with candidate-based JSON extraction so leaked reasoning text can no longer break review parsing.
- Add a real-model E2E (env `MODEL_BASE_URL` / `MODEL_NAME`, defaults to local omlx on :8000) that runs a hybrid review against a live GitLab and asserts the AI stage, network and prompt records.
- Make the real-model E2E wait for true review completion (the running `Review 中` button disappearing) instead of matching the in-progress `0 个问题` counter, and prove the live model call through debug network/prompt records rather than asserting a non-deterministic AI finding count.
- Add a four-pane debugger (logs / network / prompts / state) backed by a framework-agnostic debug bus: every GitLab API, model, MCP and index request is recorded with status/latency/bytes; every model call records full system + messages, tools and token usage; console.warn/error are mirrored; logs survive reloads; one-click JSON debug bundle export with redacted settings.
- Route model and MCP requests through GM.xmlHttpRequest to survive gitlab.com's `connect-src 'self'` CSP, with streaming fetch and automatic fallback.
- Add `docs/10-opencodereview-gap-analysis.md` comparing this project with alibaba/open-code-review.

- Add review hardening (M5): evidence sufficiency check, severity calibration, similar finding merge, effort-based budget filtering.
- Add self-deployment compatibility (M3): capability probe, DOM diff fallback, config export, log sanitization, diagnostics panel.
- Add MCP integration: connect to local MCP servers via Streamable HTTP transport (GM.xmlHttpRequest). Extends agent tools with MCP-provided tools.
- Add composite tool executor that dispatches between GitLab API tools and MCP tools.
- Add Agent tool loop: model can call GitLab API tools (file_read, search_code, git_log) during chat for deeper codebase context.
- Add unified `callWithTools` API across OpenAI, Anthropic, and Gemini runtimes with provider-specific tool call formats.
- Add tool call event display in chat UI showing real-time tool execution progress.
- Add multi-provider support: OpenAI-compatible, Anthropic, and Google Gemini with provider-specific runtimes and factory pattern.
- Add provider selector tabs in settings with auto-fill defaults (base URL, model, API key placeholder).
- Add configurable rule pack management: structured RulePack schema with regex pattern matching, glob-based file path scoping (include/exclude), versioning, and built-in rule migration.
- Add rule pack UI in settings: list, toggle, edit, create, delete, import (JSON paste), and export (clipboard) rule packs.
- Add per-rule and per-pack enable/disable toggles.
- Add rule pack persistence via GM storage / localStorage.
- Add comprehensive unit tests for rule pack evaluation, validation, import/export, storage, and multi-provider runtimes.

## 0.1.0

- Add the product plan, architecture, capability boundary, GitLab API, Gateway contract, security, and test documents.
- Add an interactive GitLab review prototype with selection actions, chat, staged review, structured findings, and publish confirmation.
- Add GitHub Actions for continuous build, release packaging, and GitHub Pages publishing.
- Add GitLab-oriented userscript metadata for GitLab.com and local development sites.
