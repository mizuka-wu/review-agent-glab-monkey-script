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

创建行评论：

```http
POST /api/v4/projects/:project/merge_requests/:iid/discussions
Content-Type: application/x-www-form-urlencoded

body=Review comment
position[position_type]=text
position[base_sha]=...
position[start_sha]=...
position[head_sha]=...
position[new_path]=src/checkout.ts
position[new_line]=42
```

旧路径行使用 `position[old_path]` 与 `position[old_line]`。跨多行建议使用 GitLab 目标版本支持的 `line_range`，否则只锚定最相关新增行。

## 4. 评论位置规则

### 4.1 可定位条件

同时满足：

- 当前 MR 拥有有效 `diff_refs`。
- Finding 的 `path` 存在于当前 Diff。
- `existingCode` 能在目标 Diff Hunk 中唯一或高置信匹配。
- `startLine` / `endLine` 位于新增行或明确可评论的上下文行。

### 4.2 行号来源优先级

1. API Diff 解析出的新文件行号。
2. Diff DOM 的 `data-new-line` / `data-old-line`。
3. 模型返回行号与 existingCode 交叉验证。

模型行号不能单独作为发布依据。

### 4.3 失败分类

- `diff_refs_missing`：缺少 base/start/head SHA。
- `path_not_in_diff`：文件不在当前 MR Diff。
- `line_out_of_diff`：目标行不是可评论行。
- `anchor_ambiguous`：existingCode 匹配多处且无法消歧。
- `stale_diff_refs`：MR 已更新，评论版本过期。
- `permission_denied`：当前身份不能创建 discussion。
- `rate_limited`：GitLab 返回限流。

任何失败都不应修改行号重试，除非重新构建并让用户再次确认。

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
