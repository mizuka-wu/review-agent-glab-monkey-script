# Review Agent for GitLab

一个面向 GitLab / 自部署 GitLab 的油猴脚本（Tampermonkey Userscript），在 MR / Diff / File 页面中提供 AI 代码评审能力。支持划词提问、规则/模型 Review、结构化 Finding 草稿、批量发布 GitLab Discussion。

## 核心特性

### 🤖 模型 Review
- **多 Provider**：OpenAI-compatible、Anthropic、Google Gemini，一键切换
- **企业网关认证**：Bearer Token、API Key Header、Query Parameter、自定义 Header 四种模式
- **Agent 工具循环**：模型可主动调用 `file_read`、`search_code`、`git_log` 工具获取仓库上下文
- **MCP 扩展**：通过 Streamable HTTP 连接本地 MCP server，扩展工具能力
- **SSE 流式输出**：聊天逐 token 流式渲染
- **三档审查强度**：fast（仅高置信）、balanced（默认）、thorough（全面）

### 📋 Review 引擎
- **规则包系统**：内置 5 条规则（硬编码密钥、调试日志、弱类型、TODO、缺少测试），支持自定义规则包（regex 匹配、glob 路径作用域、JSON 导入导出）
- **Context Builder**：Diff 文件过滤（lockfile/生成文件/密钥/二进制排除）、字符预算截断、省略原因记录
- **Finding 锚定**：`existingCode` 多行精确匹配、旧/新侧行号推断、跨文件重定位
- **Review 硬化**：证据充分度检查、严重度校准、相似 Finding 合并、置信度过滤
- **幂等发布**：指纹去重、`head_sha` 校验、`stale_diff_refs` 检测、Discussion 同步
- **评测基准**：8 个 fixture，检测率 ≥ 80%、精确率 ≥ 70%、安全类 100%、干净代码 0 误报

### 🎯 Finding 管理
- **完整生命周期**：草稿 → 编辑 → 定位 → 复制 → 发布 / 忽略
- **页内高亮**：在 GitLab Diff 页面上标注 Finding 位置，severity 色标
- **批量发布**：复选框多选 → 预览确认 → 逐条创建 Discussion
- **筛选排序**：按严重度/分类/状态过滤，按严重度/行号/文件排序
- **Session/Resume**：刷新页面后恢复上次 Review 会话

### 🛠 自部署兼容
- **能力探测**：认证模式、API 版本、搜索、CSRF、DOM 可用性自动检测
- **DOM 降级**：API 不可用时从页面 DOM 解析 Diff
- **诊断面板**：实时显示 GitLab 实例状态和兼容性警告
- **配置导出**：脱敏导出站点配置到剪贴板
- **日志脱敏**：自动过滤 Bearer token、API key、PAT 等敏感信息

### ⚡ 性能
- **并行加载**：Diff 分页并发请求（3 路并发）、完整文件并发读取（5 路并发）
- **窗口化渲染**：Finding 列表分批加载（每批 20 条）
- **大 MR 支持**：500 文件 / 20k 行不阻塞 GitLab 页面

### 🔒 安全
- **密钥混淆存储**：API Key / GitLab PAT 使用 XOR + base64 混淆后存储，不明文暴露
- **Draft first**：所有评论默认草稿，用户确认后才写入 GitLab
- **Token 用量统计**：自动解析 API 响应 `usage`，按模型展示用量和费用估算

### 💬 交互体验
- **Markdown 渲染**：代码块、粗体、斜体、列表、链接，XSS 安全
- **聊天持久化**：对话记录自动保存，刷新后恢复
- **键盘快捷键**：`Esc` 关闭弹窗、`Ctrl+Enter` 开始 Review、`Ctrl+K` 切换 Tab
- **离线检测**：网络断开时显示状态提示
- **多语言 Prompt**：按设置自动适配中文/英文系统提示词
- **Review 会话历史**：查看过往 Review 会话列表

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 打开 `dist/review-agent-glab-monkey-script.user.js` 或从 [Release](../../releases) 下载
3. 在 Tampermonkey 中导入安装
4. 打开任意 GitLab MR 页面，点击右下角浮动按钮打开 Review Agent

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式（原型页面）
pnpm dev

