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
pnpm test:unit        # 单元测试（151 个）
pnpm test:e2e         # Playwright E2E（3 个）
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
│   ├── review-engine.ts    # Review 引擎主入口
│   ├── rules.ts            # 规则模式入口（委托 rule-packs）
│   ├── rule-packs.ts       # 规则包系统（schema、评估、存储）
│   ├── selection.ts        # 代码选区捕获
│   ├── session.ts          # Review 会话持久化
│   ├── settings.ts         # 设置存储（含密钥混淆）
│   ├── capabilities.ts     # 能力探测、DOM 降级、日志脱敏
│   ├── usage.ts            # Token/成本统计
│   ├── model-runtime.ts    # 统一模型接口 + 工厂
│   ├── openai-runtime.ts   # OpenAI-compatible 运行时
│   ├── anthropic-runtime.ts# Anthropic 运行时
│   ├── gemini-runtime.ts   # Gemini 运行时
│   ├── agent-tools.ts      # Agent 工具定义 + 执行器
│   ├── agent-loop.ts       # Agent 工具循环编排
│   └── mcp-client.ts       # MCP 客户端（Streamable HTTP）
├── components/
│   ├── Markdown.tsx        # 轻量 Markdown 渲染器
│   ├── review/
│   │   ├── FindingCard.tsx # Finding 卡片组件
│   │   └── SelectionToolbar.tsx # 选区工具栏
│   ├── assistant-ui/       # assistant-ui 组件（原型用）
│   └── ui/                 # 基础 UI 组件
├── App.tsx                 # 主应用组件（侧栏、聊天、Review、设置）
├── main.tsx                # 油猴脚本入口
└── index.css               # 全局样式

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
Diff → Context Builder → Model/Rule Runner → Finding 归一化
  → existingCode 锚定 → 证据检查/严重度校准/相似合并
  → 去重 → 置信度过滤 → Draft → User Confirm → Publish
```

### Provider 抽象
- `ModelRuntime` 接口：`configured` / `chat` / `review` / `testConnection` / `callWithTools`
- `createModelRuntime(settings)` 工厂按 `settings.provider` 选择实现
- 各 Provider 保持独立文件，API 差异不泄漏到业务层

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
- 现有 151 个单元测试 + 3 个 E2E 不能减少

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
