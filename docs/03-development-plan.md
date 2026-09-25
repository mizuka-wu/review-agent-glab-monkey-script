# 开发计划与里程碑

## 1. 规划原则

- 先验证划词与 Chatbox 体验，再扩展完整 Review。
- 先支持 GitLab.com / 标准 GitLab REST，再做自部署差异适配。
- 评论发布晚于评论草稿，且始终 Draft first。
- Gateway 是能力扩展层，不应阻塞浏览器 MVP。
- 每个里程碑都有可演示产物、测试和退出标准。

## 2. 里程碑总览

| 里程碑 | 周期 | 核心产物 | 退出标准 |
| --- | --- | --- | --- |
| M0 计划与原型 | 1 周 | 文档、交互原型、数据契约 | 团队确认范围与边界 |
| M1 浏览器划词 MVP | 2-3 周 | 页面注入、选区、Chatbox、直连模型 | GitLab MR 上可稳定问答 |
| M2 GitLab Review MVP | 2-3 周 | MR Diff、局部 / 全局 Review、草稿 | Finding 可定位并可复制 / 发布 |
| M3 自部署与可靠性 | 2 周 | 能力探测、适配器、诊断、会话 | 标准自部署 GitLab 可降级运行 |
| M4 本地 Agent Gateway | 4-6 周 | Gateway、工具、流任务、规则 | 仓库级 Review 可复现 |
| M5 Review 硬化 | 3-4 周 | 定位、去重、反思、预算、评测 | 评测集达到质量门槛 |
| M6 团队化 / CI | 待定 | 规则包、审计、Bot、发布流程 | 团队试点通过 |

周期按 1-2 名前端 + 0.5 名后端 / Agent + 产品 / 设计兼职投入估算。若只有一名开发，M1-M3 预计 8-11 周。

## 3. M0：计划与原型

### 交付物

- 产品范围、能力边界、架构、接口、安全、测试文档。
- 可交互 UI 原型：划词、Chatbox、Review、Finding、发布确认、设置。
- 模拟数据契约和状态机。
- 风险清单与待确认问题。

### 任务分解

- [x] 调研 OpenCodeReview 的混合架构和结构化结果。
- [x] 明确浏览器 / GitLab API / 本地支持边界。
- [x] 定义 PageContext、ReviewFinding、AgentEvent。
- [x] 设计 Review、发布、失败、取消状态。
- [x] 完成交互原型。

### 退出标准

- 用户能在原型中走通“选中 -> 提问 / Review -> 查看 Finding -> 确认发布”。
- 团队认可 P0 范围、不支持项和 Gateway 必要性。

## 4. M1：浏览器划词 MVP

### 目标

在标准 GitLab MR 页面稳定完成划词提问。

### 开发任务

- 油猴 metadata、安装与构建流程。
- Shadow DOM 宿主、页面生命周期和 SPA 路由监听。
- MR / Diff / File URL 解析。
- 选区捕获、行号还原、悬浮工具栏。
- Chatbox、Markdown、代码附件、会话状态。
- `DirectModelRuntime`：OpenAI-compatible chat + SSE。
- 设置页：Base URL、模型、连接测试、数据预览。
- 浏览器兼容：Chrome / Edge + Tampermonkey，验证 Violentmonkey。

### 不包含

- 完整仓库工具。
- 自动评论发布。
- 复杂规则引擎。

### 退出标准

- 在 GitLab MR / Diff / File 三类页面成功注入，不破坏原页面交互。
- 选中 1-200 行代码后 500ms 内出现工具栏。
- 能携带 path + line + selection 提问并流式回答。
- API Key 不出现在日志、消息正文和错误堆栈。
- 构建产物无未声明的外部请求。

## 5. M2：GitLab Review MVP

### 目标

从“能问”升级到“能 Review，并生成可发布评论草稿”。

### 开发任务

- GitLab REST client、认证、分页、限流和错误映射。
- MR 元数据、Diff Refs、diffs、文件 raw 读取。
- Context Builder：范围、过滤、分组、token 预算。
- ReviewRequest / ReviewFinding schema 校验。
- Selection Review、Hunk Review、MR Review。
- Finding 列表、过滤、定位、编辑、复制。
- Discussion payload 构建、二次确认、创建 / 回退。
- 会话与 Finding 本地持久化、幂等指纹。

### 退出标准

- 50 个典型 MR fixture 中，Finding 定位成功率 > 95%。
- 无 `diff_refs` 时不创建行评论并给出明确降级。
- 同一 Review 重跑不产生重复草稿。
- 用户可取消 Review，取消后不能发布未完成任务结果。

## 6. M3：自部署与可靠性

