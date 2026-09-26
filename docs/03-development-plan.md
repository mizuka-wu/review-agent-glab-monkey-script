# 开发计划与里程碑

## 1. 规划原则

- **纯浏览器端**（Tampermonkey 用户脚本），无服务端、无本地 Gateway、无 CI Bot。
- 评论发布晚于评论草稿，且始终 Draft first。
- 优先提升模型 Review 质量、Provider 兼容和用户体验。
- 每个功能有可演示产物、测试和退出标准。

## 2. 里程碑总览（已完成）

| 里程碑 | 状态 | 核心产物 |
| --- | --- | --- |
| M0 计划与原型 | ✅ | 文档、交互原型、数据契约 |
| M1 浏览器划词 MVP | ✅ | 页面注入、选区、Chatbox、直连模型 |
| M2 GitLab Review MVP | ✅ | MR Diff、局部/全局 Review、草稿、发布 |
| M3 自部署与可靠性 | ✅ | 能力探测、DOM 降级、诊断、大 MR 性能 |
| M5 Review 硬化 | ✅ | 证据检查、严重度校准、相似合并、三档预算 |
| P0 Review Engine | ✅ | Context Builder、锚定、去重、幂等发布 |
| P1 浏览器增强 | ✅ | 完整文件、跨文件重定位、Session/Resume、Finding 编辑、规则包 |
| P2 Provider + Agent | ✅ | 多 Provider、Agent tool loop、MCP |

## 3. 当前开发范围：浏览器端完善

### 第一批：Provider 与模型层（高优先级）

- [x] **企业网关认证模式**：自定义 Header（`api-key`、`X-Auth-Token`）、Azure OpenAI 风格 URL、自定义 auth scheme。
- [x] **密钥存储安全**：不存明文 localStorage，混淆存储，设置页安全提示。
- [x] **Token / 成本统计**：解析 API 响应 `usage` 字段，跨会话累计 token 用量与估算费用。

### 第二批：Review 与交互增强

- [x] **流式输出 (SSE)**：逐 token 流式渲染到聊天和 Review 进度。
- [x] **聊天 Markdown 渲染**：代码块、表格、列表等格式化。
- [x] **Discussion 同步**：读取已有 GitLab Discussion，避免重复评论。

### 第三批：功能深化

- [x] **Finding 页内高亮**：在 GitLab Diff 页面上标注 Finding 位置。
- [x] **批量发布**：勾选多个 Finding → 一次性预览 → 批量创建 Discussion。
- [x] **Hunk Review**：按 diff hunk 粒度 Review。
- [x] **Commit / Branch Review**：对 commit 或 branch diff 做 Review。
- [ ] **评测集 + 基准脚本**：典型 MR fixture，量化定位成功率/精确率。

### 低优先级（待定）

- Finding 筛选排序 UI。
- 聊天历史持久化。
- Review 会话历史浏览。
- 键盘快捷键。
- 错误恢复 / 离线状态。
- 多语言 Prompt 适配。
- MR 页面内嵌摘要。

## 4. 不做的事

以下能力**明确不在范围内**，因为需要服务端或本地进程：

| 不做 | 原因 |
|------|------|
| **本地 Agent Gateway** | 需要用户本地跑服务进程，架构上无 server/local 之分 |
| **CI Bot / 自动评论** | 需要服务端 webhook 监听 |
| **本地仓库 checkout / symbol_search / run_check** | 需要本地文件系统访问 |
| **IDE 插件** | 需要 VSCode/JetBrains 扩展宿主 |
| **多平台适配（Gitea/Codeup/Bitbucket）** | 优先做好 GitLab |
| **多用户远程 / 公网部署** | 超出用户脚本范畴 |
| **自动修复与提交代码** | 安全风险高，不在用户脚本内实现 |
| **团队规则管理后台 / 审计日志** | 需要服务端存储 |

## 5. 交付节奏

每周固定产出：

- 可运行构建。
- 自动化测试结果。
- 当前能力、风险更新。

## 6. 风险登记

| 风险 | 概率 | 影响 | 应对 |
| --- | --- | --- | --- |
| GitLab DOM 频繁变化 | 高 | 中 | API 优先、适配器、fixture 回归 |
| 自部署版本 API 差异 | 高 | 高 | 能力探测、降级 |
| 浏览器密钥泄漏 | 中 | 高 | 混淆存储、最小权限、明确警告 |
| 模型评论噪声 | 高 | 高 | Finding Schema、置信过滤、反思 |
| 评论行号漂移 | 高 | 高 | diff_refs、existingCode 锚定 |
| 大 MR 卡顿 | 中 | 高 | 并行加载、窗口化渲染 |

## 7. Definition of Done

每个功能完成需满足：

- 有 TypeScript 类型和 schema 校验。
- 有单元测试；E2E 覆盖关键路径。
- UI 有 loading / empty / error / disabled 状态。
- 有日志脱敏，不含 token。
- `pnpm typecheck`、`pnpm test:unit`、`pnpm test:e2e`、`pnpm build` 通过。
