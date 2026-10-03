# Greasy Fork / OpenUserJS 列表页说明（可直接粘贴）

> 同步源：`https://github.com/mizuka-wu/review-agent-glab-monkey-script/releases/latest/download/review-agent-glab-monkey-script.user.js`
> 源码与文档：<https://github.com/mizuka-wu/review-agent-glab-monkey-script> · 技术文档站：<https://mizuka-wu.github.io/review-agent-glab-monkey-script/>

## 简介

Review Agent for GitLab 是一个运行在 GitLab 页面内的代码评审助手（油猴脚本）：在 MR / Diff / Commit / File 页面提供「确定性规则 + 可选模型」的混合评审。
规则检查永远在浏览器本地执行（不联网、零 token），未配置任何 API Key 也能完整使用；配置 OpenAI 兼容端点（官方 / 企业网关 / 本地 omlx、Ollama、LM Studio 等）后叠加 AI 深度评审，两类结果分开标注、命中同一处问题时自动合并为「规则 + AI」。

## 特性

- **混合评审**：24 条内置多语言规则（硬编码密钥、URL 凭据、SQL 注入、XSS、命令注入、TLS 校验关闭、弱哈希、可预测随机数、共享可变状态、Java `equals`、Kotlin `!!`、TS 非空断言、弱类型、吞异常、Go 丢弃 error、阻塞 sleep、跳过测试、调试输出、内网地址、TODO/冲突标记、缺测试）+ 可选 AI 评审；模式可切「规则 + AI / 仅规则 / 仅 AI」。
- **流式体验**：模型阶段 SSE 流式；思考过程折叠打字机（要点抽取 + 分段时间轴）；finding 逐条增量进入结果列表；规则结果先行；随时可停止。
- **来源可区分**：每条问题标注 规则 / AI / 规则+AI，可按来源、严重度、分类、状态筛选与分组；规则 id 可见，可一键去设置关掉噪声规则。
- **仓库索引**：把仓库文件缓存到浏览器 OPFS 构建符号表，提供符号搜索与启发式调用链；按 branch/commit 分命名空间管理多份索引，可载入/删除/清理；「Diff 外调用点」可注入评审上下文。
- **全文件扫描**：对已索引目录跑规则审计（无 diff 也可用），扫描结果不可发布为行级评论。
- **发布闭环**：所有评论默认草稿；行级 Discussion 单条/批量发布（预览确认、指纹去重、head_sha 校验）；一键 Approve；MR 总评论；会话回放与「已修复/忽略/隐藏已处理」管理。
- **规则包管理**：内置规则以语言文档维护；自定义规则包（regex、glob 作用域、语言、JSON 导入导出、逐条开关）；支持 公共 / 按项目 两种作用域。
- **按项目补充要求**：每个项目可配置额外评审约束，注入评审上下文。
- **Agent 能力**：模型可调用 file_read / search_code / git_log / symbol_search / call_chain 工具；可接入多个 MCP server 扩展工具；可导出 findings JSON 与 Delegation 上下文给外部 Agent。
- **调试工具**：设置中开启后提供 日志 / 网络 / 提示词 / 状态 四面板，记录每次 GitLab、模型、MCP、索引请求与完整提示词，可一键导出脱敏调试包。
- **自部署友好**：GM.xmlHttpRequest 通道绕过页面 CSP/CORS；能力探测与诊断面板；配置导出。

## 安装

1. 安装 Tampermonkey（或 ScriptCat 等兼容管理器）；
2. 打开本页面安装按钮，或从 GitHub Release 安装；
3. 打开任意 GitLab MR / Changes 页面，点击右下角浮动按钮打开侧栏。

不配置 API Key 也可直接使用规则检查、划词定位、Finding 编辑与评论草稿复制。

## 权限与隐私（@grant 逐条说明）

- `GM.getValue / GM.setValue / GM.deleteValue`：本地保存设置、规则包、会话与聊天历史；API Key / GitLab PAT 以 XOR+base64 混淆后存储，避免在 devtools 中明文可见。
- `GM.xmlHttpRequest`：直连你所在 GitLab 的 REST API 与你自行配置的模型/MCP 端点，绕过 GitLab 页面 CSP（`connect-src 'self'`）与跨域限制。

数据流向：**代码与 Diff 只在你浏览器 ↔ 你的 GitLab ↔ 你配置的模型端点之间流动**；不上传任何代码到脚本作者的服务器；无遥测、无统计、无广告；调试日志仅存本地且可清除。

## 为什么 @match 是全部 http(s) 站点

自部署 GitLab 的域名无法枚举。脚本在每次加载时先做 GitLab 页面识别（meta/DOM 特征），**只有识别成功才挂载 UI 与发起请求**；其余页面零副作用、零网络请求。

## 截图建议（上架时贴 3–5 张）

1. 结果页：混合评审完成态（来源徽标 + 行级锚点 + 发布按钮）；
2. 运行中：流式思考折叠面板 + 增量结果；
3. 索引页：符号搜索与调用链、按 branch 的索引注册表；
4. 设置页：模型配置（本地端点提示）、规则包作用域、调试开关；
5. 调试页：网络/提示词记录。

## 常见问题

- **支持哪些 GitLab？** 依赖 REST v4 与行级 Discussion（diff_refs），主流自部署与 gitlab.com 均可；纯 DOM 降级在 API 受限时提供只读评审。
- **模型是必须的吗？** 不是。仅规则模式完全离线可用；模型失败会自动降级并显式提示（含服务返回原文与请求 URL）。
- **本地模型怎么配？** 设置页「?」列出 omlx `:8000/v1`、Ollama `:11434/v1`、LM Studio `:1234/v1`；localhost 端点自动拉取模型列表，模型名不在列表时自动切换并保存。
- **更新机制？** 从 Greasy Fork 安装即走 GF 更新（按 `@version`）；GitHub 主源每次发 tag 自动构建上传，GF 同步后发布更新。
- **如何彻底清除数据？** 卸载脚本后清理：localStorage 键 `review-agent-settings-v1`、`review-agent-rule-packs-v1`（含 `::project::` 后缀变体）、`review-agent-review-sessions-v1`、`review-agent-chat-v1`、`review-agent-ui-v1`、`review-agent-debug-v1`，以及 OPFS 目录 `review-agent/`（索引页「清除本地缓存」可一键清索引）。
- **反馈与Issue**：<https://github.com/mizuka-wu/review-agent-glab-monkey-script/issues>

## English summary

In-page code review assistant for GitLab MRs: deterministic rules always run locally (zero tokens, works without any API key), optional OpenAI-compatible model adds AI review with streamed thinking, per-bundle concurrent sub-reviews and a reflection pass. Local OPFS symbol index powers symbol search / call chains; findings are drafts until you publish them as line-level discussions (single/batch), plus one-click approve and a summary note. Rule packs are project-scoped and doc-driven; multiple MCP servers can extend the agent; a four-pane debugger records every request and prompt. No telemetry: code only travels between your browser, your GitLab, and the model endpoint you configure.
