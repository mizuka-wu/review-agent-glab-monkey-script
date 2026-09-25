# 能力边界：浏览器、GitLab API、本地支持

本文回答一个核心问题：哪些功能油猴脚本可以直接做，哪些必须依赖 GitLab API，哪些需要本地服务或 Agent Runtime。

## 1. 总体结论

| 能力 | 油猴脚本 | GitLab API / 页面 | 本地 Gateway | 结论 |
| --- | --- | --- | --- | --- |
| 页面注入、划词、悬浮工具栏 | 直接实现 | 不需要 | 不需要 | 纯浏览器可做 |
| 读取选中文本、文件名、当前 URL | 直接实现 | DOM 辅助 | 不需要 | 纯浏览器可做 |
| Chatbox、会话 UI、Markdown 渲染 | 直接实现 | 不需要 | 不需要 | 纯浏览器可做 |
| 读取 MR 标题、描述、变更文件、Diff | 可发起请求 | 需要 REST / GraphQL | 可代理 | 浏览器 + GitLab API |
| 读取完整文件、历史版本、跨 MR 上下文 | 可按需请求 | 需要 API | 推荐缓存 / 索引 | 浅层可做，深度需本地 |
| 仓库级符号搜索、调用链、语义索引 | 不可靠 | API 能力有限 | 需要本地仓库 | 必须本地支持 |
| 运行测试、lint、构建、脚本 | 不可做 | 不可做 | 需要安全执行器 | 必须本地支持 |
| 调用 OpenAI-compatible 模型 | 视 CORS 而定 | 不相关 | 推荐代理 | 可直连但不推荐存密钥 |
| Anthropic / Bedrock / 企业网关适配 | 通常困难 | 不相关 | 推荐适配层 | 优先本地支持 |
| 长任务、并发子任务、断点续跑 | 浏览器生命周期受限 | 不相关 | 需要任务运行器 | 深度 Review 需本地 |
| 精确行评论发布 | 可调用 | 需要 Discussions API | 可生成草稿 | 浏览器可做，必须确认 |
| 评论去重、幂等更新 | 可实现 | 需要读取 Discussions | 可计算指纹 | 浏览器可做 |
| 团队规则、规则包版本管理 | 可存简单配置 | 可从仓库读取 | 推荐规则引擎 | 复杂规则需本地 |
| 密钥安全保存 | 只能受限存储 | 不相关 | 适合保存 | 密钥优先放本地 |

## 2. 油猴脚本能独立完成的部分

### 2.1 页面宿主能力

- 注入 Shadow DOM UI，避免污染 GitLab 样式。
- 监听 `selectionchange` / `mouseup` / `keyup`，显示划词工具栏。
- 从 URL、面包屑、Diff DOM 中提取项目路径、MR IID、文件路径和行号。
- 打开侧栏、聊天、Review 结果、设置和诊断页。
- 在用户确认后复制或提交评论草稿。

### 2.2 浅层上下文构建

- 当前选中代码与前后若干行。
- 当前文件 Diff Hunk。
- 当前 MR 描述、标题、源 / 目标分支。
- 当前变更文件列表和用户选中的文件范围。
- 已在页面中渲染的讨论内容（可选）。

这些上下文足以做解释、局部风险分析和轻量 Review，但不等于仓库级理解。

## 3. 必须使用 GitLab API 的部分

| 数据 / 操作 | 推荐接口 | 备注 |
| --- | --- | --- |
| MR 元数据 | `GET /projects/:id/merge_requests/:iid` | 获取标题、状态、diff_refs、版本 |
| 变更列表 | `GET .../merge_requests/:iid/diffs` | 分页；比 `changes` 更适合大 MR |
| Diff Refs | MR 元数据或 `GET .../versions` | 发布 position 必需 |
| 文件内容 | `GET /projects/:id/repository/files/:path/raw` | 可按 ref 读取 |
| 单文件 diff | `GET .../diffs` 或 GraphQL | 减少一次性拉取 |
| 创建行评论 | `POST .../merge_requests/:iid/discussions` | 必须提交 position |
| 读取已有评论 | `GET .../merge_requests/:iid/discussions` | 去重、增量 Review |
| Pipeline / Commit | REST 或 GraphQL | 可作为证据，不在 MVP 执行命令 |

