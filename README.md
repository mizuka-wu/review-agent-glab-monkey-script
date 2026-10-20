[English](README.en.md) | **简体中文**

# Review Agent for GitLab

[![Release](https://img.shields.io/github/v/release/mizuka-wu/review-agent-glab-monkey-script)](https://github.com/mizuka-wu/review-agent-glab-monkey-script/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/mizuka-wu/review-agent-glab-monkey-script/ci.yml?branch=main)](https://github.com/mizuka-wu/review-agent-glab-monkey-script/actions/workflows/ci.yml) [![Docs](https://img.shields.io/badge/docs-VitePress-blue)](https://mizuka-wu.github.io/review-agent-glab-monkey-script/) [![DeepWiki](https://deepwiki.com/badge-maker?url=https%3A%2F%2Fdeepwiki.com%2Fmizuka-wu%2Freview-agent-glab-monkey-script)](https://deepwiki.com/mizuka-wu/review-agent-glab-monkey-script)

一个面向 GitLab / 自部署 GitLab 的油猴脚本（Tampermonkey Userscript），在 MR / Diff / File 页面中提供代码评审能力。采用与 [OpenCodeReview](https://github.com/alibaba/open-code-review) 相同的**确定性规则 + LLM 混合架构**：规则检查永远在浏览器本地运行（无需 API Key、零 token），配置模型后叠加 AI 深度评审，两类结果分开标注、命中同一处问题时自动合并。支持划词提问、结构化 Finding 草稿、批量发布 GitLab Discussion。

## 核心特性

### 🧩 混合评审（无需 API Key 也能用）
- **规则阶段恒运行**：24 条内置确定性规则在浏览器本地执行，不联网、不消耗 token；未配置模型时 Review 依然可用
- **模型阶段可选**：`规则 + AI` / `仅规则` / `仅 AI` 三种模式；模型调用失败自动降级为规则结果
- **来源可区分**：每条 Finding 标注 `规则` / `AI` / `规则 + AI`（相互印证），可按来源筛选、分组查看，并展示命中的规则 id
- **未配置提示**：侧栏与设置页明确列出当前可用能力和缺少项，一键跳转配置

### 🤖 模型 Review
- **OpenAI 兼容接口**：官方端点、企业网关、本地代理均可；Bearer Token、API Key Header、Query Parameter、自定义 Header 四种认证模式（网关免鉴权时可不填 Key）
- **本地模型提示**：Base URL 旁「?」列出 omlx / Ollama / LM Studio 的默认端口与带 `/v1` 后缀的兼容地址，点击即填；localhost 端点自动拉取 `/v1/models` 列表；模型名为「可输入 + 下拉建议」组合框，当前模型不在服务器列表时自动切换到第一个可用模型并立即保存；对话区顶部也可直接切换模型；可用「关闭思考输出」开关抑制 omlx/vLLM 的思考过程泄漏
- **Agent 工具循环**：模型可主动调用 `file_read`、`search_code`、`git_log` 工具获取仓库上下文
- **MCP 扩展**：可同时连接多个 MCP server（Streamable HTTP / SSE），工具名按服务 id 加前缀避免冲突，调用按前缀路由；单服务器旧配置自动迁移
- **思考结构化**：思考 pane 默认折叠，展开后显示要点抽取与 prose/JSON/代码分段时间轴，原文流可开关
- **会话回放**：历史会话只读回放，可标记已修复/忽略/恢复草稿、隐藏已处理项、恢复为当前会话
- **SSE 流式输出**：聊天逐 token 流式渲染；Review 模型阶段同样流式——思考通道（`reasoning_content`）以可折叠打字机呈现（默认折叠、实时字数），finding 随流式逐条增量进入结果列表，原始 JSON 默认折叠仅供排查；可随时「取消」停止；服务端不支持 SSE 时自动回退一次性读取；规则结果在规则阶段完成后立即先行渲染
- **三档审查强度**：fast（仅高置信）、balanced（默认）、thorough（全面）
- **项目补充要求（当前值按项目、历史全局共用）**：起始页「开始一次混合评审」与设置页均可为每个项目配置补充提示（注入 review 的 user 消息，**当前生效值仍按项目分开**）；**历史改成所有项目共用一个池子**，全局保留最近 30 条（最新在前、按内容去重），每条右下角标出来源项目，既能挑回本项目的旧输入也能挑别的项目存过的（选中只把内容填回输入框）；历史只从**输入框右上角的历史按钮**进（点条目填回、单删噪声、当前生效值高亮），`↑` `↓` / `Esc` 一律留给多行光标与人工编辑，不做键盘劫持；打字只改当前值，**失焦才是保存点**（清空只删当前值，历史保留可以从列表捞回来）；旧数据三级自动迁移（单值 → 按项目分桶历史 → 全局池），一条不丢

### 📋 Review 引擎
- **规则包系统**：内置 24 条多语言规则（硬编码密钥、URL 凭据、SQL 注入、XSS、命令注入、TLS 校验关闭、弱哈希、可预测随机数、静态可变共享状态、Java `equals`、Kotlin `!!`、TS 非空断言、弱类型、吞异常、Go 丢弃 error、阻塞 sleep、跳过测试、调试输出、内网地址、TODO、冲突标记、缺少测试），按语言与 glob 路径作用域匹配、跳过注释行、单文件命中上限；支持自定义规则包（regex、作用域、语言、JSON 导入导出、逐条开关），并按 **公共 / 当前项目** 两种作用域分别存储、动态加载，项目自定义包覆盖同 id 公共包；内置规则以 `rule_docs/*.md` 语言文档为唯一来源（frontmatter + 匹配模式 + 正反例），生成器产出代码并带漂移检查
- **Context Builder**：Diff 文件过滤（lockfile/生成文件/密钥/二进制排除）、字符预算截断、省略原因记录
- **MR 说明进上下文**：当前 MR 的 `description` 作为需求背景拼进 review 的 user 消息（`## MR 说明` 段，紧跟 diff、在仓库符号背景之前；4000 字符预算截断并标注原文长度；纯标题 MR 整段不渲染，不留空块），让模型能判断「实现是否符合说明里的意图」，说明与变更不一致时直接在对应文件上报告；参考 MR 的说明按同口径拼进只读参考块（`#### [参考 g/p!12] MR 说明`，最多占该参考预算的一半，避免挤掉参考 diff），依旧只读——不产 Finding、不写回；Delegation 导出同样带 `## MR 说明` 段（空则写 `(无)`）；**是否进上下文由「设置 → 审查设置 → MR 说明进上下文」控制（默认关：缺省不进上下文，手动打开才拼）**，关闭时当前 MR 与参考 MR 的说明段整段不渲染、字符不入账（省 token），MR 主体接口照旧读取
- **MR commit 记录进上下文**：需求细节常常只写在 commit message 里 —— 当前 MR 的提交列表（`GET /merge_requests/:iid/commits`，与 MR 主体、diff 并行拉取，不多打无谓请求）拼进 review 的 user 消息（`## MR Commits` 段，紧跟 `## MR 说明`、在仓库符号背景之前；每条一行「短 sha + title」，message 正文缩进跟在下面），让模型能判断「实现是否符合 commit 里写明的意图」，不一致时直接在对应文件上报告；与说明段同一 4000 字符预算，单条 message 超 1200 字符就地截断并标注原文长度，最多 100 条（其余留省略标记）；空列表或接口失败整段不渲染，一次 commits 接口失败只降级掉这一段、不打断评审；参考 MR 的提交按同口径拼进只读参考块（`#### [参考 g/p!12] MR Commits`，最多占该参考预算的四分之一，避免挤掉参考 diff），依旧只读——不产 Finding、不写回；Delegation 导出同样带 `## MR Commits` 段（空则写 `(无)`）；**是否进上下文由「设置 → 审查设置 → Commit 信息进上下文」控制（默认关：缺省不进上下文，手动打开才拼）**，关闭时当前 MR 与参考 MR 的 Commits 段整段不渲染、字符不入账（省 token），并且连 `GET /merge_requests/:iid/commits` 都不打（当前 MR 与每个参考 MR 都不打）
- **diff 每行带显式行号（消灭模型心算行号）**：拼给模型的 diff 不再是裸 unified diff——每行行首都带行号前缀（`+L23 内容` = 新增行的 new 侧行号、`-L17 内容` = 删除行的 old 侧行号、` L5 内容` = 上下文行的 new 侧行号），hunk 头与 `diff --git` / `\ No newline` 等标记行原样保留，diff 段前面还写了一行格式图例；system prompt 同步说明「前缀 L数字 就是该行行号，`line` / `endLine` 直接引用，不要自己从 `@@` 头往下推算，`existingCode` 只抄行内容不带前缀」。模型此前只能从 hunk 头心算行号，多 hunk / 长上下文 / 相似代码时数错是常态，行号一错就锚不上 diff 行、只能降级成全文评论——这是「很容易没办法行内评论」的主因。前缀的字符开销如实计入上下文预算（`diffPromptSize`，上下文预算与分组预算同一口径；实测真实多 hunk MR 约 +12%），预算不够时仍然整文件裁掉并记 `budget` 省略原因，不会出现半个文件带行号半个不带；模型偶尔把前缀一起抄进 `existingCode` 也认——锚定的片段变体会先剥掉 `+L23 ` / `-L17 ` / ` L5 ` 再匹配
- **Finding 锚定**：`existingCode` 多行精确匹配、旧/新侧行号推断、跨文件重定位
- **大 MR 分组并发**：变更文件按目录内聚分组、每分组独立上下文并发评审（并发 3），分组失败保留其余结果
- **评论反思**：模型对 AI Finding 自检（值不值得评 / 是否重复 / 位置是否正确），drop 项进 warnings；fast 强度跳过
- **Review 硬化**：证据充分度检查、严重度校准、同源相似 Finding 合并、跨来源印证合并、置信度过滤（仅作用于 AI 结果）
- **幂等发布**：指纹去重、`head_sha` 校验、`stale_diff_refs` 检测、Discussion 同步
- **评测基准**：31 个 fixture（每条规则一个标注样本 + 干净负样本），检测率 ≥ 80%、精确率 ≥ 70%、安全类 100%、干净代码 0 误报

### 🎯 Finding 管理
- **完整生命周期**：草稿 → 编辑 → 定位 → 复制 → 发布 / 忽略
- **页内高亮**：在 GitLab Diff 页面上标注 Finding 位置，severity 色标；经典 HAML / Vue diff / 19.x grid / 19.x Rapid Diffs（`<diff-file>` + `tr.rd-hunk-lines`，19.x 的默认渲染）四种 DOM 都认
- **批量发布**：复选框多选 → 预览确认 → 逐条创建 Discussion
- **409 自动重锚（不再直接降级全文）**：评审到发布之间 MR 被 push 了新 commit 时，行内位置会以 409（`diff_refs` 过期）被拒——这是最高频的降级原因。现在撞 409 会先重新拉 MR 的 `diff_refs` 与 Diff、在新 Diff 上按内容重跑锚定（只认内容不认旧行号），再用新 position 重发一次；行内保住就静默成功（调试计数 `publish-inline-reanchored`）。批量发布里第一条 409 刷新出的 refs 被后续评论直接复用，整批只重拉一次；重锚上限一次，重锚不出来或重发仍被拒才降级全文，原因写成「MR 已更新，已尝试重锚：…」，`[inline-fallback]` 日志同时给出两次 position 参数
- **降级不静默**：行内位置被 GitLab 拒了才改发全文评论时，toast 与 Finding 卡片都写明原因（如「MR 已更新，diff 位置已过期」「GitLab 拒绝了这个行内位置（…line_code…）」）；发布前就判定挂不上行的，卡片直接给出原因（行号不在 Diff 内 / 文件被 GitLab 折叠 / 路径不在本 MR）
- **降级留全现场（console 直接复制）**：任何一条评论因行内失败降级成全文时，浏览器 console 打一段每行都带 `[inline-fallback]` 前缀的结构化日志（同一条完整现场也进调试面板与导出包），内容是排查这次降级所需的全部参数：`cause`（发布前拦下 / 被 GitLab 拒）与 `reasonCode` + 人话原因、当时真实发出的 `position` 全量参数（`base_sha`/`head_sha`/`start_sha`、`new_path`/`old_path`、顶层 `old_line`/`new_line`、`line_range` 的起止端点 —— 只有 `line_code` + `type`，行号编在 `line_code` 里）、锚定输入与结果（行号 / 侧别 / diff 行类型 added·removed·context / 取自真实 diff 行的行号配对 / 是否被内容重定位）、该文件的 diff 概况（GitLab 给了哪些行号区间、是否 collapsed / too_large / 纯重命名）、页面 DOM 取证（视图类型 rapid / classic、这一行在页面上找不找得到、行号来自哪个 span id 或 data 属性、能读到的 line_code）、服务端响应（HTTP 状态 + GitLab 返回的原话，400 / 409 / 422 的 body 是关键证据）、环境与选区。用户主动发全文（MR 总评论、扫描模式这类没有行内位置语义的发布）不打这条日志；PAT / 令牌一律脱敏，评论正文与代码片段只记规模不记内容
- **发布请求原样留档（400 直接照着复现）**：每一次发布写请求（行内 / 全文 `discussions`、MR 总评论 `notes`）在真实发出后都打一段每行带 `[inline-request]` 前缀的现场：method + 完整 URL、请求 headers（`Content-Type` / `Accept` 原样，`PRIVATE-TOKEN` 只留首尾 4 位与长度，CSRF / Authorization 全抹）、**body 原文**（JSON 直发的那一串，`position` / `line_range` / `line_code` / `type` / 三个 sha 全在里面，不截断）、响应状态与失败时的响应 body 原文，外加一条把 `<PAT>` 换成自己 Token 就能整行粘贴执行的 `curl` 重放命令（body 里的单引号已按 `'\''` 转义）。失败打 error 级、成功打 debug 级，console / 调试面板 / 导出包三处同一份；自部署实例上发布被拒时把这一段发过来就能照着复现，不必再靠推断
- **快速操作**：一键 Approve、一键行内评论（全部可发布草稿）、发布 MR 总评论；均为两步确认防误触
- **筛选排序**：按来源/严重度/分类/状态过滤，按严重度/来源/文件排序
- **Session/Resume**：刷新页面后恢复上次 Review 会话
- **结果导出**：一键复制 findings 结构化 JSON（来源/证据/锚点/状态）与 Delegation 上下文（文件选择 + 适用规则 + Diff + 背景，供外部 Agent 用自有模型评审）

### 🔎 仓库索引（符号搜索 / 调用链）
- **本地符号表**：GitLab REST 没有符号级 API，脚本把仓库文件缓存到浏览器 OPFS（[opfs-worker](https://github.com/kachurun/opfs-worker)，独立 Worker → 主线程 → 内存三级回退），构建符号表
- **符号搜索**：按标识符边界搜索定义与引用/调用点，比关键词搜索精确；import 感知解析（ts/js/py/go）把引用解析到定义文件，调用链排除同名本地定义的误边
- **调用链**：启发式向上追溯「谁调用了它、调用者又被谁调用」，评估改动影响面
- **Agent 工具**：索引就绪后对话/Review 的 Agent 可调用 `symbol_search`、`call_chain`
- **Review 仓库上下文**：把「变更文件定义了哪些符号、被 Diff 外谁调用」注入模型提示词
- **索引管理**：每个 branch / commit 的索引独立保存（注册表记录 ref、分支名、文件数、体积、符号数），可载入、单份删除、全部清除；超过保留份数自动清理最旧；显示站点存储用量与配额
- **过期保护**：载入的索引与当前 head 不一致时明确告警，且不会把过期符号上下文注入 Review 提示词
- **缓存复用**：同 head ref 直接恢复本地索引，零网络开销；文件数 / 单份体积 / 保留份数可配置
- **全文件扫描**：对已索引文件跑确定性规则（对齐 `ocr scan`），扫描模式结果不可发布为行级评论

### 🐞 调试工具（设置中开启）
- **默认关闭**：在「设置 → 调试 → 显示调试标签页」打开；设置标签在有错误日志时会显示红点
- **四面板调试器**：日志 / 网络 / 提示词 / 状态，支持关键字过滤、级别过滤、自动滚动
- **网络面板**：GitLab API、模型调用、MCP、索引请求的方法、状态码、耗时、字节数
- **提示词面板**：每次模型调用的完整 system、消息内容、工具列表、token 用量与响应摘要
- **状态面板计数**：`publish-downgrade:<reasonCode>`（行内降级为全文的原因分布）与 `publish-inline-rejected:<status>`（GitLab 拒绝行内位置的状态码分布）按次累加，跨刷新保留，导出调试包一并带上
- **console 镜像**：页面 `console.warn/error` 自动进入日志；日志跨刷新保留；`[inline-fallback]` / `[inline-request]` 这类需要用户复制去排查的结构化日志反向镜像到 console，两边内容一致且不重复记录
- **一键导出**：复制并下载 JSON 调试包（含脱敏设置快照），便于提 issue 排查

### 🛠 自部署兼容
- **能力探测**：认证模式、API 版本、搜索、CSRF、DOM 可用性自动检测
- **DOM 降级**：API 不可用时从页面 DOM 解析 Diff
- **行号读法共用一套**：划词取行号与 Finding 定位都走 `core/dom-line-number.ts`，按侧别（old/new）分别读行号格；19.x Rapid Diffs 用 `td.rd-line-number[data-position]` 分侧、行号在 `a.rd-line-link[data-line-number]` 上，19.x grid 用 side wrapper 上的 `data-interop-old-line` / `data-interop-new-line`，两侧号码不同的上下文行也不会串
- **GitLab 的硬限制**：行内评论只能挂在 MR diff 的行上（默认 3 行上下文）。实测把「隐藏的 N 行」全部展开后再发 REST `position` 仍然是 `400 line_code can't be blank`，所以完整文件上下文里只有 diff 行会被标为「可锚定行」，模型锚到别处只能降级为全文评论
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

## 发布与同步渠道

主源是 **GitHub Releases**（`v*` tag 触发 Release workflow 上传 `.user.js` / `.meta.js`）。其他平台作为镜像，用「拉取同步」接入，避免多处手维护：

| 渠道 | 安装/同步地址 | 更新方式 |
| --- | --- | --- |
| GitHub Release（主源） | `releases/latest/download/review-agent-glab-monkey-script.user.js` | 打 tag 自动发版 |
| Greasy Fork | 脚本管理页「从 URL 同步」填主源地址 | GF 定期拉取，按 `@version` 发更新 |
| OpenUserJS | 从 GitHub 仓库导入 + 手动/Webhook 更新 | 同上 |
| GitHub Pages（边缘通道） | `https://mizuka-wu.github.io/review-agent-glab-monkey-script/review-agent-glab-monkey-script.user.js` | main 每次构建（适合跟开发版） |

列表页完整说明（特性/权限与隐私逐条/@match 理由/截图建议/FAQ/数据清理）见 [GREASYFORK.md](GREASYFORK.md)，可直接粘贴到平台描述框。

Greasy Fork 上架步骤（逐字段）：
1. 用 GitHub 账号登录 greasyfork.org → 「提交脚本」→ 创建条目：
   - **Name**：`Review Agent for GitLab`（与 `@name` 一致）；
   - **Namespace**：`review-agent-glab`（与 `@namespace` 一致，决定更新匹配）；
   - **Summary/Description**：粘贴 GREASYFORK.md 的简介与特性部分；
   - **Categories**：Code review / Developer tools；
   - **License**：MIT（与 `@license` 一致）；
   - **Adult content / Ads**：均选否。
2. 脚本管理页 → 代码 → 「从 URL 同步」填入主源 `.user.js` 地址并开启自动同步；同步后 GF 会把 `@updateURL/@downloadURL` 指向 GF 自身，从 GF 安装的用户走 GF 更新；
3. 管理页补充：截图（建议 GREASYFORK.md 列的 5 张）、Additional info 粘贴 FAQ 与权限说明、Support 链接填仓库 issues；
4. 之后每次发版只需 `git tag v0.x.y && git push --tags`，GF 会在下次同步时按 `@version` 发布更新（也可在管理页手动触发同步）。

排障：
| 现象 | 原因与处理 |
| --- | --- |
| 同步被拒「version not changed」 | 代码变了但 `@version` 没 bump：bump 版本再 tag |
| 同步拉到的描述是旧文案 | GF 缓存：管理页手动触发同步；描述字段需手动更新一次 |
| 审核询问宽 `@match` | 回复「自部署 GitLab 域名不可枚举；脚本仅在识别到 GitLab 页面时挂载，其余页面零请求」，并指向 GREASYFORK.md 的说明 |
| 审核询问代码可读性 | 产物未压缩且源码仓库公开（`@homepage`），符合反混淆规则 |
| OUJS 未自动更新 | OUJS 需配置 GitHub webhook 或手动 Update；确认仓库 raw/release URL 可达 |

平台合规要点（已满足）：MIT `@license`、稳定 `@namespace`、语义化 `@version`、源码仓库链接（`@homepage`/`@supportURL`）、无混淆代码（构建产物未压缩且仓库公开）、无外部 `@require`。

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

1. [产品需求与范围](docs/product-brief.md)
2. [能力边界](docs/capability-boundary.md)
3. [系统架构](docs/architecture.md)
4. [UX 流程](docs/ux-flows-and-prototype.md)
5. [GitLab 接入](docs/gitlab-integration.md)
6. [Agent Gateway 协议](docs/agent-gateway-contract.md)（规划中，未实现）
7. [安全与隐私](docs/security-privacy.md)

计划与 backlog（MCP 本地中继桥、与 OpenCodeReview 的剩余差距、验收基线）见 [TODO.md](TODO.md)。

## 测试

- **766 个单元测试**：规则引擎、锚定、硬化、Provider、Agent 循环、MCP、能力探测、Markdown、安全存储、成本统计、仓库索引/符号表、调试总线、prompt 与项目补充要求全局历史池（三级迁移/去重/30 上限/来源标注/跨项目点选与单删）、MR 说明上下文（渲染/截断/空值跳过/参考 MR 拼接）、MR commit 记录上下文（段渲染/100 条与 4000 字符截断/单条 message 截断/空值与接口失败跳过/参考 MR 拼接/App 全链路）、说明与提交两个上下文开关（默认关与两级迁移：老设置没存过这两个字段一律读回关、存过 true 原样读回 true/关掉后段落不渲染且字符不入账/参考 MR 同口径/commits 接口不打/Delegation 段不导出/设置页开关与 App 全链路）
- **41 个 Playwright E2E**：24 个 mock 模式（规则 Review 发布、无 Key 规则 Review、选区对话、仓库索引+符号搜索、快速操作、流式输出、运行中停止、模型失败横幅、模型自动切换、面板内划词隐藏、项目补充提示注入（含 MR 说明与 MR Commits 段）、项目补充要求历史按钮（全局池 + 来源项目标注）、prompt 历史、参考 MR（含参考说明与参考提交记录）、应用修复、会话回放、设置页布局、元数据等）+ 17 个真实 GitLab 模式（注入读 MR、规则 Review、真实本地模型混合 Review、仓库索引/符号/注册表管理、真实选区行号、真实行内 Discussion 发布、真实修复提交等）；真实模式需设置 `GITLAB_URL` + `GITLAB_MR_URL`，可选 `MODEL_BASE_URL` / `MODEL_NAME` / `GITLAB_USER` / `GITLAB_PASS`
- **8 个评测 fixture**：安全/调试日志/弱类型/缺少测试/干净代码/多文件/性能/密钥泄漏
- **合并门禁**：`pnpm typecheck` + `pnpm test:unit` + `pnpm test:e2e` + `pnpm build`

## License

[MIT](LICENSE)
