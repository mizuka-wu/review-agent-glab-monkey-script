# 安全、隐私与密钥治理

## 1. 安全目标

- 不让 GitLab 或模型 token 泄漏到页面、日志、截图、埋点或第三方请求。
- 默认不把完整仓库或无关源码发送给模型。
- 所有 GitLab 写入由用户明确确认。
- 浏览器页面、模型 provider、本地 Gateway 之间保持清晰信任边界。
- 本地命令执行默认关闭；开启后仍不能变成任意远程代码执行入口。

## 2. 信任边界

```text
[GitLab 页面 / 用户会话]
        │ 选择内容、MR 元数据、用户确认
        ▼
[油猴脚本 UI] ─────► [GitLab API]
        │ 最小上下文                  ▲
        │                            │ 只在确认后写评论
        ▼                            │
[模型 provider] ◄── [本地 Gateway] ──┘（Gateway 不拥有写权限）
                     │
                     ├─ 模型密钥
                     ├─ 本地仓库镜像
                     ├─ 规则 / 缓存
                     └─ 可选受限命令
```

## 3. 威胁模型

| 威胁 | 场景 | 缓解 |
| --- | --- | --- |
| 页面 XSS / 恶意代码注入 | MR 文件名、注释、模型 Markdown 含 HTML | Shadow DOM、严格 Markdown、禁 raw HTML、URL allowlist |
| Token 泄漏 | API Key 写入日志、错误、localStorage | 独立 secret store、脱敏、默认不持久化 |
| 源码过度上传 | 把整个仓库或 lockfile 发给模型 | Context Builder、过滤、预算、发送预览 |
| 恶意 Gateway | 网页连接非本机服务并上传源码 | 用户确认 origin、本地 token、首次连接指纹 |
| 恶意模型输出 | 返回危险链接、命令、误导性建议 | 不执行模型指令、Markdown sanitize、人工确认 |
| 评论误发 | 错项目、错行、重复评论 | 二次确认、项目 / MR 显示、fingerprint、幂等 |
| CSRF / Cookie 滥用 | 恶意站点触发 GitLab 写操作 | 仅用户手势、目标 origin 校验、确认对话框 |
| 本地命令执行 | 模型诱导执行任意 shell | 默认关闭、allowlist、固定 cwd、超时、审计、无 shell 拼接 |
| 供应链攻击 | 依赖包被投毒 | lockfile、依赖审计、最小依赖、构建产物检查 |
| 资源耗尽 | 超大 Diff / 工具死循环 | token / 文件 / 时间 / 工具调用预算、取消 |

## 4. 密钥治理

### 4.1 推荐

模型 API Key、企业网关凭据和高权限 PAT 只保存在本地 Gateway 的系统 Keychain 或 `0600` 配置中。

### 4.2 浏览器直连模式

- 必须清楚提示风险。
- 只保存到当前会话是默认选项。
- 用户显式选择持久化时，使用油猴脚本专用存储；不写普通 `localStorage`。
- UI 中永远以掩码显示，不提供“复制密钥”按钮。
- 导出诊断 / 配置时必须移除。

### 4.3 GitLab 认证

- 优先复用浏览器 Cookie / CSRF，不长期保存 PAT。
- 如使用 PAT，优先只读 scope；发布评论时再提示所需权限。
- 不把 GitLab token 发送给模型 provider 或 Gateway。
- 发布请求由浏览器侧 transport 签名并发送。

## 5. 数据最小化

默认发送：

- 用户选中代码或当前 Diff Hunk。
- 文件路径、行范围、语言。
- MR 标题、描述和必要背景。
- 规则命中摘要。

默认不发送：

- 未命中 / 未读取的完整仓库。
- `.env`、密钥文件、凭证、token、私钥。
- lockfile、二进制、生成文件全文。
- 页面 Cookie、Authorization header、CSRF token。
- 其他 MR 的评论和用户身份信息。

用户可在发送前打开“上下文预览”查看最终 payload 的内容摘要和 token 估算。

## 6. 脱敏

Context Builder 与日志层均执行脱敏：

- 常见 token：`AKIA...`、`ghp_...`、`glpat-...`、Bearer token、JWT。
- PEM 私钥块、密码字段、connection string。
- URL 用户信息、query token。
- 自定义团队规则提供的正则。

脱敏标记使用稳定的 `[REDACTED:type]`，不把原值写入日志。模型上下文是否替换敏感内容由用户策略控制，但日志始终替换。

