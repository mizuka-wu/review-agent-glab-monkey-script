# Changelog

## Unreleased

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
