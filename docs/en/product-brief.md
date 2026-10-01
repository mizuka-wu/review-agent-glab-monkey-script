[简体中文](../product-brief.md) | **English**

# Product Requirements and Scope

## 1. Background

When developers review code in a GitLab Merge Request (MR), they often have to leave the page to consult a model and then manually copy the conclusions back. Existing AI review tools mostly exist as CLIs, CI bots, or IDE plugins, leaving a gap for a lightweight entry point embedded directly in the GitLab page that supports both select-to-ask and launching a review.

This project uses a userscript as the frontend carrier, aiming to add a Review Agent sidebar without taking over the GitLab UI.

## 2. Target Users

- Developers who do routine MR reviews on GitLab.com or self-hosted GitLab.
- Reviewers who need to quickly explain unfamiliar code, check risks, and produce comment drafts.
- Technical teams that want the model to access local repository context but do not want to hand their GitLab token and source code to a third-party service.
- Platform / engineering efficiency teams that need standardized reviews according to team rules.

## 3. Product Goals

### G1. Complete the "select → ask / review → verify → comment" loop in the page

- A compact floating action bar appears after selecting text.
- Questions and reviews automatically carry context such as the code snippet, file, MR, and Diff Ref.
- Generated content can be located back to the code lines and converted into a GitLab comment draft.

### G2. Support both shallow and deep reviews

- Browser mode covers the context visible on the current page plus MR data obtainable from the GitLab API.
- The Agent tool loop can proactively read repository files, search code, and inspect commit history.
- The UI must clearly show where the current capabilities come from and must never pretend to have local context.

### G3. Controllable, explainable, low noise

- Findings use a fixed structure: location, category, severity, evidence, suggestion, confidence.
- By default only higher-confidence issues are shown; low-confidence results are collapsed or summarized.
- Publishing a comment must be confirmed by the user, with per-item ignore, edit, and copy supported.

### G4. Compatible with GitLab and self-hosted sites

- Common GitLab CE / EE versions are supported first.
- "GitLab-like" sites degrade through adapters and capability detection; full compatibility with every derivative product is not promised.
- Page DOM changes must not break the core data pipeline entirely; the GitLab API is the preferred source of truth.

## 4. User Scenarios

### US-1 Select-to-explain

The Reviewer selects a block of concurrent code, clicks "Ask", and asks about a potential race. The Chatbox shows the file, line range, and MR background; the model explains the risk and offers verification suggestions.

### US-2 Select-to-review

The Reviewer selects an input-handling function and clicks "Review this". The Agent generates 0–N Findings for that snippet only and produces an editable comment draft.

### US-3 Whole-MR review

The Reviewer clicks "Start review" on the MR page. The system reads the Diff, the changed files, and the MR description, analyzes them by file group, and finally outputs an issue list sorted by severity.

### US-4 Comment publishing

The Reviewer expands a Finding, checks the evidence and suggestion, and clicks "Publish to GitLab". The system shows the target line and a comment preview; once confirmed, an MR Discussion is created.

### US-5 Deep context

The Agent discovers that an issue involves other files and calls the file_read / search_code tools to fetch context. The tool trace is visible in the UI, and the final Finding cites the actual evidence.

## 5. Feature Scope

### P0 (First usable version)

- GitLab MR URL / project / MR IID parsing.
- Reading the MR description, Diff, Diff Refs, and changed files.
- Select-to-ask floating toolbar, Chatbox, partial review.
- A single OpenAI-compatible streaming model connection.
- Finding structure, comment drafts, copying, and manual publishing.
- Settings, connection diagnostics, and data-sending preview.

### P1 (Full GitLab experience)

- Precise line-level Discussion creation with error fallback.
- Whole-MR review, file groups, budgets, cancel and retry.
- Self-hosted site adapters, capability detection, version-difference handling.
- Session history, Finding states, idempotent fingerprints.

### P2 (Agent capabilities)

- Agent tool loop, MCP extension tools, multi-provider adaptation.
- Repository mirror / checkout, file reading, search, rule packs.
- Tool call traces, context budgets, concurrency and caching.
- Optional restricted command execution, off by default.

### P3 (Team-oriented)

- Team rules, templates, policy routing.
- CI bot, audit logs, SaaS / private deployment options.
- MCP tool integration and multi-agent delegation.

## 6. Non-goals

- No execution of arbitrary local code in the browser.
- No auto-merge, auto-fix, or direct writes to the MR that bypass human confirmation.
- No out-of-the-box guarantee for platforms such as GitLab forks / Gitea / Gogs / Codeup.
- Do not cram a full Git repository, build system, or test runtime into the userscript.
- No uploading of source code, secrets, or the full repository to third-party models by default.

## 7. Success Metrics

| Metric | Target | Notes |
| --- | --- | --- |
| Time from selection to first answer | P50 < 3 s | Excludes network jitter of the model's first token |
| MR page injection stability | > 99% of page loads | Degradation entry points exist for URL / DOM changes |
| Finding locatability rate | > 95% | Mapped to a valid Diff line, or explicitly marked as unlocatable |
| Comment publishing success rate | > 99% | Excludes explainable errors such as insufficient permissions or an outdated Diff version |
| Invalid / duplicate comment rate | < 10% | Based on statistics collected before human confirmation |
| Browser main-thread blocking | No long tasks > 100 ms | Large Diff parsing runs in a Web Worker or is chunked |

## 8. Product Principles

1. **Human in the loop**: write operations are previewable, undoable, and require confirmation by default.
2. **Honest about capabilities**: clearly show where data comes from, whether tools are available, and why a result degraded.
3. **Determinism first**: locating, filtering, budgets, and deduplication are done in code; the model only makes judgments.
4. **Minimal context**: send the Diff and necessary context first, and extend with tools on demand.
5. **Site adaptation isolation**: page parsing, API access, and rendering are decoupled from each other.

## 9. Open Questions

- ~~Should the primary model integration be a local Gateway, or a direct browser connection to an OpenAI-compatible API?~~ Decided: direct browser connection.
- Do we need to support self-hosted GitLab instances that can only authenticate through a web session and prohibit PATs?
- Does phase one need to publish GitLab Discussions, or is copying comment drafts enough?
- Does the team have unified review rules, severity definitions, and disabled checks?
- What are the target browsers, and the minimum Tampermonkey / Violentmonkey versions?
