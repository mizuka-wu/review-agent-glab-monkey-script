# TODO / Backlog

> 计划类与 backlog 内容集中在这里；`docs/` 只保留设计类文档。

## MCP 本地中继桥与 Agent 工具面（计划）

目标：让外部 Agent（Codex / Claude Desktop / Cursor 等）调用浏览器内的 Review Agent，
覆盖四类场景：① 读写 coderules；② 读取 Review 状态；③ 需求/技术文档进入 Review 上下文；
④ 跨 GitLab 项目上下文。约束：浏览器不能监听端口，故标准 MCP server 角色由**可选本地桥进程**承担；
GitLab 调用始终留在浏览器内（凭据不出浏览器）。

架构：MCP host ↔ `review-agent-bridge`（stdio / Streamable HTTP，仅绑定 127.0.0.1）
↔ userscript（出站 WS，token 配对 + HMAC；长轮询回退）。工具面抽到 `core/agent-surface.ts`
（MCP 同构：`tools/list` / `tools/call`），页内 postMessage RPC 复用同一实现（零进程可用）。

工具面分组：
- `review.*`：start / status / findings / getFinding / cancel / publish / approve / subscribe
- `rules.*`：list / get / upsertRule / deleteRule / toggleRule / upsertPack / deletePack / import / export / test（作用域：公共 + 按项目）
- `context.*`：attachDoc（url / gitlabFile / wiki / 文本）/ list / detach / addProject / setBrief / budget
- `gitlab.*`：file_read / search_code / git_log / symbol_search / call_chain，均带可选 `project` 参数（需先 `context.addProject` 登记）
- `session.*`：list / get / resume / export

安全：读工具默认开放；写分 `mutate` 与 `publish` 两级，设置页逐项开关默认全关；桥调用全量进 DebugBus 审计。
多标签仲裁：握手带 `tabId + mrKey`，后连者抢占；握手交换协议版本防错配。

里程碑：
- [ ] M1 工具面 + 页内 RPC（review.*/rules.* 读工具；单测 + mock e2e）
- [ ] M2 桥只读通道（stdio MCP server + WS 中继 + 配对；重连/版本错配用例）
- [ ] M3 写工具与权限（rules 写、publish/approve、权限开关与审计）
- [ ] M4 上下文增强（attachDoc/setBrief/budget、跨项目 gitlab 与符号工具）
- [ ] M5 托管 relay 评估（仅设计评审，不默认实现）

## 0.3.0 已落地

- 流式评审：SSE 逐 token、思考通道折叠打字机（JSON/代码块自动折叠摘要、展开自动滚动）、finding 增量进入结果列表、规则先行、可停止。
- 快速操作：一键 Approve / 一键行内评论 / 总评论（两步确认）。
- 全文件扫描（索引页，仅规则，结果不可发布）；findings JSON 导出；Delegation 上下文导出。
- 大 MR 目录内聚分组 + 并发子评审（分组失败保留其余）；评论反思自检（fast 跳过）。
- 规则文档化：rule_docs/*.md 为唯一来源 + 生成器 + CI 漂移检查；eval fixture 8 → 31。
- 符号精度一阶段：import 感知解析 + 调用链去同名误边。
- 模型选择：可输入+下拉建议、不在服务器列表时自动切换并立即保存、对话区顶部可切换。
- 失败显性化：模型非 2xx（含 507 内存不足）横幅+toast+URL；GitLab 传输改 GM 优先；去重读取失败进 warnings+toast；划词工具条在面板内选区时隐藏。
- VitePress 文档站（设计文档）+ 旧前缀 URL 重定向。

## 与 OpenCodeReview 的剩余差距（backlog）

- [x] 符号检索精度（一阶段）：import 感知解析（ts/js/py/go）+ 调用链排除同名本地定义误边；LSIF 级精确调用图仍开放
- [x] 大 MR 文件分组 + 并发子评审（目录内聚分组、并发 3、分组失败保留其余结果）
- [x] 评论反思（reflection）模块：模型自检 keep/drop，fast 强度跳过，移除项进 warnings
- [x] 基准规模：eval fixture 8 → 31（每条规则一个标注样本 + 干净负样本）；外部人工标注引入仍开放
- [x] 规则文档化：rule_docs/*.md 为唯一来源（frontmatter + 模式 + 正反例），scripts/generate-rules.mjs 生成代码，--check 漂移门禁进 CI
- [x] 全文件扫描：索引页「扫描已索引文件」对已缓存文件跑规则，扫描模式结果不可发布
- [x] 结果增量/流式输出（已落地：SSE 流式 + 思考折叠 + 增量 findings + 规则先行）
- [x] Delegation 上下文导出：文件选择 + 适用规则 + Diff + 背景 + 输出 schema，一键复制
- [x] findings 结果导出：结果页「导出 JSON」（来源/证据/锚点/状态 + 计数）

## 验收基线（持续门禁）

- 检测率 ≥ 80%；精确率 ≥ 70%（目标 80%）；安全类 100%；干净代码 0 误报；定位准确 ≥ 95%。
- 合并门禁：`pnpm typecheck` + `pnpm test:unit` + `pnpm test:e2e` + `pnpm build`。

## 其他开放项

- [ ] P3：本地 Gateway / IDE 插件 / 团队化能力（`ReviewRuntime` 抽象已预留替换点）
- [ ] 思考过程进一步结构化（要点抽取 / 分段时间轴）
- [ ] Session viewer 剩余 parity：回放与「处理中隐藏」交互
