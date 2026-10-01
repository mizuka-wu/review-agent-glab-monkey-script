[简体中文](../security-privacy.md) | **English**

# Security, Privacy, and Key Management

## 1. Security Goals

- Never let GitLab or model tokens leak into pages, logs, screenshots, analytics, or third-party requests.
- By default, do not send the full repository or unrelated source code to the model.
- All GitLab writes are explicitly confirmed by the user.
- Keep clear trust boundaries between the browser page, the model provider, and the local Gateway.
- Local command execution is off by default; even when enabled it must never become a vector for arbitrary remote code execution.

## 2. Trust Boundaries

```text
[GitLab page / user session]
        │ selection, MR metadata, user confirmation
        ▼
[userscript UI] ─────► [GitLab API]
        │ minimal context              ▲
        │                              │ comments written only after confirmation
        ▼                              │
[model provider] ◄── [local Gateway] ──┘ (the Gateway holds no write permission)
                     │
                     ├─ model keys
                     ├─ local repository mirror
                     ├─ rules / cache
                     └─ optional restricted commands
```

## 3. Threat Model

| Threat | Scenario | Mitigation |
| --- | --- | --- |
| Page XSS / malicious code injection | MR filenames, comments, or model Markdown contain HTML | Shadow DOM, strict Markdown, raw HTML disabled, URL allowlist |
| Token leakage | API keys written into logs, errors, localStorage | Separate secret store, redaction, no persistence by default |
| Excessive source upload | Sending the whole repository or a lockfile to the model | Context Builder, filtering, budgets, send preview |
| Malicious Gateway | The page connects to a non-local service and uploads source code | User-confirmed origin, local token, first-connection fingerprint |
| Malicious model output | Returns dangerous links, commands, or misleading suggestions | Never execute model instructions, Markdown sanitization, human confirmation |
| Misfired comments | Wrong project, wrong line, duplicate comments | Confirmation step, project / MR display, fingerprint, idempotency |
| CSRF / cookie abuse | A malicious site triggers GitLab write operations | User gesture only, target origin validation, confirmation dialog |
| Local command execution | The model is talked into running arbitrary shell commands | Off by default, allowlist, fixed cwd, timeouts, auditing, no shell string concatenation |
| Supply chain attack | Dependency packages poisoned | lockfile, dependency auditing, minimal dependencies, build artifact inspection |
| Resource exhaustion | Huge Diffs / tool infinite loops | token / file / time / tool-call budgets, cancellation |

## 4. Key Management

### 4.1 Recommendation

Model API keys, enterprise gateway credentials, and high-privilege PATs are stored only in the local Gateway's system Keychain or in config files with `0600` permissions.

### 4.2 Direct browser mode

- Risks must be clearly flagged.
- Saving for the current session only is the default option.
- When the user explicitly chooses persistence, use the userscript's dedicated storage; do not write to plain `localStorage`.
- Always displayed masked in the UI; no "copy key" button.
- Must be stripped when exporting diagnostics / configuration.

### 4.3 GitLab authentication

- Prefer reusing the browser's cookies / CSRF token; do not store PATs long-term.
- If a PAT is used, prefer read-only scopes, and request the required permissions at comment-publishing time.
- Never send the GitLab token to the model provider or Gateway.
- Publishing requests are signed and sent by the browser-side transport.

## 5. Data Minimization

Sent by default:

- The user-selected code or the current Diff hunk.
- File path, line range, language.
- MR title, description, and necessary background.
- A summary of rule hits.

Not sent by default:

- The full repository that was not hit / not read.
- `.env`, secret files, credentials, tokens, private keys.
- lockfiles, binaries, full text of generated files.
- Page cookies, the Authorization header, CSRF tokens.
- Comments from other MRs and user identity information.

Before sending, the user can open the "context preview" to see a content summary and a token estimate of the final payload.

## 6. Redaction

Both the Context Builder and the logging layer perform redaction:

- Common tokens: `AKIA...`, `ghp_...`, `glpat-...`, Bearer tokens, JWTs.
- PEM private key blocks, password fields, connection strings.
- URL userinfo, query tokens.
- Regexes provided by custom team rules.

Redaction markers use the stable form `[REDACTED:type]`; original values are never written to logs. Whether sensitive content is replaced in the model context is controlled by user policy, but logs are always redacted.

## 7. XSS and Markdown

