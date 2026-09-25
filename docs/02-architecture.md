# 系统架构与数据模型

## 1. 架构目标

- 页面适配、GitLab 数据访问、模型调用和 UI 状态互不耦合。
- 浏览器直连与本地 Gateway 使用同一套请求、事件和 Finding 契约。
- 确定性模块负责定位、过滤、预算、去重和发布；Agent 只负责理解与判断。
- 所有写入操作可预览、可确认、可追踪。
- 无 Gateway 时保留可用的浅层体验，有 Gateway 时平滑升级。

## 2. 分层架构

```text
┌──────────────────────────────────────────────────────────────┐
│ GitLab 页面                                                  │
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
│ REST/GraphQL   │   │ diff · scope     │  │ Chat · Findings │
│ auth · position│   │ budget · redact  │  │ publish preview │
└───────┬────────┘   └────────┬─────────┘  └─────────────────┘
        │                     │
┌───────▼─────────────────────▼────────────────────────────────┐
│ Runtime Abstraction                                          │
│  DirectModelClient              AgentGatewayClient           │
│  chat / shallow review          chat / tools / review jobs   │
└─────────────────────────┬────────────────────────────────────┘
                          │
┌─────────────────────────▼────────────────────────────────────┐
│ Optional Local Agent Gateway                                 │
│  provider adapters · repository tools · rules · sessions     │
│  job runner · streaming · cache · audit                      │
└──────────────────────────────────────────────────────────────┘
```

## 3. 模块划分

### 3.1 Userscript Host

职责：

- 注入 Shadow DOM，防止 GitLab CSS 与插件 CSS 相互污染。
- 监听 SPA 路由，识别当前页面类型。
- 捕获选区、文件位置和代码上下文。
- 管理侧栏、悬浮工具栏、对话、Review、设置和诊断。
- 在用户确认后调用 GitLab 写接口。

不负责：模型 Prompt 策略、仓库工具执行、复杂规则匹配。

### 3.2 Platform Adapters

`GitLabAdapter` 是稳定接口，具体实现按能力探测选择：

- `GitLabRestAdapter`：GitLab CE / EE 主路径。
- `GitLabGraphqlAdapter`：补充大列表、分页或减少请求次数。
- `DomFallbackAdapter`：无 API 权限时读取当前页面内容。
- `UnsupportedAdapter`：只显示诊断和手工复制能力。

接口示意：

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

输入 PageContext、MR、Diff 和用户选择，输出可发送的 ReviewContext。

确定性步骤：

1. 文件过滤：跳过 lockfile、二进制、超大生成文件。
2. 文件分组：同目录、同 stem、翻译文件、测试与实现文件可组包。
3. Diff 裁剪：保留 Hunk、上下文行和选中范围。
4. 预算控制：按文件 / 整体 / 输出 token 限额裁剪并记录省略项。
5. 脱敏：按规则隐藏 token、密钥、个人信息。
6. 上下文索引：为每个证据块生成稳定 ID。

### 3.4 Runtime Abstraction

浏览器侧只依赖统一协议：

```ts
interface ReviewRuntime {
  capabilities(): Promise<RuntimeCapabilities>;
  chat(request: ChatRequest): AsyncIterable<AgentEvent>;
  review(request: ReviewRequest): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}
```

- `DirectModelRuntime`：实现 OpenAI-compatible chat / tool-call 的受限子集。
- `AgentGatewayRuntime`：实现完整流式任务、工具、上下文扩展和取消。

### 3.5 Finding Pipeline

模型不能直接发布评论。输出统一经过：

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

## 4. 核心数据模型

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

Fingerprint 建议使用以下稳定字段的哈希：

```text
host + project + relative path + normalized existingCode + category + normalized title
```

不要使用模型会话 ID、运行时间或自然语言全文作为指纹。

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

## 5. 关键流程

### 5.1 划词提问

```text
用户选中代码
  → SelectionController 捕获 DOM Range
  → 从 closest diff row / file route 还原 path + line
  → 显示 SelectionToolbar
  → 点击“问一下”
  → 打开 Chatbox 并挂载 CodeSelection
  → 用户发送问题
  → Runtime.chat()
  → 流式渲染 Markdown
```

