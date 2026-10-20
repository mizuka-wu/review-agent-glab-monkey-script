# GitLab / 自部署 GitLab 接入

## 1. 支持范围

### 第一优先级

- GitLab.com。
- GitLab CE / EE 自部署常见版本。
- MR Changes / Diff / Discussion 页面。
- File / Blob 页面和 Commit Diff 页面作为附加入口。

### 第二优先级

- 保持 GitLab API v4 兼容的自部署 / 私有化站点。
- 有自定义主题但保留标准 DOM data attributes 的站点。
- 只读 API 权限的站点，允许分析和复制评论。

### 条件支持

- 只有 DOM、没有可用 API 的站点：仅划词问答与页面 Diff Review。
- GitLab fork 但修改路由 / API 的站点：通过独立 Adapter 接入。
- Gitea / Gogs / Codeup 等非 GitLab 平台：不在 M1-M4 承诺范围。

## 2. 页面上下文解析

### 2.1 URL

典型 MR 路由：

```text
https://gitlab.example.com/group/subgroup/project/-/merge_requests/123
https://gitlab.example.com/group/subgroup/project/-/merge_requests/123/diffs
https://gitlab.example.com/group/subgroup/project/-/merge_requests/123/commits/abc123
```

解析规则：

- `projectPath` 取 `/-/` 前的 pathname，保留 subgroup。
- `mergeRequestIid` 取 `merge_requests/` 后的十进制数。
- 忽略 `?page=`, `?view=`, `#note_` 等查询 / hash。
- 对编码路径使用 `decodeURIComponent` 后再做 API path 编码。

文件路由：

```text
/-/blob/<ref>/<path>
/-/raw/<ref>/<path>
/-/tree/<ref>/<path>
```

### 2.2 DOM 选择器

DOM 只作为补充，优先使用：

- `data-project-id`、`data-merge-request-id`、`data-file-path` 等稳定属性。
- `data-qa-element` / `data-testid` 仅在 API 不可用时使用。
- 禁止依赖生成 class 名、组件内部顺序和深层 CSS 路径。

每个 Adapter 对 DOM 解析结果返回 confidence；低置信结果不进入发布链路。

## 3. GitLab REST API

### 3.1 项目标识

优先使用 URL-encoded `projectPath`，不强依赖 numeric ID：

```http
GET /api/v4/projects/group%2Fsubgroup%2Fproject
```

返回中的 `id` 可缓存到当前会话。

### 3.2 Merge Request

```http
GET /api/v4/projects/:project/merge_requests/:iid
```

关键字段：

- `id`, `iid`, `project_id`
- `title`, `description`, `state`
- `source_branch`, `target_branch`
- `sha`, `diff_refs`
- `has_conflicts`, `blocking_discussions_resolved`

`diff_refs`：

```json
{
  "base_sha": "...",
  "head_sha": "...",
  "start_sha": "..."
}
```

### 3.3 Diffs

```http
GET /api/v4/projects/:project/merge_requests/:iid/diffs?per_page=50&page=1
```

字段：

- `old_path`, `new_path`
- `diff`, `renamed_file`, `deleted_file`, `new_file`
- `too_large`, `generated_file`

大 MR 必须分页。`changes` 接口可作为兼容回退，但不应默认一次性加载。

### 3.4 MR Versions

```http
GET /api/v4/projects/:project/merge_requests/:iid/versions
```

用于判断 Diff 版本是否过期，以及部分 GitLab 版本的评论定位。

### 3.5 文件内容

```http
GET /api/v4/projects/:project/repository/files/:encoded_path/raw?ref=:sha
```

要求：

- 使用 `head_sha` 或明确 ref，不使用可变分支名构造证据。
- 大文件按行范围读取时由 Gateway 完成；REST raw 会返回完整内容。
- 对二进制 / LFS 文件跳过并记录原因。

### 3.6 Discussions

读取：

```http
GET /api/v4/projects/:project/merge_requests/:iid/discussions?per_page=100
```

创建行评论（一律 JSON body）：

```http
POST /api/v4/projects/:project/merge_requests/:iid/discussions
Content-Type: application/json

{
  "body": "Review comment",
  "position": {
    "position_type": "text",
    "base_sha": "...",
    "start_sha": "...",
    "head_sha": "...",
    "old_path": "src/checkout.ts",
    "new_path": "src/checkout.ts",
    "new_line": 42
  }
}
```

旧路径行使用 `old_path` 与 `old_line`；跨多行再带 `line_range`，`start` / `end` 各自**只带
`line_code` 与 `type` 两个键**（否则只锚定最相关新增行）。MR 级总评论走同一族的
`POST .../notes`，body 同样是 JSON（只有 `body` 一个键）。

