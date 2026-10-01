# MCP 本地中继桥与 Agent 工具面开发计划

> 状态：计划（未实现）。本文定义「让外部 Agent 调用浏览器内 Review Agent」的目标架构、
> 工具面、传输与安全模型、里程碑与验收标准。
> 背景约束见 [01-capability-boundary.md](01-capability-boundary.md)：纯浏览器端无法监听端口，
> 因此标准 MCP server 角色必须由一个**可选的本地中继进程**承担。

## 1. 目标与非目标

### 1.1 目标（按用户价值排序）
1. **外部 Agent 读写规则包（coderules）**：列出/读取/新增/修改/删除/启停规则与规则包，
   支持公共与按项目作用域，使其他 Agent 能把团队规范沉淀为确定性规则。
2. **外部 Agent 读取 Review 状态**：当前 Review 的运行状态、阶段报告、findings（含来源/
   严重度/锚点/发布状态）、警告与会话历史；可订阅状态变化。
3. **需求/技术文档进入 Review 上下文**：把 URL、本地文件、GitLab 仓库文件/Wiki 页作为
   「参考文档」附加到本次 Review 的模型上下文（注入 `background`），让评审对照需求而非仅凭代码猜测。
4. **跨 GitLab 项目上下文**：读取其他项目的文件/树/提交作为参考上下文，并支持跨项目符号
   搜索（复用本地索引能力，按项目分命名空间）。
5. 上述能力同时以**页内 RPC** 形式暴露给同页的其他 userscript / 扩展 / 页内 harness，
   不依赖任何外部进程。

### 1.2 非目标
- 不做托管/云端中继（仅评估，见 §9 M5）。
- 不让桥进程直接访问 GitLab：所有 GitLab 调用仍由 userscript 借浏览器登录态/PAT 发起，
  桥只做转发，避免在本地进程里存凭据。
- 不替代现有 MCP **client** 方向（脚本连外部 MCP server 扩展工具）保持不变。

## 2. 现状与约束

| 约束 | 说明 | 对策 |
| --- | --- | --- |
| 浏览器不能监听端口 | userscript 只能出站请求 | 桥进程做标准 MCP server；userscript 出站连桥 |
| gitlab.com CSP `connect-src 'self'` | 页面 fetch 受限 | 桥通道走 `GM.xmlHttpRequest` 长轮询回退，或 WS（userscript 上下文不受页面 CSP 约束） |
| 无本地进程边界 | docs/01 排除本地进程 | 桥为**可选**开发/集成工具，文档化例外，不进入默认安装路径 |
| 多标签/多 MR | 同一浏览器可能开多个 MR 页 | 会话仲裁：最近活跃标签持有桥连接，握手带 `tabId`，后连者抢占并通知前者 |
| 版本错配 | 桥与 userscript 独立升级 | 握手交换协议版本与工具面 hash，不兼容时明确报错并提示升级 |

## 3. 总体架构

```
MCP Host（Codex / Claude Desktop / Cursor / 自研 Agent）
   │ stdio 或 Streamable HTTP（标准 MCP server 角色）
   ▼
review-agent-bridge（本地可选进程，仅绑定 127.0.0.1）
   │ WebSocket ws://127.0.0.1:<port>（token 配对）；长轮询回退
   ▼
Userscript 工具面（MCP 同构：tools/list · tools/call · 事件订阅）
   │ 复用现有能力
   ├─ ReviewEngine / 规则包存储（公共 + 按项目作用域）
   ├─ GitLabAdapter（MR / 文件 / 搜索 / 提交 / 跨项目）
   ├─ RepoIndex（OPFS 符号表，按项目+ref 命名空间）
   └─ Session / DebugBus（状态、历史、审计）
```

- **页内 RPC** 与桥暴露**同一工具面**：页内走 `window.postMessage`（带 origin 白名单与
  nonce 握手），桥走 WS。工具实现只有一份（`core/agent-surface.ts`），传输层可插拔。
- 工具面 schema 与 MCP 同构（`tools/list` 返回 JSON Schema；`tools/call` 返回
  `content[]` + `isError`），未来接托管 relay 时 userscript 侧零改动。

