[简体中文](../agent-gateway-contract.md) | **English**

# Local Agent Gateway Protocol Draft

## 1. Goals

The Gateway gives the userscript the model, repository, rule, tool, and long-running task capabilities that a browser cannot implement reliably. The protocol stays transport-agnostic; the MVP uses HTTP + SSE, with WebSocket or MCP possible later.

## 2. Design Principles

- The browser and the Gateway share the same AgentEvent contract.
- By default the Gateway stores no GitLab token and holds no GitLab write permissions.
- Every tool call is observable, cancellable, and budgeted.
- Source code and model keys stay on the local machine by default.
- Tasks are idempotent and resumable, and do not depend on the browser page staying alive.
- The protocol is explicitly versioned; capabilities are detected rather than guessed from version numbers.

## 3. Service Discovery

Default address:

```text
http://127.0.0.1:4317
```

Production implementations must let the user change the port and must bind to loopback. Do not listen on `0.0.0.0` by default.

## 4. Common Response

```json
{
  "ok": true,
  "requestId": "req_01J...",
  "data": {}
}
```

Error:

```json
{
  "ok": false,
  "requestId": "req_01J...",
  "error": {
    "code": "repository.not_mapped",
    "message": "No local repository is mapped to this GitLab project.",
    "retryable": false,
    "remediation": "Open Gateway settings and add a repository mapping."
  }
}
```

## 5. Health and Capabilities

### `GET /v1/health`

```json
{
  "ok": true,
  "data": {
    "service": "review-agent-gateway",
    "protocolVersion": "1.0",
    "gatewayVersion": "0.1.0",
    "uptimeSeconds": 421,
    "providers": [
      { "id": "local-openai", "kind": "openai-compatible", "status": "ready" }
    ]
  }
}
```

### `GET /v1/capabilities`

```json
{
  "ok": true,
  "data": {
    "runtime": ["chat", "review", "cancel", "resume"],
    "tools": ["file_read", "file_search", "symbol_search", "git_history"],
    "providers": ["openai-compatible", "anthropic"],
    "rules": { "custom": true, "versioning": true },
    "commands": { "enabled": false },
    "limits": {
      "maxContextTokens": 200000,
      "maxConcurrentReviews": 2,
      "maxToolCallsPerRun": 60
    }
  }
}
```

## 6. Project Mapping

### `POST /v1/repository-mappings`

```json
{
  "gitlabOrigin": "https://gitlab.example.com",
  "projectPath": "group/subgroup/project",
  "localPath": "/Users/dev/Projects/project",
  "defaultRef": "main"
}
```

Constraints:

- `localPath` must actually exist and be a Git worktree / bare mirror.
- The path is confirmed by the user in the Gateway settings UI; arbitrary path probing from a web page is not accepted.
- Mappings are stored in Gateway configuration and are never returned to the model.

## 7. Chat

### `POST /v1/chat`

Request:

```json
{
  "requestId": "chat_01J...",
  "providerId": "local-openai",
  "model": "qwen3-coder",
  "messages": [
    { "role": "user", "content": "Explain the race in this checkout path." }
  ],
  "context": {
    "kind": "selection",
    "gitlabOrigin": "https://gitlab.example.com",
    "projectPath": "group/project",
    "mergeRequestIid": 123,
    "filePath": "src/checkout.ts",
    "startLine": 38,
    "endLine": 57,
    "text": "..."
  },
  "toolsEnabled": true
}
```

The response is `text/event-stream`:

```text
event: run.created
data: {"runId":"run_01J..."}

event: tool.started
data: {"callId":"call_1","tool":"file_search","input":{"query":"CheckoutService"}}

event: text.delta
data: {"text":"The request and inventory update are not atomic..."}

event: run.completed
data: {"usage":{"inputTokens":8120,"outputTokens":412}}
```

## 8. Review Tasks

### `POST /v1/reviews`

```json
{
  "requestId": "review_01J...",
  "mode": "merge-request",
  "providerId": "local-openai",
  "model": "qwen3-coder",
  "target": {
    "gitlabOrigin": "https://gitlab.example.com",
    "projectPath": "group/project",
    "mergeRequestIid": 123,
    "diffRefs": {
      "baseSha": "...",
      "startSha": "...",
      "headSha": "..."
    }
  },
  "scope": {
    "filePaths": ["src/checkout.ts", "src/inventory.ts"],
    "selection": null
  },
  "policy": {
    "effort": "balanced",
    "language": "zh-CN",
    "ruleSetIds": ["security-default", "team-checkout"],
    "minConfidence": "medium",
    "maxToolCalls": 30,
    "maxOutputTokens": 12000
  }
}
```