- React escapes text by default; never render model content with `dangerouslySetInnerHTML`.
- Markdown rendering disables raw HTML.
- Link protocols are limited to `http`, `https`, and `mailto`; external links show their target domain.
- Code blocks carry no executable content; suggestions are text-only previews.
- Filenames, paths, and model strings are all treated as untrusted input.
- Shadow DOM does not replace sanitization; both are required.

## 8. Content Security Policy and Cross-Origin

- Access explicitly allowed APIs via `GM_xmlhttpRequest` / `GM.fetch` wherever possible.
- Do not write `*://*/*` in the `connect` scope; self-hosted sites use runtime prompts and a configured allowlist.
- When the model provider fails cross-origin, guide the user to switch to a Gateway; never silently fall back to an insecure proxy in the frontend.
- Gateway CORS allows only user-confirmed GitLab origins.
- Never transmit data through third-party JSONP, image pixels, or dynamic scripts.

## 9. Local Gateway Security

### Networking

- Binds to `127.0.0.1` by default.
- Uses a random bearer token generated at startup; unauthenticated requests are not accepted.
- CORS origins use an explicit allowlist.
- Public-network listening is unsupported unless future versions add TLS, authentication, and organization policies.

### Filesystem

- Only accesses project directories mapped by the user.
- Repository paths are normalized and prefix-checked to block `../` and symlink escapes.
- Never accepts arbitrary absolute paths from browser payloads.
- Cache directory permissions are minimized.

### Command execution

Off by default. When enabled:

- Only executes executables allowlisted in the configuration with fixed argument templates.
- Uses argument arrays; never concatenates shell strings.
- Fixed working directory, timeouts, output caps.
- Sanitizes environment variables, keeping only the allowlist.
- Audits command ID, duration, and exit code; does not record full output that may contain secrets.

## 10. User Confirmation Policy

The following actions require explicit confirmation:

- Sending code to the model for the first time.
- Connecting to a new Gateway origin.
- Creating a GitLab Discussion.
- Publishing multiple comments at once.
- Enabling local command execution.
- Exporting a review report that contains code content.

The following actions do not require confirmation every time:

- Reading public content of the current page.
- Opening the sidebar, copying non-sensitive text.
- Sending user-initiated questions to an already-confirmed provider.

## 11. Privacy Modes

### Local-first

- Connects only to a local Gateway / local models.
- External telemetry is forbidden.
- Sessions are cleaned up after 24 hours by default.

### Standard

- Allows user-configured cloud models.
- A context summary can be reviewed before sending.
- Persists only Finding metadata and user state.

### Diagnostics

- Temporarily records redacted logs.
- Automatically expires after 30 minutes.
- Scans tokens and paths again before export.

## 12. Audit Events

Recommended records:

- `context.created`: file count, token estimate, redaction count.
- `runtime.connected`: runtime type, model alias, version.
- `run.started/completed/failed/cancelled`.
- `finding.ignored/accepted`.
- `discussion.publish.requested/succeeded/failed`.
- `command.executed` (after command execution is enabled).

Do not record full source code, full prompts, API keys, cookies, or Authorization.

## 13. Dependency and Build Security

- Commit `pnpm-lock.yaml`.
- CI runs `pnpm audit` and license checks.
- Reduce direct model SDK dependencies; provider adaptation is preferably handled by the Gateway.
- Build artifacts are checked to ensure the metadata `@connect` / `@grant` matches what is declared.
- Loading executable scripts from remote sources during the build is forbidden.

## 14. Incident Response

- Suspected key leakage: immediately revoke the GitLab / model token, delete script storage, and inspect access logs.
- Misfired comment: delete / edit through the GitLab discussion, keeping the publish record.
- Unexpected outbound connections from the Gateway: disconnect the network, disable the service, export the redacted audit trail.
- Malicious model output discovered: stop the task, preserve the event, add a deny rule.

## 15. Pre-release Security Checklist

- [ ] No token appears in build artifacts, source maps, or logs.
- [ ] Markdown raw HTML is disabled.
- [ ] All write operations have user confirmation.
- [ ] Self-hosted origins are not arbitrary wildcards.
- [ ] Gateway defaults to loopback + token.
- [ ] Command execution is off by default.
- [ ] Dependency audit has no unaccepted high-risk issues.
- [ ] The data-sending preview matches the actual payload.