# 类型检查
pnpm typecheck

# 单元测试（151 个）
pnpm test:unit

# E2E 测试（Playwright，3 个）
pnpm test:e2e

# 构建油猴脚本
pnpm build

# 评测基准（verbose）
EVAL_VERBOSE=1 npx vitest run tests/eval/
```

## 配置

在侧栏「设置」中配置：

| 配置项 | 说明 |
|--------|------|
| **模型提供商** | OpenAI / Anthropic / Gemini，选择后自动填充默认 URL 和模型 |
| **Base URL** | 模型 API 地址，支持自部署/企业网关 |
| **API Key** | 模型密钥（混淆存储，不明文保存） |
| **认证模式** | Bearer / API Key Header / Query Param / 自定义 Header |
| **GitLab PAT** | 可选，用于跨域 API 访问 |
| **审查强度** | fast / balanced / thorough |
| **输出语言** | 简体中文 / English |
| **规则包** | 内置规则 + 自定义规则包管理（导入/导出/启停） |
| **MCP** | 连接本地 MCP server（Streamable HTTP） |

## 工具与能力矩阵

| 能力 | 浏览器直连 | 需要配置 |
|------|-----------|---------|
| 划词提问 | ✅ | 模型 API |
| 选区 Review | ✅ | 模型 API |
| MR 全量 Review | ✅ | 模型 API |
| Commit Review | ✅ | 模型 API |
| 规则 Review | ✅ | 无需 |
| Finding 发布 | ✅ | GitLab 同源/PAT |
| Agent 工具循环 | ✅ | 模型 API |
| MCP 工具扩展 | ✅ | MCP server |
| 完整文件上下文 | ✅ | 模型 API |
| 跨文件重定位 | ✅ | 模型 API |
| 能力探测/诊断 | ✅ | 无 |
| Token 成本统计 | ✅ | 模型 API |

## 架构

```
GitLab 页面 (MR / Diff / File / Commit)
  ↓ DOM + URL + Selection
Userscript Host (Shadow DOM · SPA 路由 · 侧栏)
  ↓
GitLab Adapter ─── Context Builder ─── Review UI
  ↓                   ↓                    ↓
Model Runtime (OpenAI / Anthropic / Gemini)
  ↓
Agent Tool Loop (file_read / search_code / git_log) + MCP
  ↓
Finding Pipeline (normalize → anchor → harden → dedupe → filter)
  ↓
Draft → User Confirm → GitLab Discussion Publish
```

## 文档

1. [产品需求与范围](docs/00-product-brief.md)
2. [能力边界](docs/01-capability-boundary.md)
3. [系统架构](docs/02-architecture.md)
4. [开发计划](docs/03-development-plan.md)
5. [UX 流程](docs/04-ux-flows-and-prototype.md)
6. [GitLab 接入](docs/05-gitlab-integration.md)
7. [Agent Gateway 协议](docs/06-agent-gateway-contract.md)（规划中，未实现）
8. [安全与隐私](docs/07-security-privacy.md)
9. [测试与验收](docs/08-testing-acceptance.md)
10. [Review Engine 计划](docs/09-p0-review-engine-plan.md)

## 测试

- **151 个单元测试**：规则引擎、锚定、硬化、Provider、Agent 循环、MCP、能力探测、Markdown、安全存储、成本统计
- **3 个 Playwright E2E**：规则 Review 发布流程、选区模型调用、元数据验证
- **8 个评测 fixture**：安全/调试日志/弱类型/缺少测试/干净代码/多文件/性能/密钥泄漏
- **合并门禁**：`pnpm typecheck` + `pnpm test:unit` + `pnpm test:e2e` + `pnpm build`

## License

待确定。