### 目标

让标准自部署 GitLab 在版本、权限和 DOM 差异下可控运行。

### 开发任务

- Adapter capability probe。
- GitLab CE / EE 版本矩阵测试。
- PAT 与浏览器 Cookie / CSRF 认证模式。
- API 不可用时 DOM-only 降级。
- 站点配置导入 / 导出、诊断报告。
- 大 MR 性能：分页、Worker、虚拟列表、请求合并。
- 错误恢复、重试、离线状态、日志脱敏。

### 退出标准

- 两个以上自部署 GitLab 版本完成真机验证。
- 每种兼容级别都能在 UI 中解释当前能力。
- 大 Diff（500 文件 / 20k 行）不阻塞 GitLab 页面操作。

## 7. M4：本地 Agent Gateway

### 目标

提供浏览器无法实现的仓库级上下文、工具、长任务和 provider 适配。

### 开发任务

- Gateway 服务骨架、健康检查、版本协商。
- 项目映射与仓库 mirror / checkout 同步。
- provider adapter：OpenAI-compatible、Anthropic、企业网关。
- 工具：`file_read`、`file_read_diff`、`file_search`、`symbol_search`、`git_history`。
- Review job runner、SSE 事件、取消、重试、并发。
- 规则匹配、文件分组、上下文预算。
- 本地缓存、会话、成本 / token 统计。
- 可选命令执行器，默认关闭并使用 allowlist。

### 退出标准

- Agent 能根据问题读取非 Diff 文件并引用证据。
- 断线 / 刷新后可恢复运行状态或明确标记失败。
- Gateway 不持有 GitLab 写权限，源码默认不离开本机。
- 工具调用全部有输入摘要、输出摘要、耗时和错误。

## 8. M5：Review 硬化

### 目标

提高精确率、定位稳定性和结果可复核性。

### 开发任务

- 外部定位模块：existing code 滑窗、跨文件位置修正。
- 内容反思模块：证据充分性、严重度校准、建议有效性。
- 去重、相似 Finding 合并、评论路由。
- 规则包版本、路径匹配、团队模板。
- 评测集、基准脚本、回归门禁。
- Fast / Balanced / Thorough 三档预算。

### 退出标准

- Precision 达到团队约定门槛，例如人工抽检 >= 0.8。
- 低置信噪声默认隐藏比例可配置。
- 同一输入的结构化输出在容差内可复现。

## 9. M6：团队化与 CI

### 候选功能

- GitLab CI Bot、服务账号、幂等 sticky summary。
- 团队规则管理、审计日志、审批策略。
- MCP / Agent delegation。
- 多平台适配：Gitea、Codeup、Bitbucket。
- 私有化部署和组织级配置。

是否进入 M6 取决于 M4-M5 的真实使用反馈，不纳入当前承诺。

## 10. 交付节奏

每周固定产出：

- 可运行构建或原型。
- 关键路径录屏 / 截图。
- 自动化测试结果。
- 当前能力、风险、待确认问题更新。

每两周评审：

- 范围是否变化。
- 真实 GitLab 页面兼容情况。
- 模型 Finding 精确率与噪声。
- 安全 / 隐私是否出现新增数据流。

## 11. 风险登记

| 风险 | 概率 | 影响 | 应对 |
| --- | --- | --- | --- |
| GitLab DOM 频繁变化 | 高 | 中 | API 优先、适配器、fixture 回归 |
| 自部署版本 API 差异 | 高 | 高 | 能力探测、版本矩阵、降级 |
| 浏览器密钥泄漏 | 中 | 高 | 推荐 Gateway、最小存储、明确警告 |
| 模型评论噪声 | 高 | 高 | Finding Schema、置信过滤、反思、人工确认 |
| 评论行号漂移 | 高 | 高 | diff_refs、existingCode 锚定、失败不猜 |
| 大 MR 卡顿 | 中 | 高 | Worker、分页、预算、虚拟列表 |
| CORS / IdP / TLS | 中 | 中 | GM 请求、Gateway 代理、诊断 |
| 本地命令执行被滥用 | 低 | 极高 | 默认关闭、allowlist、隔离、审计 |
| 范围膨胀 | 高 | 中 | 里程碑退出标准、非目标清单 |

## 12. Definition of Done

每个功能完成需满足：

- 有产品行为和异常状态说明。
- 有 TypeScript 类型和 schema 校验。
- 有单元测试；GitLab / Gateway 集成有 contract test。
- UI 有 loading / empty / error / disabled / permission 状态。
- 有日志脱敏，不含 token 和完整源码。
- 文档与能力矩阵同步。
- 构建通过，无新增高风险依赖。
