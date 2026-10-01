[简体中文](../architecture.md) | **English**

# System Architecture and Data Models

## 1. Architecture Goals

- Page adaptation, GitLab data access, model invocation, and UI state are decoupled from one another.
- Deterministic modules handle anchoring, filtering, budgeting, deduplication, and publishing; the Agent only handles understanding and judgment.
- All write operations are previewable, confirmable, and traceable.
- Pure browser-side implementation, with no server or local process required.

## 2. Layered Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│ GitLab pages                                                 │
│  MR / Diff / File / Commit / Self-hosted GitLab-like         │
└───────────────────────────┬──────────────────────────────────┘
                            │ DOM + URL + Selection
┌───────────────────────────▼──────────────────────────────────┐
│ Userscript Host                                              │
│  Shadow DOM · routes · selection toolbar · side panel         │
│  settings · diagnostics · user confirmation                  │
└───────┬─────────────────────┬───────────────────┬────────────┘
        │                     │                   │
┌───────▼────────┐   ┌────────▼─────────┐  ┌──────▼──────────┐
│ GitLab Adapter │   │ Context Builder  │  │ Review UI       │
│ REST           │   │ diff · scope     │  │ Chat · Findings │
│ auth · position│   │ budget · redact  │  │ publish preview │
└───────┬────────┘   └────────┬─────────┘  └─────────────────┘
        │                     │
┌───────▼─────────────────────▼────────────────────────────────┐
│ Runtime Abstraction                                          │
│  OpenAIRuntime · AnthropicRuntime · GeminiRuntime            │
│  chat / review / tools / streaming                           │
└───────┬──────────────────────────────────────────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────┐
│ Agent Tool Loop                                              │
│  file_read · search_code · git_log · MCP tools               │
│  CompositeToolExecutor · cancel · retry                      │
└──────────────────────────────────────────────────────────────┘
```

## 3. Module Breakdown

### 3.1 Userscript Host

Responsibilities:

- Injects a Shadow DOM to keep GitLab CSS and the script's CSS from polluting each other.
- Listens to SPA routes and identifies the current page type.
- Captures selections, file positions, and code context.
- Manages the sidebar, floating toolbar, chat, Review, settings, and diagnostics.
- Calls GitLab write endpoints after the user confirms.

Not responsible for: model prompt strategy, repository tool execution, complex rule matching.

### 3.2 Platform Adapters

`GitLabAdapter` is a stable interface; the concrete implementation is selected through capability detection:

- `GitLabRestAdapter`: the primary path for GitLab CE / EE.
- `GitLabGraphqlAdapter`: supplements large lists, pagination, or reduces the number of requests.
- `DomFallbackAdapter`: reads current page content when API access is unavailable.
- `UnsupportedAdapter`: only shows diagnostics and manual copy capabilities.

Interface sketch:

```ts
interface GitLabAdapter {
  probe(): Promise<AdapterCapabilities>;
  getMergeRequest(ref: MergeRequestRef): Promise<MergeRequestContext>;
  listDiffs(ref: MergeRequestRef, page: number): Promise<DiffPage>;
  getFile(path: string, ref: string): Promise<FileContent>;
  listDiscussions(ref: MergeRequestRef): Promise<Discussion[]>;
  createDiscussion(input: DiscussionDraft): Promise<Discussion>;
}
```

### 3.3 Context Builder

Takes PageContext, MR, Diff, and the user's selection as input, and outputs a ReviewContext ready to be sent.

Deterministic steps:

1. File filtering: skip lockfiles, binaries, and oversized generated files.
2. File grouping: files in the same directory, sharing the same stem, translation files, and test vs. implementation files can be grouped into packs.
3. Diff trimming: keep hunks, context lines, and the selected range.
4. Budget control: trim against per-file / overall / output token limits and record what was omitted.
5. Redaction: hide tokens, keys, and personal information according to rules.
6. Context indexing: generate a stable ID for each evidence block.

### 3.4 Runtime Abstraction

The browser side depends only on a single unified protocol:

```ts
interface ReviewRuntime {
  capabilities(): Promise<RuntimeCapabilities>;
  chat(request: ChatRequest): AsyncIterable<AgentEvent>;
  review(request: ReviewRequest): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}