详细接口、字段和降级策略见 [GitLab 接入](05-gitlab-integration.md)。

## 4. 需要本地支持的部分

### 4.1 本地 Agent Gateway

Gateway 是用户机器上的可选服务，负责：

- 持有模型 API Key 和 provider 适配配置。
- 映射 `gitlabHost + projectPath` 到本地 clone / bare mirror。
- 提供文件读取、Git 历史、搜索、规则匹配等工具。
- 运行多阶段 Review、并发文件组、预算与取消。
- 生成结构化 Finding 并返回流式进度。
- 缓存仓库、规则和非敏感会话元数据。

### 4.2 为什么这些能力不适合浏览器

- 浏览器不能直接读取本地仓库，也不能稳定运行 Git / 测试命令。
- CORS、企业 IdP、自签名证书和 provider 协议差异会显著增加前端复杂度。
- 长任务受页面刷新、脚本更新和浏览器回收影响。
- 在 `GM.setValue` 中保存模型 / GitLab token 的安全性有限。
- 仓库级搜索和索引需要本地文件系统与后台缓存。

## 5. 推荐的职责分配

```text
油猴脚本
  - 页面识别、划词、UI、用户确认
  - 读取当前浏览器会话可访问的 GitLab 数据
  - 把最小上下文发送给模型或 Gateway
  - 仅在用户确认后写 GitLab

GitLab API
  - MR / Diff / File / Discussion 的事实来源
  - Diff Refs 与评论位置校验

本地 Agent Gateway（可选）
  - 模型密钥、provider、仓库工具、规则、长任务、缓存
  - 不持有 GitLab 写权限
```

## 6. 三种模式的能力差异

### 模式 A：浏览器直连模型

- 适合：划词问答、单 Hunk Review、快速草稿。
- 需要：用户填写模型 Base URL、模型名和 API Key；站点允许请求或油猴跨域权限可用。
- 不支持：可靠仓库搜索、构建 / 测试、复杂 Agent 工具、长任务恢复。
- 风险：密钥存储、CORS、自部署 TLS、token 泄漏面。

### 模式 B：本地 Gateway

- 适合：完整 MR Review、跨文件上下文、团队规则、稳定流式任务。
- 需要：本地服务、项目映射、模型 provider 配置。
- 优势：密钥不出本机、协议适配集中、可缓存、可运行工具。

### 模式 C：CI Bot

- 适合：自动触发、无人值守、统一机器人身份。
- 需要：GitLab Runner、服务账号 token、流水线配置。
- 区别：不是油猴脚本能力，而是复用 Finding 契约的服务端执行器。

## 7. 自部署 GitLab 类网站的兼容策略

不以域名判断能力，按以下顺序探测：

1. URL 是否符合 GitLab 项目 / MR 路由。
2. `GET /api/v4/version` 或无权限项目元数据是否可访问。
3. MR API 是否返回 `diff_refs`、`sha`、`versions` 等字段。
4. Discussions position API 是否支持目标版本。
5. DOM 是否保留稳定的数据属性；不可靠时优先 API。

适配结果分为：

- `full`：读取 + 定位评论 + 发布评论均可用。
- `read-only`：可分析，但不能安全定位 / 发布。
- `dom-only`：只能使用当前页面内容，适合划词问答。
- `unsupported`：不注入 Review 入口，仅显示诊断信息。

## 8. 何时需要升级到 Gateway

出现以下任一需求时，浏览器直连不再合适：

- 需要读取不在 Diff 中的定义、调用点或测试。
- Review 范围超过单次模型上下文预算。
- 需要执行 lint、单测、类型检查或自定义脚本。
- 需要按团队规则包统一生成 Finding。
- 需要断点续跑、并发、缓存、审计或成本统计。
- 模型 provider 不支持浏览器安全直连。

## 9. 明确不支持

- 从浏览器安全地运行本地 shell 命令。
- 在纯前端保存长期高权限 GitLab / 模型密钥而不提示风险。
- 自动修复并提交代码。
- 在没有 Diff Refs 时猜测评论行位置。
- 对任意 GitLab fork 的自定义 DOM 承诺完整兼容。
