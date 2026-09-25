# Changelog

## Unreleased

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
