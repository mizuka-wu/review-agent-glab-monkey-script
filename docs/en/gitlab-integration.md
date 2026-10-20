[简体中文](../gitlab-integration.md) | **English**

# GitLab / Self-Hosted GitLab Integration

## 1. Support Scope

### First priority

- GitLab.com.
- Common self-hosted versions of GitLab CE / EE.
- MR Changes / Diff / Discussion pages.
- File / Blob pages and Commit Diff pages as additional entry points.

### Second priority

- Self-hosted / private sites that stay compatible with GitLab API v4.
- Sites with a custom theme that retain the standard DOM data attributes.
- Sites with read-only API permissions, allowing analysis and copying of comments.

### Conditional support

- Sites with only a DOM and no usable API: select-to-ask and on-page diff Review only.
- GitLab forks with modified routes / APIs: integrated through a separate adapter.
- Non-GitLab platforms such as Gitea / Gogs / Codeup: outside the M1-M4 commitment scope.

## 2. Page Context Parsing

### 2.1 URL

Typical MR routes:

```text
https://gitlab.example.com/group/subgroup/project/-/merge_requests/123
https://gitlab.example.com/group/subgroup/project/-/merge_requests/123/diffs
https://gitlab.example.com/group/subgroup/project/-/merge_requests/123/commits/abc123
```

Parsing rules:

- `projectPath` takes the pathname before `/-/`, preserving subgroups.
- `mergeRequestIid` takes the decimal number after `merge_requests/`.
- Ignore queries / hashes such as `?page=`, `?view=`, and `#note_`.
- For encoded paths, apply `decodeURIComponent` first, then perform API path encoding.

File routes:

```text
/-/blob/<ref>/<path>
/-/raw/<ref>/<path>
/-/tree/<ref>/<path>
```

### 2.2 DOM Selectors

The DOM is only a supplement; prefer:

- Stable attributes such as `data-project-id`, `data-merge-request-id`, and `data-file-path`.
- `data-qa-element` / `data-testid` only when the API is unavailable.
- Never rely on generated class names, component-internal ordering, or deep CSS paths.

Each adapter returns a confidence value for DOM parsing results; low-confidence results do not enter the publishing pipeline.

## 3. GitLab REST API

### 3.1 Project Identification

Prefer the URL-encoded `projectPath`; do not depend heavily on the numeric ID:

```http
GET /api/v4/projects/group%2Fsubgroup%2Fproject
```

The `id` in the response can be cached for the current session.

### 3.2 Merge Request

```http
GET /api/v4/projects/:project/merge_requests/:iid
```

Key fields:

- `id`, `iid`, `project_id`
- `title`, `description`, `state`
- `source_branch`, `target_branch`
- `sha`, `diff_refs`
- `has_conflicts`, `blocking_discussions_resolved`

`diff_refs`:

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

Fields:

- `old_path`, `new_path`
- `diff`, `renamed_file`, `deleted_file`, `new_file`
- `too_large`, `generated_file`

Large MRs must be paginated. The `changes` endpoint can serve as a compatibility fallback, but should not be loaded all at once by default.

### 3.4 MR Versions

```http
GET /api/v4/projects/:project/merge_requests/:iid/versions
```

Used to determine whether a diff version is stale, and for comment anchoring on some GitLab versions.

### 3.5 File Content

```http
GET /api/v4/projects/:project/repository/files/:encoded_path/raw?ref=:sha
```

Requirements:

- Use `head_sha` or an explicit ref; never build evidence from a mutable branch name.
- Reading a line range of a large file is done by the Gateway; the REST raw endpoint returns the full content.
- Skip binary / LFS files and record the reason.

### 3.6 Discussions

Reading:

```http
GET /api/v4/projects/:project/merge_requests/:iid/discussions?per_page=100
```

Creating a line comment (always a JSON body):

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

For lines on the old path, use `old_path` with `old_line`. For multiple lines, add `line_range` whose
`start` / `end` each carry **only** `line_code` and `type` (otherwise anchor only the most relevant
added line). The MR-level summary note uses the sibling `POST .../notes` endpoint with a JSON body as
well (a single `body` key).

```json
"line_range": {
  "start": { "line_code": "52007ba039cb50ce9a88ec2b8d9a9f1f8996d6e8_0_16", "type": "new" },
  "end":   { "line_code": "52007ba039cb50ce9a88ec2b8d9a9f1f8996d6e8_16_17", "type": "old" }
}
```