```

- `DirectModelRuntime`: implements a restricted subset of OpenAI-compatible chat / tool calls.
- `AgentGatewayRuntime`: implements full streaming tasks, tools, context extension, and cancellation.

### 3.5 Finding Pipeline

The model cannot publish comments directly. All output passes through:

```text
Raw model output
  → schema validation
  → normalize category / severity
  → evidence validation
  → deterministic line anchoring
  → confidence filtering
  → deduplication
  → content reflection
  → FindingDraft
  → user review
  → GitLab Discussion
```

## 4. Core Data Models

### 4.1 PageContext

```ts
interface PageContext {
  origin: string;
  route: 'merge-request' | 'diff' | 'file' | 'commit' | 'unknown';
  projectPath: string;
  projectNumericId?: number;
  mergeRequestIid?: number;
  filePath?: string;
  commitSha?: string;
  sourceBranch?: string;
  targetBranch?: string;
}
```

### 4.2 CodeSelection

```ts
interface CodeSelection {
  filePath: string;
  side: 'old' | 'new' | 'unified';
  startLine: number;
  endLine: number;
  text: string;
  hunkId?: string;
}
```

### 4.3 ReviewRequest

```ts
interface ReviewRequest {
  mode: 'selection' | 'hunk' | 'file' | 'merge-request';
  mergeRequest?: MergeRequestRef;
  selection?: CodeSelection;
  filePaths: string[];
  background?: string;
  ruleSetIds: string[];
  effort: 'fast' | 'balanced' | 'thorough';
  language: 'zh-CN' | 'en-US';
}
```

### 4.4 Finding

```ts
interface ReviewFinding {
  id: string;
  fingerprint: string;
  path: string;
  startLine: number;
  endLine: number;
  side: 'old' | 'new';
  category: 'bug' | 'security' | 'performance' | 'maintainability'
    | 'test' | 'style' | 'documentation' | 'other';
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  title: string;
  content: string;
  evidence: EvidenceRef[];
  existingCode?: string;
  suggestionCode?: string;
  ruleId?: string;
  source: 'model' | 'rule' | 'tool';
  status: 'draft' | 'accepted' | 'ignored' | 'published' | 'failed';
}
```

The fingerprint should be a hash of the following stable fields:

```text
host + project + relative path + normalized existingCode + category + normalized title
```

Do not use the model session ID, run time, or full natural-language text as a fingerprint.

### 4.5 AgentEvent

```ts
type AgentEvent =
  | { type: 'run.created'; runId: string }
  | { type: 'stage.changed'; stage: string; message: string }
  | { type: 'context.added'; contextId: string; label: string }
  | { type: 'tool.started'; callId: string; tool: string; input: unknown }
  | { type: 'tool.completed'; callId: string; outputPreview: string }
  | { type: 'text.delta'; text: string }
  | { type: 'finding.created'; finding: ReviewFinding }
  | { type: 'warning'; code: string; message: string }
  | { type: 'run.completed'; summary: ReviewSummary }
  | { type: 'run.failed'; code: string; message: string };
```

## 5. Key Flows

### 5.1 Select-to-Ask

```text
User selects code
  → SelectionController captures the DOM Range
  → restore path + line from the closest diff row / file route
  → show the SelectionToolbar
  → click "Ask"
  → open the Chatbox and attach the CodeSelection
  → user sends the question
  → Runtime.chat()
  → render Markdown as a stream
```

Failure fallback: when line numbers cannot be restored, the question can still be asked with the text attached, but the "precise location" capability is not offered.

### 5.2 Review

```text
Click Review
  → validate runtime + platform capabilities
  → Context Builder creates the ReviewRequest
  → run deterministic preprocessing
  → Runtime.review()
  → consume AgentEvent
  → Finding Pipeline processes the results
  → display by severity / confidence