## 4. 工具面设计（MCP 同构）

命名空间 `review.* / rules.* / context.* / gitlab.* / session.*`。所有写操作带
`dryRun` 与幂等键；所有工具返回结构化 JSON 并附 `traceId`（对应 DebugBus 记录）。

### 4.1 review.*（状态与执行）
| 工具 | 说明 | 读/写 |
| --- | --- | --- |
| `review.start` | 触发 Review（scope: all/selection；mode 继承设置） | 写 |
| `review.status` | 运行状态、阶段报告（rules/model）、警告、是否流式中 | 读 |
| `review.findings` | findings 列表（过滤：来源/严重度/状态/路径），含锚点与发布状态 | 读 |
| `review.getFinding` | 单条详情（证据、建议代码、规则 id、印证来源） | 读 |
| `review.cancel` | 停止流式 Review（保留规则结果） | 写 |
| `review.publish` | 发布单条/批量行内评论、总评论（幂等键去重） | 写·需授权 |
| `review.approve` | Approve 当前 MR | 写·需授权 |
| `review.subscribe` | 订阅状态/findings 变化（桥侧转为 MCP notifications 或轮询差量） | 读 |

### 4.2 rules.*（coderules 读写，支撑「其他 agent 改规则」）
| 工具 | 说明 | 读/写 |
| --- | --- | --- |
| `rules.list` | 作用域（public/project）内规则包与规则、启停状态、命中统计 | 读 |
| `rules.get` | 单条规则详情（pattern、scope、languages、严重度） | 读 |
| `rules.upsertRule` | 新增/修改规则（校验 schema 与正则合法性，返回校验错误） | 写·需授权 |
| `rules.deleteRule` / `rules.toggleRule` | 删除 / 启停 | 写·需授权 |
| `rules.upsertPack` / `rules.deletePack` | 规则包级管理（含按项目作用域创建） | 写·需授权 |
| `rules.import` / `rules.export` | JSON 导入导出（与设置页同校验路径） | 写/读 |
| `rules.test` | 对给定代码片段试跑某规则，返回命中行（供 Agent 自证规则有效） | 读 |

### 4.3 context.*（需求/技术文档与跨项目上下文）
| 工具 | 说明 | 读/写 |
| --- | --- | --- |
| `context.attachDoc` | 附加参考文档：`url` / `gitlabFile(project,path,ref)` / `wiki` / 粘贴文本；返回摘要与字符预算占用 | 写 |
| `context.list` / `context.detach` | 查看/移除已附加文档 | 读/写 |
| `context.addProject` | 登记跨项目上下文：projectPath + ref；后续 `gitlab.*` 与符号搜索可指定该项目 | 写 |
| `context.setBrief` | 设置本次 Review 的业务背景文本（注入 `background`） | 写 |
| `context.budget` | 查看上下文预算分配（diff/全文件/参考文档/符号上下文）与省略原因 | 读 |

参考文档注入点为 ReviewEngine 的 `background`；字符预算与省略记录复用 Context Builder，
超预算时按「需求文档 > 技术文档 > 其他」优先级截断并记录原因。

### 4.4 gitlab.*（含跨项目）
在现有 `file_read / search_code / git_log` 基础上增加可选 `project` 参数（默认当前 MR 项目）；
跨项目调用受 `context.addProject` 登记与 PAT/登录态权限约束，未登记项目返回明确错误。
符号工具 `symbol_search / call_chain` 增加 `project` 参数，索引按项目+ref 命名空间复用 RepoIndex。

### 4.5 session.*
`session.list / session.get / session.resume / session.export`（导出结构化 JSON，
对齐差距分析中的「findings 结果导出」项）。

## 5. 传输、配对与生命周期

1. **桥进程**：`review-agent-bridge`（仓库内 `packages/mcp-bridge`，npm bin）。
   - 对 MCP host：stdio（默认）与 Streamable HTTP（`--http 127.0.0.1:PORT`）双传输；
   - 对 userscript：WS server 仅绑定 `127.0.0.1:<bridgePort>`；
   - 无 userscript 连接时，工具调用返回 `not_connected` 错误并提示打开 GitLab 页面。