```json
"line_range": {
  "start": { "line_code": "52007ba039cb50ce9a88ec2b8d9a9f1f8996d6e8_0_16", "type": "new" },
  "end":   { "line_code": "52007ba039cb50ce9a88ec2b8d9a9f1f8996d6e8_16_17", "type": "old" }
}
```

`line_range` 内部**不发** `old_line` / `new_line`：这两个键在 GitLab 16/17 上类型对撞
（[gitlab#572121](https://gitlab.com/gitlab-org/gitlab/-/issues/572121)）—— API 参数层把它们声明成
`String`，`position.json` 校验层却是 `integer|null`：传字符串过不了 schema、传整数过不了参数层，
两头都是 400 `{:position=>['必须是有效的 json schema']}`。0.4.26 曾按「缺侧补 `0`」把四个键齐发，
正好踩在这个对撞上，0.4.27 撤销。行号本来就编在 `line_code`
（`SHA1(new_path.presence || old_path)_old_line_new_line`，缺的那一侧按 0 编进字符串，没有类型问题）里，
GitLab 解析多行范围也只认 `line_code`：它自己的
`MergeRequests::ResolveDiffPositionService#build_line_range_entry` 同样只保证 `line_code` + `type`，
`old_line` / `new_line` 是有值才附带的可选键。19.4 容器实测两键形态 201，且原样存下
`{"start":{"line_code":…,"type":"new"},"end":{"line_code":…,"type":"old"}}`（服务端不会自己补行号键）。

顶层 `old_line` / `new_line` 不动：类型对撞只发生在 `line_range` 内部，顶层照旧只发真实存在的那一侧
（GitLab 拿它们精确比对 diff 行：added 行只有 `new_line`、removed 行只有 `old_line`，补 0 反而匹配不到），
单行评论因此仍然没有 `line_range`。

不用 `application/x-www-form-urlencoded`：嵌套的 `position[line_range][start][line_code]` 被 form 拆成
平铺字段后，老 GitLab 与油猴 `GM.xmlHttpRequest` 这条链路解析出来的不是合法 position 结构，
一律 400 `position must be a valid json schema`。JSON 直发原生结构，顶层行号也天然是 `integer`
（`position.json` 里 `old_line` / `new_line` 就是整数），不依赖 form 的字符串强转。
唯一还吃 form 默认 `Content-Type` 的是没有 body 的 `POST .../approve`。

这一族的每一次写请求都在传输层出口留下完整现场（`[inline-request]` 前缀，console + 调试面板 + 导出包同一份）：
method 与完整 URL、真实发出的 headers（`PRIVATE-TOKEN` 只留首尾 4 位与长度，CSRF / Authorization 全抹）、
body 原文（不截断，`position` 的每个键都在里面）、响应状态与失败时的响应 body 原文，以及一条替换 `<PAT>`
后即可直接粘贴执行的 `curl` 重放命令。失败必打（error 级），成功也打一条 debug 级。自部署实例上的
400 / 409 / 422 只能靠这条真实请求定位——脚本侧的 `[inline-fallback]` 参数说明「我们想发什么」，
`[inline-request]` 说明「实际发出去了什么字节」，两者一起看才分得清是脚本拼错还是那台 GitLab 校验更严。

## 4. 评论位置规则

### 4.1 可定位条件

发布位置一律由**当前 MR diff 的真实行**重新锚定得到，同时满足：

- 当前 MR 拥有有效 `diff_refs`，且与那份 Diff 同源（见 4.5）。
- Finding 的 `path`（含 rename / `a/` `b/` 前缀 / 子目录相对路径 / 大小写漂移的还原）存在于当前 Diff。
- `existingCode` 或 `evidence.quote` 能在该文件的真实 diff 行里匹配到**唯一一处**。
- 命中行的 `(old_line, new_line)` 配对直接抄那一行：added 行只有 `new_line`、removed 行只有 `old_line`、context 行两者都有。

任何一条不满足就判为不可发布，降级为 MR 全文评论，不再按行号或相似度凑一个位置。

### 4.2 行号来源优先级

1. 当前 Diff 的真实行：由 `existingCode` / `evidence.quote` 重新匹配得到（唯一可信来源）。
2. 模型返回的 `line` / `endLine` / `side`：**只作提示**，用来决定搜哪一侧、以及在命中起点与提示一致时把多行范围补回模型报的长度。
3. Diff DOM 的 `data-new-line` / `data-old-line`：只用于划词与页内定位，不进 `position`。

模型行号绝不单独作为发布依据：行号对不上真实 diff 行、或侧别与行的真实形态不符，GitLab 一律只回一句 `line_code can't be blank` 400，从报错里看不出是哪一样错了。

匹配只在「写法变体」这一层放宽（原文 → 去 diff 行首 `L` 行号 → 去完整文件 `42:` 行号 → 去 `+`/`-` 前缀 → 去空行，比对忽略缩进与多余空白）；**不做相似度模糊匹配、不按标识符猜行、不按邻近行兜底**——那些都会把评论挂到看起来像但不是的行上，且 GitLab 会照收（201），比 400 更难发现。

模型看到的 diff 每行行首都带显式行号（`+L23` = 新增行的 new 侧行号、`-L17` = 删除行的 old 侧行号、` L5` = 上下文行的 new 侧行号，hunk 头原样保留，diff 段前面另有一行格式图例）：模型不需要也不应该从 `@@` 头自己往下数行号，`line` / `endLine` 直接引用行首数字。前缀的字符开销按渲染后的实际长度计入上下文预算（与分组预算同一口径），预算不足时整文件裁掉并记 `budget` 省略原因，不会出现「半个文件带行号、半个文件不带」。

### 4.3 失败分类

发布前判定（`PublishBlockCode`，一条请求都不发）：

- `no-diff`：当前 Diff 还没加载。
- `path-not-in-diff`：文件不在当前 MR Diff，内容也没在别的文件里匹配到。
- `diff-collapsed`：GitLab 没返回该文件的 diff 行（`too_large` / 折叠 / 纯重命名），没有行就没有 `line_code`。
- `reanchor-no-match`：**重新锚定失败：无匹配** —— 片段在当前 Diff 的真实行里找不到（或这条 Finding 根本没有可比对的代码片段）。
- `reanchor-ambiguous`：**重新锚定失败：多候选** —— 同一段代码在当前 Diff 里命中多处，分不清是哪一处。

服务端返回：

- `diff_refs_missing`：缺少 base/start/head SHA。
- `line_out_of_diff`：目标行不是可评论行。
- `stale_diff_refs`：MR 已更新，评论版本过期。
- `permission_denied`：当前身份不能创建 discussion。
- `rate_limited`：GitLab 返回限流。

任何失败都不应修改行号重试，除非重新构建并让用户再次确认。`stale_diff_refs`（409）是唯一的例外：它不是行号算错，而是手里的 `diff_refs` 过期，可以自动重锚，见 4.4。

### 4.4 409 自动重锚

评审到发布之间 MR 被 push 了新 commit 时，`position` 里的 `base_sha` / `head_sha` 与 MR 当前 `diff_refs` 不匹配，GitLab 以 409 拒绝（脚本自己的发布前预检也给出同样的 409）。这是行内评论降级为全文最高频的原因，而它其实可救：

1. 重新拉一份**同源快照**（见 4.5）：新的 `diff_refs` 与行号已经变了的 Diff 取自同一次响应。
2. 在新 Diff 上重跑锚定：与首次发布同一条路径（`resolvePublishPosition(finding, files)`），旧行号本来就不采信，只按内容重新匹配；内容对不上或命中多处就判为不可发布，绝不按旧行号或邻近行硬发。
3. 用新的 `diff_refs` + 新行号重发一次行内 Discussion；成功就静默保住行内评论（调试计数 `publish-inline-reanchored`），不打扰用户。
4. 重锚上限一次：重锚出不来位置、或重发仍被拒，才降级为全文评论，原因写成「MR 已更新，已尝试重锚：<原因>」，`[inline-fallback]` 日志同时给出两次 `position` 参数。

批量发布共享同一次刷新：整批只重拉一次快照，第一条 409 之后剩下的评论直接用新 refs 重锚，不必每条各自撞一次 409。面板里的 Finding 仍基于旧 head，位置只在发布那一刻按新 Diff 重算，state 不替换（换了会让旧 Finding 的行号对到新 Diff 的别的行上）。

### 4.5 diff_refs 与 Diff 必须同源

`position` 的三个 SHA 与行号必须来自**同一次 MR diff 响应**。分两次请求取（先 `GET merge_requests/:iid` 拿 `diff_refs`、再 `GET merge_requests/:iid/diffs` 拿行号），中间 MR 被 push 就是「旧行号 + 新 sha」或反过来：GitLab 不报 409，而是直接 400 `line_code can't be blank`（实测把 `head_sha` 换成 `base_sha` 就是这个形态），排查时看不出是 sha 混了。

因此统一走 `GitLabAdapter#fetchMrDiffSnapshot(ref)`：

- `GET merge_requests/:iid/versions` → 挑 `head_commit_sha` 与 MR 当前 head 对得上的那个版本（对不上就取最新一个）；
- `GET merge_requests/:iid/versions/:id` → **一个响应里同时给出** `base_commit_sha` / `head_commit_sha` / `start_commit_sha` 与那份 `diffs`（含 `collapsed` / `too_large` / `generated_file` 标记）；
- 用版本里的三个 sha 覆盖 `context.diffRefs`，行号也来自同一份 `diffs`，两者天然同源。

老 GitLab 没有 versions 接口、被网关包成 200 + 错误体、版本列表为空、或版本里没 diff 时，回落到 `getMergeRequest` + `listDiffs` 两次读（此时 `createDiscussion` 的发布前 head 预检仍会把过期位置拦成 409 交给重锚）。

首次加载、修复提交后的刷新、409 重锚都走这一个入口，不再各自分别打两个接口。

## 5. 认证模式

### 5.1 当前浏览器会话

- 同源 API 请求携带 Cookie。
- 写请求需要 GitLab CSRF token，通常从 meta 标签读取。
- 优点：不保存 PAT，适合企业 SSO。
- 限制：跨源 Gateway 不能复用 Cookie；站点策略可能禁止脚本请求。

### 5.2 Personal / Project Access Token

- 用户显式输入，最小权限。
- 读写功能需要 `api` 或站点支持的最小 scope。
- 优先保存到本地 Gateway；直连模式明确显示风险。
- 不写入日志、错误、埋点和导出诊断。

### 5.3 推荐

- 默认尝试当前会话，只读请求优先。
- 发布前检查权限，不主动要求高权限 token。
- Gateway 模式由浏览器负责 GitLab 读写，Gateway 不保存 GitLab token。

## 6. 认证请求实现

统一 `GitLabTransport`：

```ts
interface GitLabTransport {
  request<T>(input: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    query?: Record<string, string | number | boolean>;
    body?: FormData | URLSearchParams | unknown;
  }): Promise<T>;
}
```

要求：

- 自动编码项目路径和文件路径。
- 统一超时、AbortSignal、重试和限流处理。
- 401 / 403 不反复弹登录。
- 429 遵循 `Retry-After`，只重试幂等 GET；POST 不自动重复。
- POST 发布使用 `clientRequestId` 做幂等保护。

## 7. 自部署站点能力探测

```json
{
  "origin": "https://gitlab.example.com",
  "product": "gitlab",
  "apiVersion": "v4",
  "version": "17.8.1-ee",
  "capabilities": {
    "mergeRequestRead": true,
    "diffRead": true,
    "fileRead": true,
    "discussionRead": true,
    "discussionWrite": true,
    "domDiffAnchors": true,
    "graphql": true
  },
  "compatibility": "full"
}
```

探测过程只请求轻量端点，缓存结果 30 分钟。权限变化时允许手动重新探测。

## 8. GraphQL 使用策略

GraphQL 仅用于补充，不作为唯一事实来源：

- 批量获取 MR、diff refs、用户权限。
- 减少多个 REST 请求。
- 自部署 GraphQL schema 差异较大，必须版本探测。

写入评论仍优先 REST Discussions API，便于错误分类和版本兼容。

## 9. 限流与重试

- GET：指数退避 + 抖动，最多 3 次。
- POST discussion：不自动重试；保存 `clientRequestId`，通过读取 Discussions 去重后再允许用户重试。
- 大 MR：请求并发默认 2-3，可配置上限。
- 页面隐藏时暂停非关键预取。
- 尊重 `RateLimit-Remaining` / `Retry-After`。

## 10. 页面兼容测试矩阵

| 场景 | GitLab.com | CE 16.x | CE 17.x | 自定义主题 | 只读权限 |
| --- | --- | --- | --- | --- | --- |
| MR 识别 | 必测 | 必测 | 必测 | 必测 | 必测 |
| Diff 分页 | 必测 | 必测 | 必测 | 抽测 | 必测 |
| 划词行号 | 必测 | 必测 | 必测 | 必测 | 必测 |
| 行评论创建 | 必测 | 必测 | 必测 | 抽测 | 预期失败 |
| SPA 路由切换 | 必测 | 必测 | 必测 | 抽测 | 必测 |

## 11. DOM-only 降级

当 API 不可用：

- 可读取页面已渲染 Diff 文本和 data attributes。
- 可划词提问、Review 当前可见内容。
- 不读取完整仓库，不承诺跨文件上下文。
- 不创建行评论，只能复制草稿。
- UI 必须显示 `DOM-only` 与降级原因。