## 7. XSS 与 Markdown

- React 默认文本转义，不使用 `dangerouslySetInnerHTML` 渲染模型内容。
- Markdown 渲染禁用 raw HTML。
- 链接协议只允许 `http`、`https`、`mailto`；外链显示目标域名。
- 代码块不带可执行内容；suggestion 仅文本预览。
- 文件名、路径、模型字符串都视为不可信输入。
- Shadow DOM 不能替代 sanitize，两者都需要。

## 8. 内容安全策略与跨域

- 尽量通过 `GM_xmlhttpRequest` / `GM.fetch` 访问显式允许的 API。
- `connect` 范围不要写 `*://*/*`；自部署站点使用运行时提示和配置白名单。
- 模型 provider 跨域失败时引导用户切换 Gateway，不在前端静默降级到不安全代理。
- Gateway CORS 只允许用户确认的 GitLab origin。
- 不通过第三方 JSONP、图片像素或动态脚本传输数据。

## 9. 本地 Gateway 安全

### 网络

- 默认绑定 `127.0.0.1`。
- 使用启动时生成的随机 bearer token；不接受无鉴权请求。
- CORS origin 明确 allowlist。
- 不支持公网监听，除非未来版本增加 TLS、认证和组织策略。

### 文件系统

- 只访问用户映射的项目目录。
- 仓库路径规范化后校验 prefix，阻止 `../` 与符号链接逃逸。
- 不接受浏览器 payload 中的任意绝对路径。
- 缓存目录权限最小化。

### 命令执行

默认关闭。开启后：

- 只执行配置中 allowlist 的可执行文件和固定参数模板。
- 使用参数数组，不拼接 shell 字符串。
- 固定工作目录、超时、输出上限。
- 清理环境变量，只保留 allowlist。
- 审计命令 ID、耗时、退出码，不记录可能含密钥的完整输出。

## 10. 用户确认策略

以下操作必须显式确认：

- 首次向模型发送代码。
- 连接新的 Gateway origin。
- 创建 GitLab Discussion。
- 一次发布多条评论。
- 开启本地命令执行。
- 导出包含代码内容的 Review 报告。

以下操作不需要每次确认：

- 读取当前页面公开内容。
- 打开侧栏、复制非敏感文本。
- 对已确认 provider 发送用户主动提交的问题。

## 11. 隐私模式

### 本地优先

- 只连接本地 Gateway / 本地模型。
- 禁止外部 telemetry。
- 会话默认 24 小时后清理。

### 标准

- 允许用户配置的云端模型。
- 发送前可查看上下文摘要。
- 只持久化 Finding 元数据和用户状态。

### 诊断

- 临时记录脱敏日志。
- 30 分钟后自动过期。
- 导出前再次扫描 token 和路径。

## 12. 审计事件

建议记录：

- `context.created`：文件数、token 估算、脱敏数。
- `runtime.connected`：runtime 类型、模型别名、版本。
- `run.started/completed/failed/cancelled`。
- `finding.ignored/accepted`。
- `discussion.publish.requested/succeeded/failed`。
- `command.executed`（开启命令后）。

不记录源码全文、prompt 全文、API Key、Cookie、Authorization。

## 13. 依赖与构建安全

- 提交 `pnpm-lock.yaml`。
- CI 执行 `pnpm audit` 和许可证检查。
- 减少模型 SDK 直接依赖，provider 适配优先由 Gateway 承担。
- 构建产物检查 metadata 的 `@connect` / `@grant` 是否符合声明。
- 禁止构建时从远程加载可执行脚本。

## 14. 事故响应

- 疑似密钥泄漏：立即撤销 GitLab / 模型 token，删除脚本存储，查看访问日志。
- 误发评论：使用 GitLab discussion 删除 / 编辑，保留发布记录。
- Gateway 异常外联：断开网络、禁用服务、导出脱敏审计。
- 发现恶意模型输出：停止任务、保留事件、增加 deny rule。

## 15. 发布前安全检查

- [ ] 无 token 出现在构建产物、source map、日志。
- [ ] Markdown raw HTML 被禁用。
- [ ] 所有写操作有用户确认。
- [ ] 自部署 origin 不是任意 wildcard。
- [ ] Gateway 默认 loopback + token。
- [ ] 命令执行默认关闭。
- [ ] 依赖审计无未接受的高危问题。
- [ ] 数据发送预览与实际 payload 一致。
