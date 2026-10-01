# Review Agent for GitLab

[![Release](https://img.shields.io/github/v/release/mizuka-wu/review-agent-glab-monkey-script)](https://github.com/mizuka-wu/review-agent-glab-monkey-script/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/mizuka-wu/review-agent-glab-monkey-script/ci.yml?branch=main)](https://github.com/mizuka-wu/review-agent-glab-monkey-script/actions/workflows/ci.yml) [![Docs](https://img.shields.io/badge/docs-VitePress-blue)](https://mizuka-wu.github.io/review-agent-glab-monkey-script/)

一个面向 GitLab / 自部署 GitLab 的油猴脚本（Tampermonkey Userscript），在 MR / Diff / File 页面中提供代码评审能力。采用与 [OpenCodeReview](https://github.com/alibaba/open-code-review) 相同的**确定性规则 + LLM 混合架构**：规则检查永远在浏览器本地运行（无需 API Key、零 token），配置模型后叠加 AI 深度评审，两类结果分开标注、命中同一处问题时自动合并。支持划词提问、结构化 Finding 草稿、批量发布 GitLab Discussion。

## 核心特性

### 🧩 混合评审（无需 API Key 也能用）
- **规则阶段恒运行**：24 条内置确定性规则在浏览器本地执行，不联网、不消耗 token；未配置模型时 Review 依然可用
- **模型阶段可选**：`规则 + AI` / `仅规则` / `仅 AI` 三种模式；模型调用失败自动降级为规则结果
- **来源可区分**：每条 Finding 标注 `规则` / `AI` / `规则 + AI`（相互印证），可按来源筛选、分组查看，并展示命中的规则 id
- **未配置提示**：侧栏与设置页明确列出当前可用能力和缺少项，一键跳转配置

### 🤖 模型 Review
- **OpenAI 兼容接口**：官方端点、企业网关、本地代理均可；Bearer Token、API Key Header、Query Parameter、自定义 Header 四种认证模式（网关免鉴权时可不填 Key）
- **本地模型提示**：Base URL 旁「?」列出 omlx / Ollama / LM Studio 的默认端口与带 `/v1` 后缀的兼容地址，点击即填；localhost 端点自动拉取 `/v1/models` 列表；可用「关闭思考输出」开关抑制 omlx/vLLM 的思考过程泄漏
- **Agent 工具循环**：模型可主动调用 `file_read`、`search_code`、`git_log` 工具获取仓库上下文
- **MCP 扩展**：通过 Streamable HTTP 连接本地 MCP server，扩展工具能力
- **SSE 流式输出**：聊天逐 token 流式渲染；Review 模型阶段同样流式——思考通道（`reasoning_content`）以可折叠打字机呈现（默认折叠、实时字数），finding 随流式逐条增量进入结果列表，原始 JSON 默认折叠仅供排查；可随时「取消」停止；服务端不支持 SSE 时自动回退一次性读取；规则结果在规则阶段完成后立即先行渲染
- **三档审查强度**：fast（仅高置信）、balanced（默认）、thorough（全面）

### 📋 Review 引擎
- **规则包系统**：内置 24 条多语言规则（硬编码密钥、URL 凭据、SQL 注入、XSS、命令注入、TLS 校验关闭、弱哈希、可预测随机数、静态可变共享状态、Java `equals`、Kotlin `!!`、TS 非空断言、弱类型、吞异常、Go 丢弃 error、阻塞 sleep、跳过测试、调试输出、内网地址、TODO、冲突标记、缺少测试），按语言与 glob 路径作用域匹配、跳过注释行、单文件命中上限；支持自定义规则包（regex、作用域、语言、JSON 导入导出、逐条开关），并按 **公共 / 当前项目** 两种作用域分别存储、动态加载，项目自定义包覆盖同 id 公共包
- **Context Builder**：Diff 文件过滤（lockfile/生成文件/密钥/二进制排除）、字符预算截断、省略原因记录
- **Finding 锚定**：`existingCode` 多行精确匹配、旧/新侧行号推断、跨文件重定位
- **Review 硬化**：证据充分度检查、严重度校准、同源相似 Finding 合并、跨来源印证合并、置信度过滤（仅作用于 AI 结果）
- **幂等发布**：指纹去重、`head_sha` 校验、`stale_diff_refs` 检测、Discussion 同步
- **评测基准**：8 个 fixture，检测率 ≥ 80%、精确率 ≥ 70%、安全类 100%、干净代码 0 误报

### 🎯 Finding 管理
- **完整生命周期**：草稿 → 编辑 → 定位 → 复制 → 发布 / 忽略
- **页内高亮**：在 GitLab Diff 页面上标注 Finding 位置，severity 色标
- **批量发布**：复选框多选 → 预览确认 → 逐条创建 Discussion
- **快速操作**：一键 Approve、一键行内评论（全部可发布草稿）、发布 MR 总评论；均为两步确认防误触
- **筛选排序**：按来源/严重度/分类/状态过滤，按严重度/来源/文件排序
- **Session/Resume**：刷新页面后恢复上次 Review 会话

### 🔎 仓库索引（符号搜索 / 调用链）
- **本地符号表**：GitLab REST 没有符号级 API，脚本把仓库文件缓存到浏览器 OPFS（[opfs-worker](https://github.com/kachurun/opfs-worker)，独立 Worker → 主线程 → 内存三级回退），构建符号表
- **符号搜索**：按标识符边界搜索定义与引用/调用点，比关键词搜索精确
- **调用链**：启发式向上追溯「谁调用了它、调用者又被谁调用」，评估改动影响面
- **Agent 工具**：索引就绪后对话/Review 的 Agent 可调用 `symbol_search`、`call_chain`
- **Review 仓库上下文**：把「变更文件定义了哪些符号、被 Diff 外谁调用」注入模型提示词
- **索引管理**：每个 branch / commit 的索引独立保存（注册表记录 ref、分支名、文件数、体积、符号数），可载入、单份删除、全部清除；超过保留份数自动清理最旧；显示站点存储用量与配额
- **过期保护**：载入的索引与当前 head 不一致时明确告警，且不会把过期符号上下文注入 Review 提示词
- **缓存复用**：同 head ref 直接恢复本地索引，零网络开销；文件数 / 单份体积 / 保留份数可配置

### 🐞 调试工具（设置中开启）
- **默认关闭**：在「设置 → 调试 → 显示调试标签页」打开；设置标签在有错误日志时会显示红点
- **四面板调试器**：日志 / 网络 / 提示词 / 状态，支持关键字过滤、级别过滤、自动滚动
- **网络面板**：GitLab API、模型调用、MCP、索引请求的方法、状态码、耗时、字节数
- **提示词面板**：每次模型调用的完整 system、消息内容、工具列表、token 用量与响应摘要
- **console 镜像**：页面 `console.warn/error` 自动进入日志；日志跨刷新保留
- **一键导出**：复制并下载 JSON 调试包（含脱敏设置快照），便于提 issue 排查

### 🛠 自部署兼容
- **能力探测**：认证模式、API 版本、搜索、CSRF、DOM 可用性自动检测
- **DOM 降级**：API 不可用时从页面 DOM 解析 Diff
- **诊断面板**：实时显示 GitLab 实例状态和兼容性警告
- **配置导出**：脱敏导出站点配置到剪贴板
- **日志脱敏**：自动过滤 Bearer token、API key、PAT 等敏感信息

### ⚡ 性能
- **并行加载**：Diff 分页并发请求（3 路并发）、完整文件并发读取（5 路并发）
- **分批渲染**：Finding 列表分批加载（每批 30 条）
- **轻量产物**：运行时仅依赖 React + lucide，油猴脚本约 1.16 MB（gzip 255 KB），Shadow DOM 隔离不污染 GitLab 样式
- **大 MR 支持**：500 文件 / 20k 行不阻塞 GitLab 页面

### 🔒 安全
- **密钥混淆存储**：API Key / GitLab PAT 使用 XOR + base64 混淆后存储，不明文暴露
- **Draft first**：所有评论默认草稿，用户确认后才写入 GitLab
- **Token 用量统计**：自动解析 API 响应 `usage`，按模型展示用量和费用估算

### 💬 交互体验
- **Markdown 渲染**：代码块、表格、引用、有序/无序列表、行内代码、链接，XSS 安全
- **聊天持久化**：对话记录自动保存，刷新后恢复
- **键盘快捷键**：`Esc` 关闭弹窗、`Ctrl+Enter` 开始 Review、`Ctrl+K` 切换 Tab
- **离线检测**：网络断开时显示状态提示
- **多语言 Prompt**：按设置自动适配中文/英文系统提示词
- **Review 会话历史**：查看过往 Review 会话列表

## 安装

**一键安装（推荐）**：安装 [Tampermonkey](https://www.tampermonkey.net/) 后，直接打开
[review-agent-glab-monkey-script.user.js](https://github.com/mizuka-wu/review-agent-glab-monkey-script/releases/latest/download/review-agent-glab-monkey-script.user.js)
（GitHub Release 资产），Tampermonkey 会弹出安装页确认安装。

- **自动更新**：脚本内置 `@updateURL` 指向 Release 的 `.meta.js`，Tampermonkey 按 `@version` 检查并提示更新；发版由 `v*` tag 触发的 Release workflow 自动上传资产。
- **边缘通道**：GitHub Pages 在每次 main 构建后发布同一产物，适合跟最新开发版：
  `https://mizuka-wu.github.io/review-agent-glab-monkey-script/review-agent-glab-monkey-script.user.js`
- **自构建**：`pnpm build` 后安装 `dist/review-agent-glab-monkey-script.user.js`；开发模式见下文。
- 脚本 `@match` 覆盖全部 http(s) 页面（以支持任意自部署 GitLab 域名），但只在识别到 GitLab 页面时挂载 UI。

安装后打开任意 GitLab MR / Diff / File 页面，点击右下角浮动按钮打开 Review Agent。

不配置 API Key 也可以直接使用规则检查、划词定位、Finding 编辑和评论草稿复制；
在「设置」中填写 OpenAI 兼容的 Base URL / 模型 / API Key 后即可叠加 AI 评审与对话。

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式（自动构建 + 热更新）
pnpm dev
# 在 Tampermonkey 中安装开发版（注意是 /dist/ 路径，根路径 .user.js 为 404）：
#   http://127.0.0.1:5173/dist/review-agent-glab-monkey-script.user.js
# 之后改代码自动重建，Tampermonkey 自动更新

# 类型检查
pnpm typecheck

# 单元测试
pnpm test:unit

# E2E 测试
pnpm test:e2e

# 构建发布版油猴脚本
pnpm build

# 评测基准
EVAL_VERBOSE=1 npx vitest run tests/eval/
```

## 本地 GitLab 测试

```bash
# 启动 GitLab 容器（交互菜单）
./scripts/gitlab.sh

# 浏览器打开 http://127.0.0.1:8929 登录后创建 MR
# 然后运行 E2E：
GITLAB_URL=http://127.0.0.1:8929 \
GITLAB_MR_URL=http://127.0.0.1:8929/<项目>/-/merge_requests/<id>/diffs \
pnpm test:e2e

# 叠加真实本地模型的混合 Review（并指定登录凭据）：
GITLAB_URL=http://127.0.0.1:8929 \
GITLAB_MR_URL=http://127.0.0.1:8929/<项目>/-/merge_requests/<id>/diffs \
GITLAB_USER=root GITLAB_PASS=<密码> \
MODEL_BASE_URL=http://localhost:8000/v1 MODEL_NAME=qwen35-a3b \
pnpm test:e2e
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
| **规则包** | 内置规则 + 自定义规则包管理（导入/导出/启停）；作用域可切 公共 / 当前项目 |
| **MCP** | 连接本地 MCP server（Streamable HTTP） |
| **评审模式** | `规则 + AI` / `仅规则` / `仅 AI`；未配置模型时自动仅规则 |
| **思考输出** | 关闭后向 omlx/vLLM 发送 `enable_thinking=false`，避免思考文本混入结果 |
| **调试标签页** | 默认关闭；开启后显示 日志 / 网络 / 提示词 / 状态 四个 pane |
| **仓库索引** | 启用 OPFS 索引及文件数 / 单份体积 / 保留份数上限 |
| **仓库上下文** | 索引与 head 一致时，把 Diff 外调用点注入 Review 提示词 |

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
| 符号搜索 / 调用链 | ✅ | 无（需先建立索引） |
| 仓库上下文注入 Review | ✅ | 模型 API + 索引 |

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
Repo Index (OPFS · opfs-worker) → symbol_search / call_chain → Review 上下文
  ↓
Debug Bus (logs / network / prompts / state · 设置中开启)
  ↓
Finding Pipeline (normalize → anchor → harden → dedupe → filter)
  ↓
Draft → User Confirm → GitLab Discussion Publish
```

## 文档

在线阅读（VitePress 站点，GitHub Pages 托管）：<https://mizuka-wu.github.io/review-agent-glab-monkey-script/>

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
11. [与 OpenCodeReview 差距分析](docs/10-opencodereview-gap-analysis.md)

## 测试

- **203 个单元测试**：规则引擎、锚定、硬化、Provider、Agent 循环、MCP、能力探测、Markdown、安全存储、成本统计、仓库索引/符号表、调试总线
- **12 个 Playwright E2E**：8 个 mock 模式（规则 Review 发布、无 Key 规则 Review、选区对话、仓库索引+符号搜索、快速操作、流式输出、运行中停止、元数据）+ 4 个真实 GitLab 模式（注入读 MR、规则 Review、真实本地模型混合 Review、仓库索引/符号/注册表管理）；真实模式需设置 `GITLAB_URL` + `GITLAB_MR_URL`，可选 `MODEL_BASE_URL` / `MODEL_NAME` / `GITLAB_USER` / `GITLAB_PASS`
- **8 个评测 fixture**：安全/调试日志/弱类型/缺少测试/干净代码/多文件/性能/密钥泄漏
- **合并门禁**：`pnpm typecheck` + `pnpm test:unit` + `pnpm test:e2e` + `pnpm build`

## License

[MIT](LICENSE)
