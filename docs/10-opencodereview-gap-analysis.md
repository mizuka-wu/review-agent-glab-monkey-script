# 与 OpenCodeReview（alibaba/open-code-review）的差距分析

> 对比对象：[alibaba/open-code-review](https://github.com/alibaba/open-code-review)（Go CLI，
> "deterministic pipelines + LLM Agent" 混合架构，内置多语言规则集，OpenAI / Anthropic 兼容）。
> 本文记录 2026-10 一轮对齐后的现状、已落地项与仍然存在的差距。

## 1. 结论摘要

OpenCodeReview 的核心竞争力不是"会用模型"，而是**把不能出错的部分交给确定性工程**：
文件选择、文件分组、规则匹配、评论定位与反思都由代码保证；模型只负责语义判断。
本项目此前是"模型优先、规则兜底"（未配置 API Key 时 Review 直接不可用），与这一哲学相反。

本轮改造把架构翻转为 **规则优先、模型叠加**：

- 规则阶段永远运行（浏览器本地、零 token、离线可用）；
- 模型阶段可选，失败不拖垮规则结果；
- 两个来源在 UI 中显式区分（`规则` / `AI` / `规则 + AI`），命中同一处问题时自动合并并标注相互印证；
- 未配置 API Key 时给出明确提示，并说明哪些能力仍然可用。

## 2. 能力对照

| 维度 | OpenCodeReview | 本项目（本轮之后） | 差距 |
| --- | --- | --- | --- |
| 执行形态 | CLI / CI / Agent 插件 | 浏览器油猴脚本，嵌入 GitLab 页面 | 形态不同，非劣势：无需本地进程即可在 MR 页面闭环 |
| 确定性规则 | 内置多语言规则集（NPE、线程安全、XSS、SQL 注入等） | 内置 24 条多语言规则：密钥、URL 凭据、SQL 注入、XSS、命令注入、TLS 校验关闭、弱哈希、可预测随机数、静态可变共享状态、Java `equals`、Kotlin `!!`、TS `!`、弱类型、吞 Promise、裸 except、Go 丢弃 error、阻塞 sleep、跳过测试、调试输出、内网地址、TODO、冲突标记、缺测试 | 规则数量与语言覆盖仍少于对方（对方按语言文档组织 ~50 个文件），但关键类别已覆盖 |
| 规则与语言匹配 | 模板引擎按文件特征匹配规则 | `languages` + glob `scope` + 注释行跳过 + 单文件命中上限 | 已具备同等思路，规则文档化程度较低 |
| 无 Key 可用 | 仅 Delegation 模式可不配 Key | **默认可用**：规则检查、定位、编辑、复制草稿全部离线可用；UI 有未配置提示 | 已对齐并更彻底 |
| 来源区分 | 确定性结果与 LLM 结果在 pipeline 中分离 | Finding 带 `source` / `corroborated` / `ruleId` / `rulePackId`，UI 分组 + 筛选 + 计数 | 已对齐 |
| 跨来源去重 | 规则先行、模型聚焦，天然少重复 | `corroborateFindings`：同行同类（或标题相似）合并，保留双方溯源并提升置信度 | 已对齐 |
| 评论定位 | 独立 re-location 模块 | `existingCode` 精确匹配 + 跨文件重定位 + 完整文件锚定（不可发布标记） | 思路一致；对方有独立反思模块，本项目靠 hardening |
| 噪声控制 | 精确率优先，召回率刻意让步 | 证据充分度、严重度校准、相似合并、强度预算（仅作用于 AI 结果）、规则命中上限 | 已对齐 |
| 文件分组 / 子代理 | 相关文件打包成 bundle 并发评审 | 单上下文 + 字符预算截断 | **仍有差距**：大 MR 依赖预算截断，缺少 bundle 并发 |
| 全文件扫描 | `ocr scan` 支持无 diff 目录审计 | 仅 MR / commit diff + 选区 | **仍有差距**（浏览器场景价值有限） |
| 会话 | session list / resume / viewer（浏览器查看、标记 fixed/ignored） | session 持久化、resume、历史列表、逐条忽略/编辑 | viewer 是独立网页，本项目内嵌面板；功能等价度约 80% |
| 基准评测 | AACR-Bench（200 PR、1505 标注） | 本地 8 fixture 回归门禁 | **仍有差距**：样本量与人工校验规模不可比 |
| 上下文工具 | git 原生：search、log、全文件、符号级检索 | GitLab REST：file_read / search_code / git_log + MCP 扩展；**本地符号索引**（OPFS 缓存 + 启发式符号表）提供 `symbol_search` / `call_chain` 工具与 Review 仓库上下文 | 符号检索为启发式（正则符号表），非精确调用图 |
| 发布 | 输出 JSON / CI 评论 | 行级 Discussion 草稿，人工确认后发布（含批量） | 形态不同；本项目强调"人确认" |

## 3. 本轮已落地

1. **混合评审管线**（`review-engine.ts`）：规则阶段恒运行；模型阶段可关（`reviewMode`），失败降级为规则结果并给出 warning。
2. **内置规则集扩充**（`rule-packs.ts`）：5 → 24 条，覆盖安全 / 正确性 / 并发 / 测试 / 可维护性；按语言与路径作用域匹配；跳过注释行；单规则单文件命中上限 8 并在 Finding 上记录 `occurrences`。
3. **跨来源印证合并**（`finding-hardening.ts#corroborateFindings`）：同行同类合并为一条，标注 `规则 + AI`，严重度取更高者，置信度提升为 high。
4. **来源可见性**（`FindingCard` / `FindingsPanel`）：`规则` / `AI` / `规则 + AI` 徽标、来源分组标题、来源筛选与计数、规则 id 与规则包名展示（可直接去设置里关掉这条规则）。
5. **未配置提示**：侧栏顶部常驻横幅（可关闭）说明"规则检查不需要 Key"与缺少项；设置页"当前能力"卡片逐项列出可用能力；FAB 角标；聊天与 Review 的拒绝路径都给出可操作指引。
6. **强度预算只作用于 AI 结果**：确定性结果不再被 `effort` 过滤，用户启用的规则始终可见。
7. **UI 重构**：结果 / 对话 / 设置 / 调试四标签；面板可拖拽、可拉伸宽度；Finding 折叠卡片带代码预览；批量发布条；会话恢复与历史。
8. **依赖瘦身**：移除 assistant-ui / tailwind / ai-sdk 等运行时依赖，产物 2.5 MB → 0.9 MB（gzip 190 KB），注入更快、样式不再与 GitLab 互相污染。
9. **本地仓库索引**（`repo-store.ts` / `repo-index.ts` / `symbols.ts`）：引入 [opfs-worker](https://github.com/kachurun/opfs-worker)，优先独立 Worker（gitlab.com CSP 允许 `blob:` worker），退回主线程 OPFS，再退回内存；按 head ref 缓存仓库文件并构建符号表，提供符号搜索、启发式调用链，以及注入 Review 提示词的「Diff 外调用点」上下文。同 ref 命中缓存时零网络开销恢复。
10. **调试工具链**（`debug-bus.ts` + DebugPanel）：日志 / 网络 / 提示词 / 状态四面板。GitLab API、模型调用、MCP、索引的每次请求都记录方法、状态码、耗时、字节数；每次模型调用记录完整 system 与消息内容（超长截断）、工具列表、token 用量；`console.warn/error` 被镜像进日志；日志跨刷新保留；一键导出 JSON 调试包（含脱敏快照）。
11. **CSP 兼容传输**（`http.ts`）：模型/MCP 请求优先走 `GM.xmlHttpRequest`（不受 gitlab.com `connect-src 'self'` 与 CORS 限制），流式对话保留 fetch 并在被拦截时自动回退。

## 4. 仍然存在的差距（按优先级）

0. **符号检索精度**：本地符号表是正则启发式（定义/调用点/包围函数），不等于 LSIF 级别的精确调用图；重载、泛型特化、动态派发会漏。
1. **大 MR 文件分组与并发子评审**：对方把相关文件打包成 bundle 并行评审，覆盖率更稳。浏览器端可用 `Promise` 并发 + 每 bundle 独立上下文近似实现，是下一轮最大收益点。
2. **评论反思（reflection）模块**：对模型产出做一轮"是否值得评论 / 是否重复 / 位置是否正确"的自检，可进一步提升精确率。
3. **基准规模**：把本地 eval fixture 扩到 30+ 并引入人工标注，才能量化"精确率优先"的取舍。
4. **规则文档化**：对方的规则以语言文档形式维护（`rule_docs/*.md`），可读性与可扩展性更好；本项目规则仍是代码内数组。
5. **全文件扫描**：对无 diff 的目录做审计（`ocr scan`）。仓库索引已具备 tree + raw 拉取能力，可在此基础上扩展「扫描整个目录」入口。

## 5. 明确不做

- 本地进程 / CI Bot / IDE 插件（见 `docs/01-capability-boundary.md`）。
- 符号级搜索、调用链、运行测试（GitLab REST 能力不足）。
