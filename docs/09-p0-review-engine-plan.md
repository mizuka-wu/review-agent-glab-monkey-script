# P0 Review Engine 开发计划

## 1. 目标

先把浏览器端 Review 引擎做成可重复、可验证的 P0 能力。此阶段不实现本地 Agent Gateway、仓库级工具执行和 CI Bot；这些能力延后到 P1/P2。

P0 链路：

```text
GitLab MR / Diff
  -> Context Builder
  -> Model / Deterministic Rule Runner
  -> Finding Schema Normalization
  -> Existing Code Anchor
  -> Dedupe + Confidence Filter
  -> Draft Review
  -> Confirmed GitLab Discussion Publish
```

## 2. P0 必须交付

### Review Engine

- [x] Context Builder：Diff 文件过滤、lockfile / generated / secret / binary 排除。
- [x] 字符预算截断和省略原因记录。
- [x] 选区转换为合成 Diff，支持局部 Review。
- [x] 统一 Model / Rule 运行入口。
- [x] Finding Schema 归一化、分类和严重度校验。
- [x] `existingCode` 多行锚定、旧/新侧行号推断。
- [x] 无法定位的 Finding 不进入发布队列。
- [x] 指纹去重、置信度过滤和严重度排序。
- [x] 模型调用超时、取消和 408 / 429 / 5xx 重试。

### GitLab 发布可靠性

- [x] Diff / Discussion 分页读取。
- [x] 发布前校验 `head_sha`，过期返回 `stale_diff_refs`。
- [x] 相同评论幂等去重，不重复创建 Discussion。
- [x] 新增 / 删除 / rename 的 old/new path payload 支持。
- [x] 多行位置生成 `line_range` payload。

### 验证

- [x] Context Builder、锚定、Review Engine 单元测试。
- [x] GitLab Adapter 分页、幂等和 stale diff 测试。
- [x] 保留既有 URL、Diff、Finding、规则和 E2E 测试。
- [x] `pnpm typecheck`、`pnpm test:unit`、`pnpm build` 作为合并门禁。

## 3. P0 不包含

- 本地 Agent Gateway / 本地仓库 checkout。
- `file_read`、`code_search`、`symbol_search` 等 Agent 工具循环。
- MCP、Anthropic、Gemini、Bedrock、Azure Provider。
- Full-file scan、branch / commit review、resume session。
- GitLab CI Bot 和自动评论。
- 精确率评测集和大规模模型质量回归。

## 4. 验收标准

1. 对一个包含多个文件的 MR，Review 只接收可审查文件，并在 UI / 结果中报告省略文件和原因。
2. 模型返回 `existingCode` 时，Finding 能映射到 Diff 的新旧侧行号；映射失败则丢弃而不是猜测。
3. 同一 MR、同一 Finding 和同一评论内容重复执行，不会创建重复 Discussion。
4. MR 更新后，使用旧 `diff_refs` 发布必须失败并显示 `stale_diff_refs`。
5. 模型服务 429 / 5xx 会自动重试，取消后立即终止且不会发布临时结果。

## 5. 后续顺序

1. **P1**：完整文件读取、跨文件 relocation、Session / Manifest / Resume、Finding 编辑和规则包。
2. **P2**：Agent tool loop、MCP、多 Provider、CI Bot。
3. **P3**：Gateway、IDE 插件和团队化能力。

本地 Gateway 仍然重要，但不阻塞 P0 浏览器 Review 引擎。P0 的接口保留 `ReviewRuntime` 抽象，未来 Gateway 可以在不改 Finding Pipeline 和发布层的情况下替换 `OpenAIRuntime`。