失败降级：无法还原行号时仍可携带文本提问，但不显示“精确定位”能力。

### 5.2 Review

```text
点击 Review
  → 校验 runtime + platform capabilities
  → Context Builder 创建 ReviewRequest
  → 运行确定性预处理
  → Runtime.review()
  → 消费 AgentEvent
  → Finding Pipeline 处理结果
  → 按 severity / confidence 展示
```

状态机：

```text
idle → preparing → running → normalizing → completed
                         ↘ cancelled
                         ↘ failed
```

- `cancelled` 保留已完成的临时结果，但不能进入发布队列。
- `failed` 必须展示失败阶段、已消费预算和可重试范围。

### 5.3 发布评论

```text
Finding 展开
  → 用户编辑评论草稿
  → 点击“发布到 GitLab”
  → 预览 path + line + body
  → 再次确认
  → 重新校验 diff_refs 与文件版本
  → POST discussions
  → 成功后状态 published，保存 discussion id
```

如果 GitLab 返回位置无法解析：

- 不猜测行号。
- 显示原因为 `line_out_of_diff` 或 `stale_diff_refs`。
- 允许复制为 MR 级普通评论，由用户手工粘贴或确认发布。

## 6. 状态管理

建议 Zustand store 按领域拆分：

- `platformStore`：PageContext、AdapterCapabilities、诊断。
- `runtimeStore`：当前模式、连接状态、能力、模型。
- `chatStore`：会话、上下文附件、流式消息。
- `reviewStore`：Run、阶段、工具轨迹、Finding、过滤器。
- `settingsStore`：非敏感配置；敏感配置使用独立安全通道。

持久化边界：

- 可持久化：站点适配偏好、UI 状态、规则开关、匿名化 Finding 元数据。
- 谨慎持久化：模型 Base URL、站点列表、项目映射。
- 默认不持久化：API Key、PAT、源码全文、模型思维链。

## 7. 错误模型

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

错误按域分类：

- `platform.*`：DOM 识别、API 授权、站点兼容。
- `runtime.*`：模型连接、Gateway、流式协议、取消。
- `context.*`：Diff 缺失、文件过大、预算超限。
- `finding.*`：Schema、定位、去重、反思失败。
- `publish.*`：权限、Diff 版本、限流、冲突。

## 8. 性能设计

- 大 Diff JSON 解析和 Hunk 标记放 Web Worker。
- DOM 查询使用缓存与 MutationObserver，避免全页轮询。
- 侧栏长列表使用虚拟化；Finding 展开内容按需渲染。
- 流式文本使用分帧批处理，避免每次 delta 触发布局抖动。
- 上下文构建先估算 token，再取文件，避免无效请求。
- Gateway 任务缓存按 `repository revision + request + rule version` 建键。

## 9. 技术选型

| 领域 | 选择 | 原因 |
| --- | --- | --- |
| 构建 | Vite + TypeScript | 当前项目已有，构建油猴脚本成熟 |
| UI | React 19 | 适合复杂状态和流式 UI |
| 油猴构建 | vite-plugin-monkey | 当前项目已有，支持 metadata 与 GM API |
| 样式 | Tailwind CSS 4 + Shadow DOM scope | 快速迭代，需验证 Shadow DOM 构建产物 |
| 状态 | Zustand | 轻量、领域 store 易拆分 |
| 图标 | lucide-react | 统一工具栏和状态图标 |
| Markdown | react-markdown + remark-gfm | 回答与评论草稿渲染 |
| 模型协议 | 内部 Runtime 抽象 | 不让 UI 直接依赖某个 provider SDK |

现有 `@assistant-ui/*` 依赖可在 M1 评估后决定保留或移除，避免 Chatbox 同时存在两套抽象。

## 10. 架构决策摘要

1. GitLab API 优先于 DOM，DOM 只做入口和降级。
2. Gateway 不持有 GitLab 写权限。
3. Finding 与 GitLab Discussion 是两个模型，中间必须有映射和用户确认。
4. 直连模型和 Gateway 使用同一事件流。
5. 定位失败必须显式失败，不允许自动猜行。