2. **配对**：首次启动桥生成一次性 token 并打印/写 `~/.config/review-agent/bridge.json`（0600）；
   userscript 设置页「Agent 桥」输入或粘贴 token 完成配对，token 混淆存储；支持旋转。
3. **消息信封**：`{ v, id, method, params }` / `{ v, id, result | error:{code,message,data} }`；
   错误码：`not_connected / permission_denied / validation_failed / gitlab_error / version_mismatch`。
4. **回退传输**：WS 不可用（企业策略/CSP 异常）时 userscript 以 `GM.xmlHttpRequest`
   长轮询 `127.0.0.1` 拉取待执行请求并回传结果（延迟升高但可用）。
5. **多标签仲裁**：握手带 `tabId + mrKey`；桥维护「活跃会话」，新握手抢占旧连接并向旧者发
   `session_preempted`；MCP host 侧可见当前绑定的 MR（`review.status` 返回 `mrKey`）。

## 6. 安全模型

- 桥仅绑定回环地址；token 配对 + 每消息签名（HMAC(token, body)）防本机其他进程冒用。
- **权限分级**：读工具默认开放；写工具分两级——`mutate`（rules/context/session 写）与
  `publish`（review.publish/approve），在 userscript 设置页逐项开关，默认全关；
  关闭时调用返回 `permission_denied` 并附开启路径。
- 所有桥调用写入 DebugBus（方法、参数摘要、耗时、结果码），设置页调试面板可审计；
  `review.publish` 与 `rules.*` 写操作额外记录 before/after 摘要。
- 凭据不出浏览器：桥不接触 API Key/PAT/Cookie；GitLab 调用始终在 userscript 内发起。

## 7. 里程碑

| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| M1 工具面与页内 RPC | `core/agent-surface.ts` 抽取现有能力为同构工具；页内 postMessage RPC（nonce 握手）；review.*/rules.* 读工具 | 单测覆盖工具 schema 与分发；页内 RPC e2e（mock） |
| M2 桥只读通道 | `packages/mcp-bridge`：stdio MCP server + WS 中继 + 配对；review.*/rules.*/session.* 读工具端到端 | 用 MCP inspector 或自研 client 连通；断连/重连/版本错配用例 |
| M3 写工具与权限 | rules.* 写、review.publish/approve、权限开关与审计 | mock e2e：Agent 改规则后 Review 命中变化；权限关闭时 denied |
| M4 上下文增强 | context.*（attachDoc/setBrief/budget）、跨项目 gitlab.*/符号工具 | 真实 GitLab e2e：附加需求文档后模型引用文档；跨项目 file_read |
| M5 评估托管 relay | 云上反向通道可行性（配对、鉴权、审计） | 设计评审结论，不默认实现 |

## 8. 测试与验收

- 单测：工具面分发、schema 校验、信封/HMAC、预算截断优先级、跨项目命名空间。
- E2E（mock）：页内 RPC 全工具冒烟；桥以进程内假 WS 模拟，验证仲裁与重连。
- 集成（真实 GitLab + 真实桥进程）：MCP host 冒烟脚本（tools/list → review.status →
  rules.upsertRule → review.start → review.findings → review.publish dryRun）。
- 契约测试：桥暴露的 MCP schema 与 userscript 工具面 hash 一致性检查进 CI。

## 9. 风险与开放问题

- **本地进程边界**：需在 docs/01 增加「可选集成进程」例外说明，默认安装路径不含桥。
- **WS 与 GM 传输差异**：长轮询回退下订阅语义退化为差量轮询，需在工具描述中声明。
- **并发 Review**：同一标签同时被 UI 与 Agent 触发时以先者为准，后者返回 `busy`。
- **host 生态差异**：stdio 与 Streamable HTTP 的通知能力不同，`review.subscribe` 在
  不支持通知的 host 上退化为 `review.status` 轮询指引。
- 开放问题：桥作为独立 npm 包还是仓库内 packages；是否提供 Docker 化桥以便 CI 复用。
