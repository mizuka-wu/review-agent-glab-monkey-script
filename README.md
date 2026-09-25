# Review Agent for GitLab

一个面向 GitLab / 自部署 GitLab 的油猴脚本产品原型。它把代码评审能力放进现有 Merge Request 页面，支持划词提问、选中代码 Review、整份 MR Review、结构化问题草稿和确认后发布评论。

> 当前仓库处于 **开发计划 + 交互原型** 阶段。`dist/` 中的脚本还没有生产级 GitLab 适配、Agent Gateway 或评论发布能力，不应直接安装到日常工作流。

## 产品目标

- 在 GitLab MR / Diff / File 页面中无侵入地唤起 Review Agent。
- 选中代码后直接提问，或以选中片段为焦点发起局部 Review。
- 整体分析 MR，给出可定位、可解释、可复核的结构化问题草稿。
- 所有写入 GitLab 的评论默认由用户逐条确认，不默认自动发布。
- 同一套前端可连接纯浏览器模型服务，也可连接本地 Agent Gateway 获取仓库级上下文。

## 与 OpenCodeReview 的关系

本项目参考 [alibaba/open-code-review](https://github.com/alibaba/open-code-review) 的产品思路，重点吸收以下设计原则：

- 确定性工程负责文件选择、上下文裁剪、规则匹配和评论定位；Agent 负责动态取上下文和判断。
- Review 输出使用结构化 Finding，而不是无法复核的自然语言长文。
- 精确定位与内容反思是独立步骤，避免行号漂移和无效评论。
- 默认优先精确率，控制噪声；高召回模式后续可选。

本项目不复制其 Go CLI 实现，也不试图在浏览器里复刻 Git、构建、测试和完整 Agent Runtime。浏览器、GitLab API、本地 Gateway 的职责边界见 [能力边界](docs/01-capability-boundary.md)。

## 三种运行形态

| 形态 | 能做什么 | 限制 | 规划阶段 |
| --- | --- | --- | --- |
| 浏览器直连 | 划词问答、页面上下文、当前 MR Diff、浅层 Review、评论草稿 | 受 CORS / token / 页面结构 / 上下文窗口限制 | M1-M2 |
| 本地 Agent Gateway（推荐） | 仓库级搜索、全文件读取、规则匹配、工具调用、长任务、流式状态 | 需要本地服务和项目映射配置 | M3-M4 |
| GitLab CI Bot（后续） | 无人值守 MR Review、幂等评论、流水线门禁 | 需要 Runner、服务账号和运维配置 | M5+ |

## 交互原型

原型模拟了一个 GitLab MR 页面和 Review Agent 侧栏，覆盖以下状态：

- 划词后出现“提问 / Review 这段”悬浮工具栏。
- Chatbox 可携带选中片段上下文继续对话。
- 触发 Review 后展示阶段、工具调用和结构化 Finding。
- Finding 可定位、复制评论草稿，并在二次确认后模拟发布到 GitLab。
- 设置页展示浏览器、GitLab API、本地 Gateway 的连接状态和能力边界。

本地运行：

```bash
pnpm install
pnpm dev
```

构建检查：

```bash
pnpm build
```

详细交互见 [UX 流程与原型说明](docs/04-ux-flows-and-prototype.md)。

## GitHub 自动化

- `CI`：每次 push / PR 自动执行 TypeScript 检查和油猴脚本构建，并上传 14 天构建产物。
- `Release`：推送 `v*` tag 或手动触发时，自动生成包含 `.user.js`、文档和 `SHA256SUMS` 的 GitHub Release。
- `Publish prototype docs`：推送 `main` 时自动发布安装入口和开发文档到 GitHub Pages。

发布新版本：

```bash
pnpm version 0.1.1
git push --follow-tags
```

## 文档索引

1. [产品需求与范围](docs/00-product-brief.md)
2. [能力边界：浏览器、GitLab API、本地支持](docs/01-capability-boundary.md)
3. [系统架构与数据模型](docs/02-architecture.md)
4. [开发计划与里程碑](docs/03-development-plan.md)
5. [UX 流程与原型说明](docs/04-ux-flows-and-prototype.md)
6. [GitLab / 自部署 GitLab 接入](docs/05-gitlab-integration.md)
7. [本地 Agent Gateway 协议草案](docs/06-agent-gateway-contract.md)
8. [安全、隐私与密钥治理](docs/07-security-privacy.md)
9. [测试、验收与发布](docs/08-testing-acceptance.md)
10. [P0 Review Engine 开发计划](docs/09-p0-review-engine-plan.md)

## 仓库结构

```text
.
├── docs/                       # 产品、架构、接口、排期、安全与测试计划
├── src/
│   ├── prototype/              # 交互原型 UI 与模拟数据
│   ├── components/             # 可复用 UI 基础组件
│   └── main.tsx                # 原型入口；后续替换为油猴宿主入口
├── vite.config.ts              # Vite + vite-plugin-monkey 构建配置
└── package.json
```

## 当前决策

- **Draft first**：AI 只生成评论草稿，用户确认后才写入 GitLab。
- **Gateway 不持有 GitLab 写权限**：MVP 中由浏览器会话或用户显式配置的 PAT 负责 GitLab 读写，Gateway 专注模型和仓库工具。
- **能力探测优先于站点猜测**：自部署站点通过 API / DOM 能力探测选择适配器，不按域名硬编码。
- **原型只演示状态与流程**：原型不发网络请求、不读取真实代码、不调用模型。

## License

待确定。参考项目为 Apache-2.0，本仓库在引入第三方代码前需要先完成许可证选择和依赖兼容性检查。
