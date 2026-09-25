# 测试、验收与发布

## 1. 测试策略

```text
单元测试：URL、Diff、Context、Finding、位置、状态机
    ↓
契约测试：GitLab REST、Agent Runtime、Gateway SSE
    ↓
组件测试：选择工具栏、Chatbox、Review、发布确认
    ↓
集成测试：浏览器脚本 + Mock GitLab / Mock Gateway
    ↓
E2E：GitLab 测试实例 + 浏览器扩展
    ↓
人工评测：真实 MR、模型质量、可用性、安全
```

## 2. 单元测试

### 平台解析

- GitLab.com、subgroup、URL-encoded path。
- MR overview / diffs / commits / notes hash。
- File / Blob / Raw / Tree 路由。
- 非 GitLab URL、无效 IID、缺 `/-/` 的兼容路径。

### Diff 与定位

- 新增、删除、修改、重命名、二进制、生成文件。
- 多 Hunk、空 Hunk、换行差异、CRLF。
- `existingCode` 唯一匹配、重复匹配、无匹配。
- 新旧 side 行号、跨多行 Finding。
- 过期 `diff_refs`。

### Context Builder

- 文件过滤和 lockfile 识别。
- 文件组包。
- token 预算截断和省略记录。
- 脱敏规则。
- 选区在 Hunk 边界的情况。

### Finding Pipeline

- Schema 校验与枚举归一化。
- 证据路径 / 行号验证。
- fingerprint 稳定性。
- 相似 Finding 去重。
- 严重度 / 置信度过滤。

### 状态机

- Review 各阶段合法转移。
- 取消、失败、重试。
- 未完成 / cancelled run 禁止发布。
- 发布成功 / 失败后的 Finding 状态。

## 3. 契约测试

### GitLab Adapter

使用录制 fixture 或 GitLab 测试实例，验证：

- request path、query、body encoding。
- Cookie / CSRF / PAT header。
- 分页、超时、AbortSignal。
- 401 / 403 / 404 / 409 / 422 / 429 错误映射。
- Discussion position payload。
- POST 幂等 reconciliation。

### Runtime

- DirectModelRuntime 的 SSE、tool call、取消。
- Gateway `AgentEvent` 序列化。
- 未知事件忽略。
- 断线游标恢复。
- requestId 冲突和重复运行。

## 4. 组件测试

建议 Vitest + Testing Library：

- SelectionToolbar 显示、翻转、键盘操作。
- Chatbox 附件、发送、流式、停止、错误。
- Review scope 选择、进度、取消。
- Finding 过滤、展开、编辑、忽略。
- 发布确认展示正确项目 / MR / path / line。
- 设置的连接测试和敏感输入掩码。

## 5. 端到端测试

### 测试环境

- GitLab CE Docker compose 固定版本。
- Mock Gateway，可模拟完成、慢速、工具调用、失败、取消。
- Mock OpenAI-compatible server，可返回结构化 Finding。
- Playwright + Chrome，Tampermonkey 手工验证。

### E2E 场景

1. 打开 MR，脚本注入侧栏。
2. 选中代码，出现工具栏。
3. 提问并收到流式回答。
4. 对选中代码 Review，出现 2 条 Finding。
5. 定位第二条，编辑草稿并复制。
6. 发布第一条到 GitLab，discussion 创建成功。
7. 重跑 Review，不重复发布。
8. MR 更新后发布旧 Finding，得到 `stale_diff_refs`。
9. 取消运行，发布按钮禁用。
10. API 权限不足时进入 `read-only` / `dom-only`。

## 6. 浏览器与脚本管理器矩阵

| 浏览器 | 脚本管理器 | 级别 |
| --- | --- | --- |
| Chrome / Edge 最新 2 个版本 | Tampermonkey | 必须 |
| Firefox ESR + 最新 | Tampermonkey | 必须 |
| Chrome / Edge | Violentmonkey | 应该 |
| Safari | Userscripts | 可选 |

## 7. GitLab 兼容矩阵

| 测试项 | GitLab.com | CE 16.x | CE 17.x | EE 当前版本 | 自定义主题 |
| --- | --- | --- | --- | --- | --- |
| MR 注入 | 必须 | 必须 | 必须 | 应该 | 应该 |
| API 读取 | 必须 | 必须 | 必须 | 应该 | 可选 |
| 划词 | 必须 | 必须 | 必须 | 应该 | 应该 |
| Finding 定位 | 必须 | 必须 | 必须 | 应该 | 可选 |
| Discussion 创建 | 必须 | 必须 | 必须 | 应该 | 可选 |

