[简体中文](../ux-flows-and-prototype.md) | **English**

# UX Flows and Prototype Notes

## 1. Prototype Goals

The current prototype is used to confirm interactions, states, and information architecture. It does not connect to a real GitLab, does not read a real repository, and does not call a model. The code, Findings, tool traces, and publish results in the prototype are all simulated data.

The prototype covers four key flows:

1. Select-to-ask.
2. Select-to-review.
3. Whole-MR review.
4. Finding review and confirmed publishing.

## 2. Page Layout

```text
┌────────────────────────────────────────────────────────────────────┐
│ GitLab top navigation                                              │
├──────────┬─────────────────────────────────────┬───────────────────┤
│ GitLab   │ MR info / Diff                      │ Review Agent      │
│ nav      │                                     │ sessions / review │
│          │  code rows                          │ settings          │
│          │  [selection floating toolbar]       │  Chatbox          │
│          │                                     │  Findings         │
└──────────┴─────────────────────────────────────┴───────────────────┘
```

- `>= 1100px`: the Agent sidebar is permanently on the right; the MR content keeps the primary reading width.
- `760-1099px`: the Agent sidebar overlays the MR and can be closed.
- `< 760px`: a bottom drawer-style Agent; the selection toolbar moves to just below the selection.

## 3. Select-to-ask Flow

### Trigger

The user selects 1–200 lines of text in the code area, and the selection does not overlap the Review Agent UI.

### Behavior

1. Show the floating toolbar: `Ask`, `Review this`, `Copy`.
2. The toolbar does not exceed the available space above the selection's width; when necessary it flips to below the selection.
3. Clicking `Ask` opens the Chatbox and automatically adds the code attachment.
4. The Composer shows the current context: file, line range, and selected character count.
5. After sending, the user's message is shown first, then the streaming answer.

### Exception states

- File / line number cannot be identified: asking is still allowed; the attachment is marked as `page selection`.
- Selection too long: prompt to trim to 200 lines, letting the user take the first 200 lines or cancel.
- Model not configured: open settings and keep the pending question.

## 4. Select-to-review Flow

### Trigger

Click `Review this` on the floating toolbar, or select `selected code only` on the Review page of the sidebar.

### States

```text
Prepare context → Analyze selected code → Verify evidence → Locate comments → Done
```

- Stage progress is a set of discrete states, not meaningless infinite animations.
- Tool calls show a collapsed summary, e.g. `file_search · CheckoutService`.
- When no issues are found, show `No high-confidence issues found` and do not generate empty comments.

## 5. MR Review Flow

### Scope selection

- `All changes`: all analyzable files in the current MR.
- `Current file`: analyze only the current Diff file.
- `Custom files`: check files from the changed-files list.

### Run page

Shows:

- Files processed / total files.
- Current stage and the most recent tool call.
- token / time budget (when a Gateway is present).
- A `Cancel` button.

### Results page

- The top keeps only severity counts and filters; no stacked KPI cards.
- Findings are sorted `critical → high → medium → low` by default.
- Low-confidence results are collapsed by default, with the reason shown.
- Each Finding shows: location, category, severity, title, evidence, suggestion.

## 6. Finding Interactions

Primary actions for each Finding:

- `Locate`: scroll to and highlight the corresponding Diff line.
- `Edit draft`: edit the Markdown that will be sent to GitLab.
- `Copy`: copy the comment without writing to GitLab.
- `Publish to GitLab`: open the second confirmation.
- `Ignore`: record the state without deleting the original result.

### Publish confirmation dialog

Must display:

- Project and MR IID.
- File path and target line.
- The full comment Markdown.
- A summary of the current Diff SHA / version.
- `Confirm publish` and `Back to edit`.

After a successful publish, the state updates to `Published` and the discussion link becomes clickable. On failure, the draft and the error reason are kept.

## 7. Chatbox States

### Empty state

Show 3 suggestions based on the current context; no marketing content.

### With a code attachment

The attachment bar shows: file, line range, the `selection` / `hunk` / `file` type, and a remove button.

### Streaming state

- The answer area keeps a stable width to avoid re-layout on every token.
- Tool calls show a collapsible trace before the answer.
- `Stop` cancels the current request; already generated content is kept.

### Error states

- `Model not connected`: the primary action is to open settings.
- `Request timed out`: retry is allowed; the question and attachments are kept.
- `Context over budget`: allow removing attachments or switching to the Gateway.

## 8. Settings and Diagnostics

Settings are divided into four groups:

1. **Run mode**: direct browser connection / local Gateway.
2. **Model connection**: base URL, model, key, connection test.
3. **GitLab**: authentication mode, site allowlist, publish confirmation policy.
4. **Review**: severity filter, language, rules, data-sending preview.

The diagnostics page shows:

- The current site adaptation level: `full` / `read-only` / `dom-only` / `unsupported`.
- Connection status of the GitLab API, the model, and the Gateway.
- The PageContext extractable from the current page.
- The capability matrix and the reasons for degradation.

## 9. Visual Guidelines

- Reference GitLab's light, neutral interface; the Agent sidebar uses a clear dark header area for product identity and does not imitate GitLab branding.
- Color is used only for state: severity, connection status, Diff additions/deletions, focus.
- Icon buttons must have an `aria-label` or tooltip.
- Large gradients, decorative spheres, and information-free dashboards are forbidden.
- The code area uses a monospace font; Markdown body text uses the product UI font.

## 10. Accessibility

- All actions can be completed with the keyboard; the floating toolbar enters `role="toolbar"`.
- Esc closes the toolbar / dialog and returns focus to the triggering button.
- Severity is not conveyed by color alone; text labels are shown.
- Streaming answers use `aria-live="polite"`; errors use `role="alert"`.
- `prefers-reduced-motion` is supported.
- Text contrast meets WCAG AA.

## 11. Prototype Interaction Paths

### Path A: Select-to-ask

1. Drag-select the code around the `checkoutInventory` call in the mock code area.
2. Click `Ask` on the floating toolbar.
3. Type a question on the right and send it.
4. Watch the simulated streaming answer.

### Path B: Review and publishing

1. Click `Start review` in the top right.
2. Watch the preparing, analyzing, and locating stages.
3. Expand a high-severity Finding.
4. Click `Publish to GitLab`.
5. Review the target line and the comment in the confirmation dialog.
6. After confirming, see the `Published` state.

### Path C: Capability boundaries

1. Open `Settings` on the right.
2. Inspect the browser, GitLab API, and Gateway status.
3. Switch the "direct browser connection / local Gateway" run mode.
4. Watch the capability matrix change.

## 12. Differences Between Prototype and Production

| Prototype | Production implementation |
| --- | --- |
| A fixed mock GitLab page | Injects into a real GitLab Shadow DOM |
| Stages simulated with fixed delays after a click | Consumes the real AgentEvent stream |
| Findings are fixed samples | Schema validation + locating + reflective generation |
| Publishing only updates local state | Calls the GitLab Discussions API |
| Settings states are demo values | Runs real probes / connectivity tests |
| Plain React DOM | Shadow DOM + userscript lifecycle |

## 13. Prototype Screenshots

After building and running `pnpm dev`, screenshots of the following states should be kept and included in the PR:

- `docs/assets/prototype-mr-overview.png`
- `docs/assets/prototype-selection-toolbar.png`
- `docs/assets/prototype-review-running.png`
- `docs/assets/prototype-finding-publish.png`
- `docs/assets/prototype-capability-settings.png`

Screenshots must use a fixed `1440x1000` viewport, with no devtools and no unrelated desktop content.