```

State machine:

```text
idle → preparing → running → normalizing → completed
                         ↘ cancelled
                         ↘ failed
```

- `cancelled` keeps intermediate results that already completed, but they cannot enter the publishing queue.
- `failed` must show the failed stage, the budget consumed, and the retryable scope.

### 5.3 Publishing Comments

```text
Finding is expanded
  → user edits the comment draft
  → click "Publish to GitLab"
  → preview path + line + body
  → confirm again
  → re-validate diff_refs and the file version
  → POST discussions
  → on success the status becomes published and the discussion id is saved
```

If GitLab returns a position that cannot be resolved:

- Do not guess line numbers.
- Show the reason as `line_out_of_diff` or `stale_diff_refs`.
- Allow copying it as a plain MR-level comment for the user to paste manually or confirm for publishing.

## 6. State Management

Recommended Zustand stores, split by domain:

- `platformStore`: PageContext, AdapterCapabilities, diagnostics.
- `runtimeStore`: current mode, connection status, capabilities, model.
- `chatStore`: sessions, context attachments, streaming messages.
- `reviewStore`: runs, stages, tool traces, Findings, filters.
- `settingsStore`: non-sensitive configuration; sensitive configuration uses a separate secure channel.

Persistence boundaries:

- May be persisted: site adaptation preferences, UI state, rule toggles, anonymized Finding metadata.
- Persist with care: model base URL, site list, project mappings.
- Not persisted by default: API keys, PATs, full source code, model chains of thought.

## 7. Error Model

```ts
interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  stage?: string;
  cause?: unknown;
  remediation?: string;
}
```

Errors are classified by domain:

- `platform.*`: DOM recognition, API authorization, site compatibility.
- `runtime.*`: model connection, Gateway, streaming protocol, cancellation.
- `context.*`: missing diffs, oversized files, budget exceeded.
- `finding.*`: schema, anchoring, deduplication, reflection failures.
- `publish.*`: permissions, diff version, rate limiting, conflicts.

## 8. Performance Design

- Large diff JSON parsing and hunk marking run in a Web Worker.
- DOM queries use caching and MutationObserver to avoid full-page polling.
- Long sidebar lists are virtualized; expanded Finding content is rendered on demand.
- Streaming text is batched into frames to avoid layout thrash on every delta.
- Context building estimates tokens first and fetches files afterward, to avoid wasted requests.
- Gateway task caches are keyed by `repository revision + request + rule version`.

## 9. Technology Choices

| Domain | Choice | Rationale |
| --- | --- | --- |
| Build | Vite + TypeScript | Already used in this project; mature for building userscripts |
| UI | React 19 | Well suited to complex state and streaming UIs |
| Userscript build | vite-plugin-monkey | Already used in this project; supports metadata and GM APIs |
| Styling | Tailwind CSS 4 + Shadow DOM scope | Fast iteration; the Shadow DOM build output still needs verification |
| State | Zustand | Lightweight; domain stores are easy to split |
| Icons | lucide-react | Consistent toolbar and status icons |
| Markdown | react-markdown + remark-gfm | Rendering answers and comment drafts |
| Model protocol | Internal Runtime abstraction | Keeps the UI from depending directly on any provider SDK |

`@assistant-ui/*` and Tailwind were removed during the hybrid review refactor: the Chatbox became a self-contained implementation (`components/ChatThread.tsx`), with styling handled uniformly by the `components/ui/modern.tsx` design system and `index.css`, avoiding two coexisting abstractions and shrinking the bundle from 2.5 MB to 0.9 MB (currently about 1.16 MB / 255 KB gzipped after adding the repository index and debugger).

## 10. Architecture Decision Summary

1. The GitLab API takes precedence over the DOM; the DOM is only an entry point and a fallback.
2. The Gateway holds no GitLab write permissions.
3. Finding and GitLab Discussion are two separate models; a mapping and user confirmation must sit between them.
4. Direct model connections and the Gateway use the same event stream.
5. Anchoring failures must fail explicitly; automatically guessing line numbers is not allowed.
