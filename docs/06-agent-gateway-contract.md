# 本地 Agent Gateway 协议草案

## 1. 目标

Gateway 为油猴脚本提供浏览器无法稳定实现的模型、仓库、规则、工具和长任务能力。协议保持传输无关，MVP 使用 HTTP + SSE，后续可增加 WebSocket 或 MCP。

## 2. 设计原则

- 浏览器和 Gateway 使用同一 AgentEvent 契约。
- Gateway 默认不保存 GitLab token，不拥有 GitLab 写权限。
- 所有工具调用可观察、可取消、有预算。
- 源码和模型密钥默认只留在本机。
- 任务幂等，可恢复，不依赖浏览器页面持续存在。
- 协议显式版本化，能力通过探测而非版本号猜测。

## 3. 服务发现

默认地址：

```text
http://127.0.0.1:4317
```

生产实现必须支持用户修改端口，并绑定 loopback。不要默认监听 `0.0.0.0`。

## 4. 公共响应

```json
{
  "ok": true,
  "requestId": "req_01J...",
  "data": {}
}
```

错误：

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

## 5. 健康与能力

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

## 6. 项目映射

### `POST /v1/repository-mappings`

```json
{
  "gitlabOrigin": "https://gitlab.example.com",
  "projectPath": "group/subgroup/project",
  "localPath": "/Users/dev/Projects/project",
  "defaultRef": "main"
}
```

约束：

- `localPath` 必须真实存在且是 Git worktree / bare mirror。
- 路径由用户在 Gateway 配置界面确认，不接受网页任意路径探测。
- 映射保存在 Gateway 配置，不返回给模型。

## 7. Chat

### `POST /v1/chat`

请求：

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

响应为 `text/event-stream`：

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

## 8. Review 任务

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

### SSE 事件

复用 [系统架构](02-architecture.md) 的 `AgentEvent`，关键事件：

- `run.created`
- `stage.changed`
- `context.added`
- `tool.started` / `tool.completed`
- `finding.created`
- `warning`
- `run.completed` / `run.failed`

## 9. 取消与恢复

### `POST /v1/runs/:runId/cancel`

```json
{ "reason": "user_cancelled" }
```

### `GET /v1/runs/:runId`

返回持久化状态、阶段、已完成 Finding、预算和错误。支持浏览器刷新后恢复 UI。

### `GET /v1/runs/:runId/events?after=<cursor>`

用于断线重连。Gateway 保留事件游标 24 小时。

## 10. 工具契约

```ts
interface GatewayTool<Input, Output> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  sideEffect: 'none' | 'read-cache' | 'command';
  execute(input: Input, context: ToolContext): Promise<ToolResult<Output>>;
}
```

MVP 工具：

| 工具 | 作用 | 默认权限 |
| --- | --- | --- |
| `file_read` | 读取映射仓库的指定行范围 | 只读 |
| `file_read_diff` | 读取一个或多个文件 Diff | 只读 |
| `file_search` | 按文件名 / 路径搜索 | 只读 |
| `code_search` | 字面 / 正则搜索 | 只读 |
| `symbol_search` | 基于语言索引搜索定义和引用 | 只读 |
| `git_history` | 查看提交、blame、历史变更 | 只读 |
| `run_check` | 执行 allowlist 中的检查命令 | 默认关闭 |

### 工具事件脱敏

- `input` 只显示路径、行范围、查询摘要。
- `outputPreview` 截断并脱敏，默认不超过 2000 字符。
- 工具输出不自动回写 GitLab。
- 命令工具输出需过滤 token、环境变量和绝对路径。

## 11. ReviewFinding 输出

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

## 12. 幂等与缓存

Review cache key：

```text
providerId + model + repositoryRevision + normalizedRequest + ruleSetVersion
```

- `requestId` 相同且 payload hash 相同：返回已有 run。
- payload 不同但 requestId 相同：返回 `request.id_conflict`。
- 取消后可选择 `resume` 或 `restart`。
- Finding fingerprint 独立于 run，用于去重和评论发布。

## 13. 安全

- Gateway 仅监听 `127.0.0.1`，使用本地随机 token 鉴权。
- 跨域只允许用户显式配置的 GitLab origin。
- 模型密钥保存在系统 Keychain 或权限受限配置文件。
- 不接受浏览器传入任意本地路径。
- 不把 GitLab PAT 作为 review payload 传入。
- 命令执行必须 allowlist、固定工作目录、超时、资源限制和审计。
- 详细威胁模型见 [安全、隐私与密钥治理](07-security-privacy.md)。

## 14. 版本策略

- 路径版本 `/v1`。
- 新增可选字段不升主版本。
- 删除字段、改变语义、事件新增必填字段才升 `/v2`。
- `GET /v1/health` 返回 `protocolVersion`，客户端在连接时协商。
- 未知 SSE 事件客户端应忽略并记录 debug，不中断任务。

## 15. MVP 不包含

- 多用户远程 Gateway。
- 浏览器直接执行本地命令。
- Gateway 自动发布 GitLab 评论。
- 自动修复与提交代码。
- 公网部署和云同步源码。
