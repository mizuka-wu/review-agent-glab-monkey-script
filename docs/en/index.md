---
layout: home

hero:
  name: Review Agent for GitLab
  text: Rule-first × model-augmented MR review userscript
  tagline: Works with no API key; configure a model to layer on AI review, streaming reasoning, symbol search, and call chains
  actions:
    - theme: brand
      text: One-click install (Release)
      link: https://github.com/mizuka-wu/review-agent-glab-monkey-script/releases/latest/download/review-agent-glab-monkey-script.user.js
    - theme: alt
      text: System Architecture
      link: /architecture
    - theme: alt
      text: GitHub
      link: https://github.com/mizuka-wu/review-agent-glab-monkey-script

features:
  - title: Rule-first · works without a key
    details: 24 built-in deterministic rules run locally in the browser at zero token cost; with no model configured, Review, locating, editing, and copying drafts all remain available.
  - title: Streaming review · collapsed reasoning
    details: The model stage streams over SSE — the reasoning channel is a collapsed typewriter, Findings stream into the result list one by one, and you can stop at any time; rule results render first.
  - title: Local symbol index
    details: OPFS caches repository files and builds a symbol table, providing the symbol_search / call_chain tools and "call sites outside the Diff" context, with multiple indexes managed per branch.
  - title: Publish only after human confirmation
    details: All comments are drafts by default; line-level Discussions can be published individually or in batches, with one-click Approve and whole-MR comments, all protected by two-step confirmation to prevent misfires.
---

[简体中文](../index.md) | **English**
