# Changelog

## Unreleased

- Align with OpenCodeReview's hybrid architecture: deterministic rule stage always runs (offline, zero tokens); model stage is optional and degrades gracefully to rule results on failure (`reviewMode`: hybrid / rules / ai).
- Expand built-in rule pack from 5 to 24 multi-language rules (secrets, credentials in URLs, SQL injection, XSS, command injection, disabled TLS verification, weak hashing, predictable randomness, static mutable shared state, Java `equals` on literals, Kotlin `!!`, TS non-null assertion, weak types, swallowed promises, bare except, discarded Go errors, blocking sleep, skipped tests, debug output, hardcoded internal endpoints, TODO, conflict markers, missing tests) with language scoping, glob scope, comment-line skipping and per-file hit caps.
- Add cross-source corroboration: rule and model hits on the same line/category merge into one finding tagged `规则 + AI` with higher severity and high confidence.
- Surface finding provenance: `source` / `corroborated` / `ruleId` / `rulePackId` badges, source grouping, source filter and counts, rule id shown on the card so noisy rules can be disabled from settings.
- Add unconfigured-model guidance: persistent dismissible banner, capability card in settings, FAB badge, and actionable refusals in chat/review paths; rule review, locate, edit and copy all work without an API key.
- Effort budget now only filters AI findings; deterministic findings are never dropped by confidence thresholds.
- Rebuild the panel UI: 结果 / 对话 / 设置 / 调试 tabs, draggable + resizable panel, collapsible finding cards with code preview, batch publish bar, session resume and history, per-rule toggles.
- Replace the assistant-ui chat with a self-contained streaming chat (markdown, attachments, tool trace) and drop tailwind/assistant-ui/ai-sdk runtime dependencies; userscript bundle 2.5 MB → 0.9 MB.
- Fix markdown rendering (ordered lists, tables, blockquotes, safe URLs) and preserve multi-line comments through finding normalization.
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