Inside `line_range`, `old_line` / `new_line` are **not** sent at all: on GitLab 16/17 these two keys
collide on type ([gitlab#572121](https://gitlab.com/gitlab-org/gitlab/-/issues/572121)) — the API
parameter layer declares them as `String` while the `position.json` validator declares
`integer|null`. A string fails the schema, an integer fails the parameter layer, and both answers are
400 `{:position=>['must be a valid json schema']}`. 0.4.26 zero-filled the missing side to send all
four keys and landed exactly on that collision; 0.4.27 reverts it. The line numbers already live in
`line_code` (`SHA1(new_path.presence || old_path)_old_line_new_line`, the missing side encoded as `0`
inside a string, where no type collision exists), and `line_code` is what GitLab actually resolves a
multi-line range from: its own `MergeRequests::ResolveDiffPositionService#build_line_range_entry`
likewise guarantees only `line_code` + `type`, attaching `old_line` / `new_line` merely when present.
Measured on the 19.4 container, the two-key shape publishes with 201 and is stored verbatim as
`{"start":{"line_code":…,"type":"new"},"end":{"line_code":…,"type":"old"}}` (the server adds no line
number keys of its own).

The top-level `old_line` / `new_line` are untouched: the collision only exists inside `line_range`, so
the top level still sends only the side that really exists (GitLab matches those two exactly against
diff lines — an added line has only `new_line`, a removed line only `old_line`, and a 0 would match
nothing). Single-line comments therefore keep having no `line_range` at all.

Never `application/x-www-form-urlencoded`: form encoding flattens the nested
`position[line_range][start][line_code]` fields, and on older GitLab releases over the Tampermonkey
`GM.xmlHttpRequest` path the server parses that into a malformed position, answering
400 `position must be a valid json schema`. JSON sends the native structure, and the top-level line
numbers are natively integers (`old_line` / `new_line` are `integer` in `position.json`) instead of
relying on form string coercion. The only endpoint still taking the form default `Content-Type` is the bodyless
`POST .../approve`.

## 4. Comment Position Rules

### 4.1 Conditions for Anchoring

All of the following must hold:

- The current MR has valid `diff_refs`.
- The Finding's `path` exists in the current diff.
- `existingCode` matches uniquely or with high confidence inside the target diff hunk.
- `startLine` / `endLine` fall on added lines or on context lines that are explicitly commentable.

### 4.2 Line Number Source Priority

1. New-file line numbers parsed from the API diff.
2. `data-new-line` / `data-old-line` from the diff DOM.
3. Cross-validation of model-returned line numbers against existingCode.

Model line numbers alone cannot serve as the basis for publishing.

### 4.3 Failure Classification

- `diff_refs_missing`: missing base/start/head SHAs.
- `path_not_in_diff`: the file is not in the current MR diff.
- `line_out_of_diff`: the target line is not a commentable line.
- `anchor_ambiguous`: existingCode matches in multiple places and cannot be disambiguated.
- `stale_diff_refs`: the MR has been updated and the comment's version is stale.
- `permission_denied`: the current identity cannot create a discussion.
- `rate_limited`: GitLab returned a rate limit.

No failure should be retried by altering line numbers, unless the context is rebuilt and the user confirms again.

## 5. Authentication Modes

### 5.1 Current Browser Session

- Same-origin API requests carry cookies.
- Write requests need a GitLab CSRF token, usually read from a meta tag.
- Advantage: no stored PAT; suitable for enterprise SSO.
- Limitation: a cross-origin Gateway cannot reuse cookies; site policy may forbid script requests.

### 5.2 Personal / Project Access Token

- Entered explicitly by the user, with minimal privileges.
- Read/write features require `api` or the minimal scope the site supports.
- Prefer storing it in the local Gateway; direct mode displays the risks explicitly.
- Never written to logs, errors, analytics, or exported diagnostics.

### 5.3 Recommendations

- By default, try the current session first, preferring read-only requests.
- Check permissions before publishing; do not proactively ask for high-privilege tokens.
- In Gateway mode the browser handles GitLab reads and writes; the Gateway stores no GitLab token.

## 6. Authenticated Request Implementation

A unified `GitLabTransport`:

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

Requirements:

- Automatically encode project paths and file paths.
- Unified handling of timeouts, AbortSignal, retries, and rate limits.
- Do not repeatedly prompt for login on 401 / 403.
- On 429, honor `Retry-After` and retry only idempotent GETs; never automatically repeat POSTs.
- POST publishing uses `clientRequestId` for idempotency protection.

## 7. Self-Hosted Site Capability Detection

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

The detection process requests only lightweight endpoints and caches the results for 30 minutes. Manual re-detection is allowed when permissions change.

## 8. GraphQL Usage Policy

GraphQL is used only as a supplement, never as the sole source of truth:

- Fetching MRs, diff refs, and user permissions in batches.
- Reducing the number of REST requests.
- Self-hosted GraphQL schemas vary considerably; version detection is mandatory.

Writing comments still prefers the REST Discussions API, for easier error classification and version compatibility.

## 9. Rate Limiting and Retry

- GET: exponential backoff + jitter, at most 3 attempts.
- POST discussion: no automatic retry; store `clientRequestId`, deduplicate by reading Discussions, then let the user retry.
- Large MRs: request concurrency defaults to 2-3, with a configurable upper bound.
- Pause non-critical prefetching while the page is hidden.
- Respect `RateLimit-Remaining` / `Retry-After`.

## 10. Page Compatibility Test Matrix

| Scenario | GitLab.com | CE 16.x | CE 17.x | Custom theme | Read-only permissions |
| --- | --- | --- | --- | --- | --- |
| MR detection | Required | Required | Required | Required | Required |
| Diff pagination | Required | Required | Required | Spot check | Required |
| Selection line numbers | Required | Required | Required | Required | Required |
| Line comment creation | Required | Required | Required | Spot check | Expected failure |
| SPA route switching | Required | Required | Required | Spot check | Required |

## 11. DOM-Only Fallback

When the API is unavailable:

- Rendered diff text and data attributes on the page can be read.
- Select-to-ask and Review of the currently visible content are possible.
- The full repository is not read, and cross-file context is not promised.
- Line comments cannot be created; drafts can only be copied.
- The UI must display `DOM-only` and the reason for the fallback.
