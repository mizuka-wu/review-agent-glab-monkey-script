# AGENTS.md — AI Agent 开发指南

## 项目概述

**review-agent-glab-monkey-script** — Tampermonkey 油猴脚本，在 GitLab MR 页面提供 AI 代码评审能力。

- **技术栈**：TypeScript + React + Vite + vite-plugin-monkey
- **测试**：Vitest（单元）+ Playwright（E2E）
- **构建产物**：`dist/review-agent-glab-monkey-script.user.js`
- **运行环境**：浏览器（Tampermonkey），无服务端

## 快速命令

```bash
pnpm typecheck        # TypeScript 类型检查
pnpm test:unit        # 单元测试（190 个）
pnpm test:e2e         # Playwright E2E（mock 5 个 + 真实 GitLab 2 个，需环境变量）
pnpm build            # 构建油猴脚本（含 typecheck）
pnpm dev              # 开发模式（原型页面）
EVAL_VERBOSE=1 npx vitest run tests/eval/  # 评测基准报告
```

**合并门禁**：以上全部通过才能合并。

## 架构

```
src/
├── core/                   # 核心业务逻辑（纯 TypeScript，不依赖 React）
│   ├── types.ts            # 全局类型定义
│   ├── gitlab-url.ts       # GitLab URL 解析
│   ├── gitlab-adapter.ts   # GitLab REST API 封装
│   ├── diff.ts             # Diff 解析、hunk 提取、上下文构建
│   ├── context.ts          # Review 上下文构建（预算、过滤、分组）
│   ├── full-file.ts        # 完整文件读取（并发、预算）
│   ├── anchor.ts           # Finding 行号锚定
│   ├── findings.ts         # Finding 归一化、指纹
│   ├── finding-edit.ts     # Finding 编辑
│   ├── finding-hardening.ts# 证据检查、严重度校准、相似合并
│   ├── finding-highlight.ts# 页内高亮
│   ├── debug-bus.ts        # 调试总线（日志/网络/提示词/快照，跨刷新保留）
│   ├── http.ts             # GM.xmlHttpRequest 优先的传输层（绕 CSP/CORS）
│   ├── repo-store.ts       # OPFS 缓存层（opfs-worker → 主线程 → 内存）
│   ├── repo-index.ts       # 仓库索引编排（tree + raw 拉取、符号表、缓存恢复）
│   ├── symbols.ts          # 启发式符号抽取 / 搜索 / 调用链
│   ├── review-engine.ts    # Review 引擎主入口（规则恒运行 + 模型可选）
│   ├── rules.ts            # 规则模式入口（委托 rule-packs）
│   ├── rule-packs.ts       # 规则包系统（schema、语言/路径作用域、评估、存储）
│   ├── selection.ts        # 代码选区捕获
│   ├── session.ts          # Review 会话持久化
│   ├── settings.ts         # 设置存储（含密钥混淆）
│   ├── capabilities.ts     # 能力探测、DOM 降级、日志脱敏
│   ├── usage.ts            # Token/成本统计
│   ├── model-runtime.ts    # 统一模型接口 + 工厂（OpenAI-compatible）
│   ├── openai-runtime.ts   # OpenAI-compatible 运行时（流式、重试、用量）
│   ├── agent-tools.ts      # Agent 工具定义 + 执行器
│   ├── agent-loop.ts       # Agent 工具循环编排
│   └── mcp-client.ts       # MCP 客户端（Streamable HTTP）
├── components/
│   ├── Markdown.tsx        # 轻量 Markdown 渲染器（导出 renderMarkdown 供测试）
│   ├── ChatThread.tsx      # 自包含流式聊天（附件、工具轨迹、未配置提示）
│   ├── SettingsView.tsx    # 能力总览 + 模型/审查/GitLab/规则包/MCP 设置
│   ├── DebugPanel.tsx      # 调试器：日志/网络/提示词/状态四面板 + 导出
│   ├── review/
│   │   ├── FindingCard.tsx     # Finding 卡片（来源徽标、编辑、发布）
│   │   ├── FindingsPanel.tsx   # 结果列表（来源分组、筛选、批量发布条）
│   │   ├── PublishDialog.tsx   # 单条 / 批量发布确认弹窗
│   │   ├── RepoPanel.tsx       # 仓库索引：状态、符号搜索、调用链
│   │   └── SelectionToolbar.tsx# 选区工具栏
│   └── ui/modern.tsx       # 设计系统（Card/Btn/Banner/Tabs/Pill/Segmented…）
├── App.tsx                 # 主应用组件（面板、标签页、Review/发布编排）
├── main.tsx                # 油猴脚本入口（Shadow DOM 注入）
└── index.css               # Shadow DOM 内的令牌与 Markdown/滚动条样式

tests/
├── unit/                   # 单元测试（与 src/core/ 一一对应）
├── eval/                   # 评测基准（fixtures + benchmark）
│   ├── fixtures.ts         # 8 个评测 fixture
│   ├── benchmark.ts        # 基准运行器
│   └── benchmark.test.ts   # 回归门禁测试
├── e2e/                    # Playwright E2E 测试
│   └── userscript.spec.ts  # 油猴脚本功能测试
└── setup.ts                # 测试环境配置
```