### SSE Events

Reuses the `AgentEvent` from [System Architecture](architecture.md); key events:

- `run.created`
- `stage.changed`
- `context.added`
- `tool.started` / `tool.completed`
- `finding.created`
- `warning`
- `run.completed` / `run.failed`

## 9. Cancellation and Resumption

### `POST /v1/runs/:runId/cancel`

```json
{ "reason": "user_cancelled" }
```

### `GET /v1/runs/:runId`

Returns the persisted state, stages, completed Findings, budget, and errors. Supports restoring the UI after a browser refresh.

### `GET /v1/runs/:runId/events?after=<cursor>`

Used to reconnect after a dropped connection. The Gateway keeps event cursors for 24 hours.

## 10. Tool Contract

```ts
interface GatewayTool<Input, Output> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  sideEffect: 'none' | 'read-cache' | 'command';
  execute(input: Input, context: ToolContext): Promise<ToolResult<Output>>;
}
```

MVP tools:

| Tool | Purpose | Default permission |
| --- | --- | --- |
| `file_read` | Read a given line range from the mapped repository | Read-only |
| `file_read_diff` | Read the diff of one or more files | Read-only |
| `file_search` | Search by file name / path | Read-only |
| `code_search` | Literal / regex search | Read-only |
| `symbol_search` | Search definitions and references via a language index | Read-only |
| `git_history` | View commits, blame, historical changes | Read-only |
| `run_check` | Run check commands from an allowlist | Disabled by default |

### Tool Event Redaction

- `input` shows only paths, line ranges, and query summaries.
- `outputPreview` is truncated and redacted, capped at 2000 characters by default.
- Tool output is never automatically written back to GitLab.
- Command tool output must be filtered for tokens, environment variables, and absolute paths.

## 11. ReviewFinding Output

### `finding.created`

```json
{
  "type": "finding.created",
  "finding": {
    "id": "finding_01J...",
    "fingerprint": "sha256:...",
    "path": "src/checkout.ts",
    "startLine": 44,
    "endLine": 47,
    "side": "new",
    "category": "bug",
    "severity": "high",
    "confidence": "high",
    "title": "Inventory can be oversold during checkout",
    "content": "The inventory update is not atomic with request creation...",
    "evidence": [
      { "path": "src/checkout.ts", "startLine": 44, "endLine": 47, "quote": "..." },
      { "path": "src/inventory.ts", "startLine": 18, "endLine": 24, "quote": "..." }
    ],
    "existingCode": "await checkoutInventory(order.items)",
    "suggestionCode": "await inventory.reserve(order.items)",
    "ruleId": "checkout.inventory-atomicity",
    "source": "model",
    "status": "draft"
  }
}
```

## 12. Idempotency and Caching

Review cache key:

```text
providerId + model + repositoryRevision + normalizedRequest + ruleSetVersion
```

- Same `requestId` and same payload hash: return the existing run.
- Different payload but the same requestId: return `request.id_conflict`.
- After cancellation, `resume` or `restart` can be chosen.
- The Finding fingerprint is independent of the run, used for deduplication and comment publishing.

## 13. Security

- The Gateway listens on `127.0.0.1` only, authenticated with a local random token.
- Cross-origin access is allowed only to GitLab origins the user configured explicitly.
- Model keys are stored in the system Keychain or a permission-restricted config file.
- Arbitrary local paths from the browser are not accepted.
- GitLab PATs are never passed in as part of a review payload.
- Command execution must be allowlisted, with a fixed working directory, timeouts, resource limits, and auditing.
- For the detailed threat model, see [Security, Privacy, and Key Governance](../security-privacy.md).

## 14. Versioning Policy

- Path versioning via `/v1`.
- Adding optional fields does not bump the major version.
- Only removing fields, changing semantics, or adding new required event fields bumps to `/v2`.
- `GET /v1/health` returns `protocolVersion`, which clients negotiate when connecting.
- Clients should ignore unknown SSE events and log them at debug level, without interrupting the task.

## 15. Not Included in the MVP

- Multi-user remote Gateways.
- The browser executing local commands directly.
- The Gateway automatically publishing GitLab comments.
- Automatically fixing and committing code.
- Public-internet deployment and cloud source code sync.