## 8. 性能测试

### 数据规模

- 小 MR：3 文件 / 100 行。
- 中 MR：20 文件 / 2000 行。
- 大 MR：500 文件 / 20000 行。
- 超大文件：单文件 > 10000 行。

### 预算

- 脚本注入到侧栏可交互 < 500ms。
- 选区事件到工具栏 < 50ms。
- 大 Diff 解析不阻塞主线程 > 100ms。
- 1000 条 Finding 虚拟列表滚动保持流畅。
- 流式回答每秒最多 20 次布局提交。

## 9. 模型质量评测

### 数据集

- 从内部或开源仓库收集 50-100 个真实 MR。
- 每个 MR 标注：已知缺陷、非缺陷、位置、严重度。
- 包含安全、并发、错误处理、性能、测试、API 兼容。

### 指标

- Precision：发布的 Finding 中真实问题比例。
- Recall：已知问题被发现比例。
- F1。
- Position accuracy：评论定位正确比例。
- Duplicate rate。
- Noise per MR。
- Token / latency / cost。

### 初始门槛

| 指标 | Balanced 最低值 |
| --- | --- |
| Precision | 0.80 |
| Position accuracy | 0.95 |
| Duplicate rate | < 0.05 |
| Critical 漏报 | 0（人工抽检） |

Thorough 模式可提高 Recall，但 Precision 不低于 0.75。

## 10. 可用性测试

5 名开发者完成任务：

- 不看文档完成划词提问。
- 从 Finding 发布一条评论。
- 理解 `read-only` / `dom-only` 的含义。
- 找到并移除模型 API Key。
- 取消一次 Review 并解释结果状态。

通过标准：80% 任务无引导完成，无严重误解写入行为。

## 11. 安全测试

- 恶意文件名、路径、Markdown、模型输出的 XSS fuzz。
- token 扫描：bundle、source map、日志、导出文件。
- 目标 origin / project / MR 混淆测试。
- Gateway 目录穿越、符号链接逃逸。
- 命令注入、参数注入、环境变量泄漏。
- 大 payload、压缩炸弹、超长流式输出。

## 12. 发布阶段

### Alpha

- 内部 GitLab。
- 只读发布策略，评论以复制为主。
- 记录脱敏诊断。

### Beta

- 支持 GitLab.com + 两个自部署版本。
- 开放评论发布，仍需二次确认。
- 收集性能、定位、模型质量数据。

### 1.0

- 完整 E2E、兼容矩阵、安全检查通过。
- 文档、安装、升级、卸载、故障排查完整。
- 依赖和许可证审查完成。
- 确认发布 / 回滚方案。

## 13. CI 门禁

每个 PR 必须通过：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm audit --audit-level=high
```

涉及 UI 的 PR 附截图；涉及 GitLab 的 PR 跑 contract test；涉及模型结果的 PR 更新评测摘要。

## 14. 发布物

- `.user.js`：带完整 metadata 的油猴脚本。
- `manifest.json`：版本、commit、构建时间、兼容范围。
- `checksums.txt`：发布文件校验和。
- `CHANGELOG.md`：功能、破坏性变化、已知问题。
- 可选 Gateway 独立安装包与协议版本。

## 15. 回滚

- 油猴脚本保留最近两个稳定版本。
- 配置 schema 每次变更提供迁移和回退。
- Gateway 协议至少兼容一个旧 minor。
- 发现安全问题时可远程公告，但不内置远程禁用 / 自动更新执行逻辑。

## 16. 验收清单

- [ ] P0 产品流程可在原型中完整走通。
- [ ] 真实 GitLab MR 上可划词提问。
- [ ] Review Finding 可定位、可解释、可复制。
- [ ] 发布前展示正确目标并二次确认。
- [ ] 失败、取消、过期 Diff 状态清晰。
- [ ] 自部署站点能力级别可见。
- [ ] 无密钥泄漏。
- [ ] 大 MR 不影响 GitLab 页面操作。
- [ ] 测试矩阵与文档一致。