## 关键模式与约定

### 类型定义
- 所有类型集中在 `src/core/types.ts`
- 新增功能需要对应的 TypeScript 类型
- Finding 使用指纹（path + existingCode + category + title）实现幂等

### Review 引擎流程
```
Diff → Context Builder
  → 规则阶段（恒运行，本地） → 模型阶段（可选，失败降级）
  → 跨来源印证合并 → existingCode 锚定
  → 严重度校准/证据检查/同源相似合并 → 强度过滤（仅 AI 结果）
  → Draft → User Confirm → Publish
```

Finding 的 `source`（rule/model）与 `corroborated` 决定 UI 的来源徽标与分组；
规则 Finding 额外携带 `ruleId` / `rulePackId` / `rulePackName`，便于用户溯源和关闭噪声规则。

### Provider 抽象
- `ModelRuntime` 接口：`configured` / `chat` / `review` / `testConnection` / `callWithTools`
- 统一走 OpenAI-compatible 协议；`settings.provider` 只用于 Base URL / 模型预设
- `configured` 由 `core/settings.ts#isModelConfigured` 判定：官方 OpenAI 端点强制 API Key，企业网关允许免鉴权

### 存储
- Settings: `review-agent-settings-v1`（GM.getValue / localStorage）
- Rule Packs: `review-agent-rule-packs-v1`
- Sessions: `review-agent-review-sessions-v1`
- Usage: `review-agent-usage-v1`
- Chat: `review-agent-chat-v1`
- 密钥使用 XOR + base64 混淆后存储

### 测试规范
- 单元测试放在 `tests/unit/`，命名 `*.test.ts`
- 评测测试放在 `tests/eval/`
- E2E 测试放在 `tests/e2e/`
- 新功能必须有对应测试
- 现有 190 个单元测试 + 7 个 E2E 不能减少

### 代码风格
- 不写注释（除非 WHY 不明显）
- 不做防御性编程（信任内部代码和框架）
- 优先编辑现有文件，不新建抽象层
- `pnpm typecheck` 必须通过

## 常见任务

### 添加新 Provider
1. 创建 `src/core/xxx-runtime.ts`，实现 `ModelRuntime` 接口
2. 在 `src/core/model-runtime.ts` 工厂中注册
3. 在 `src/core/settings.ts` 的 `providerPresets` 中添加默认值
4. 在 `src/core/types.ts` 的 `ModelProvider` 中添加类型
5. 添加 `tests/unit/` 测试

### 添加新规则
1. 在 `src/core/rule-packs.ts` 的 `builtInRules` 中添加 `RuleDef`
2. 或通过 UI 创建自定义规则包
3. 在 `tests/eval/fixtures.ts` 中添加评测 fixture
4. 确保 `pnpm test:unit` 通过

### 添加调试埋点
1. core 模块直接 `import { debugBus } from './debug-bus'`
2. 请求类用 `debugBus.network({...})`，模型调用用 `debugBus.prompt({...})`，其余用 `debugBus.log(level, source, message, detail?)`
3. 需要出现在「状态」面板的数据用 `debugBus.registerSnapshot(() => ({...}))` 注册（记得脱敏）
4. UI 侧不要自己维护日志 state，DebugPanel 直接订阅 debugBus

### 修改 Finding 流程
1. 类型定义在 `src/core/types.ts`
2. 归一化在 `src/core/findings.ts`
3. 锚定在 `src/core/anchor.ts`
4. 硬化在 `src/core/finding-hardening.ts`
5. 渲染在 `src/components/review/FindingCard.tsx`

## 不做的事

以下能力**不在范围内**（需要服务端或本地进程）：
- 本地 Agent Gateway
- CI Bot / 自动评论
- 本地仓库 checkout / symbol_search / run_check
- IDE 插件
- 多平台适配（Gitea/Codeup/Bitbucket）

## 文档

| 文档 | 内容 |
|------|------|
| `README.md` | 功能总览、安装、配置 |
| `docs/03-development-plan.md` | 开发计划与任务状态 |
| `docs/02-architecture.md` | 系统架构与数据模型 |
| `docs/09-p0-review-engine-plan.md` | Review Engine 详细设计 |
| `docs/07-security-privacy.md` | 安全与隐私设计 |
| `docs/10-opencodereview-gap-analysis.md` | 与 OpenCodeReview 的差距分析与对齐记录 |
