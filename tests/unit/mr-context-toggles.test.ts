import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { SettingsView } from '../../src/components/SettingsView';
import { mrCommitsContext, mrDescriptionContext } from '../../src/core/context';
import { debugBus } from '../../src/core/debug-bus';
import { buildDelegationContext } from '../../src/core/delegation';
import { normalizeFileDiff } from '../../src/core/diff';
import { loadReferenceMr, loadReferenceMrs, referenceContextBlock } from '../../src/core/reference-mrs';
import { ReviewEngine } from '../../src/core/review-engine';
import { BUILT_IN_PACK } from '../../src/core/rule-packs';
import { defaultSettings, loadSettings, saveSettings } from '../../src/core/settings';
import { summarizeReviewContext } from '../../src/core/session';
import type {
  FileDiff, MergeRequestContext, MrCommit, MrLinkRef, PageContext, ReferenceMr, RuntimeSettings,
} from '../../src/core/types';

const STORAGE_KEY = 'review-agent-settings-v1';

const baseSettings = {
  provider: 'openai', modelBaseUrl: 'https://model.test/v1', apiKey: 'key', model: 'model',
  gitlabToken: '', effort: 'balanced', reviewMode: 'hybrid', language: 'zh-CN',
  mcp: { enabled: false, servers: [] }, auth: { mode: 'bearer', customHeaders: {}, apiKeyHeader: 'Authorization', apiKeyQueryParam: 'key' },
  repoIndex: { enabled: false, maxFiles: 100, maxBytes: 1000, maxIndexes: 3 },
  projectPrompts: {}, repoContext: false, debugEnabled: false, thinking: 'default',
  // 出厂默认两个开关都是关的：引擎用例要验的是「打开后」的行为，这里显式打开
  includeMrDescription: true, includeMrCommits: true,
} as unknown as RuntimeSettings;

const settings = (patch: Partial<RuntimeSettings> = {}): RuntimeSettings => ({ ...baseSettings, ...patch });

function diffFile(path: string, diff: string): FileDiff {
  return normalizeFileDiff({ old_path: path, new_path: path, diff });
}

const currentFiles = [diffFile('src/current.ts', '@@ -1,2 +1,3 @@\n export function pay() {\n+  return charge();\n }')];

const DESCRIPTION = '## 需求\n支付失败时必须给出可操作的错误提示。\n\n- 密钥不进日志\n- 重试最多 3 次';

function commit(overrides: Partial<MrCommit> = {}): MrCommit {
  return {
    id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    shortId: 'a1b2c3d4',
    title: 'feat(pay): 支持支付失败重试',
    message: 'feat(pay): 支持支付失败重试\n\n需求：支付网关超时后最多重试 3 次，指数退避。',
    authorName: 'mizuka',
    createdAt: '2026-10-13T10:00:00.000Z',
    ...overrides,
  };
}

const COMMITS: MrCommit[] = [commit()];

function runtimeReturning(findings: unknown[] = []) {
  return {
    configured: true,
    review: vi.fn().mockResolvedValue(JSON.stringify({ findings })),
    reflect: vi.fn().mockResolvedValue('[]'),
  };
}

function reviewOptions(runtime: ReturnType<typeof runtimeReturning>, call = 0) {
  return runtime.review.mock.calls[call][5] as { mrDescription?: string; mrCommits?: string; references?: string };
}

const companionRef: MrLinkRef = { origin: 'https://other.test', projectPath: 'platform/sdk', iid: 12 };

function reference(overrides: Partial<ReferenceMr> = {}): ReferenceMr {
  return {
    ref: companionRef, status: 'ready', title: 'feat: companion token endpoint', headSha: 'abcdef1234567890',
    addedAt: '2026-10-13T10:00:00.000Z',
    description: '配套改动说明',
    commits: COMMITS,
    files: [diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')],
    ...overrides,
  };
}

function companionContext(): MergeRequestContext {
  return {
    origin: companionRef.origin, projectPath: companionRef.projectPath, mergeRequestIid: companionRef.iid,
    title: 'feat: companion', description: '配套改动说明', state: 'opened',
    sourceBranch: 'feat/x', targetBranch: 'main', sha: 'head',
    diffRefs: { baseSha: 'base', headSha: 'abcdef1234567890', startSha: 'start' },
  };
}

describe('两个开关的默认值与两级迁移', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to off so nothing reaches the context until the user turns it on', () => {
    expect(defaultSettings.includeMrDescription).toBe(false);
    expect(defaultSettings.includeMrCommits).toBe(false);
  });

  it('fills both with false when nothing was ever stored', async () => {
    const loaded = await loadSettings();
    expect(loaded.includeMrDescription).toBe(false);
    expect(loaded.includeMrCommits).toBe(false);
  });

  it('fills both with false for settings saved before the switches existed', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      provider: 'openai', modelBaseUrl: 'https://gw.test/v1', model: 'm', repoContext: false,
      debugEnabled: true, applyFixEnabled: true,
    }));
    const loaded = await loadSettings();
    expect(loaded.includeMrDescription).toBe(false);
    expect(loaded.includeMrCommits).toBe(false);
    expect(loaded.repoContext).toBe(false);
    expect(loaded.applyFixEnabled).toBe(true);
  });

  it('reads back a true stored by the release that defaulted to on, and defaults the untouched one off', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      provider: 'openai', modelBaseUrl: 'https://gw.test/v1', model: 'm', includeMrDescription: true,
    }));
    const loaded = await loadSettings();
    expect(loaded.includeMrDescription).toBe(true);
    expect(loaded.includeMrCommits).toBe(false);
  });

  it('keeps an explicit on across a save/load round trip', async () => {
    await saveSettings(settings({ includeMrDescription: true, includeMrCommits: true, apiKey: 'key' }));
    const loaded = await loadSettings();
    expect(loaded.includeMrDescription).toBe(true);
    expect(loaded.includeMrCommits).toBe(true);
    expect(loaded.apiKey).toBe('key');
  });

  it('keeps an explicit off across a save/load round trip', async () => {
    await saveSettings(settings({ includeMrDescription: false, includeMrCommits: false, apiKey: 'key' }));
    const loaded = await loadSettings();
    expect(loaded.includeMrDescription).toBe(false);
    expect(loaded.includeMrCommits).toBe(false);
    expect(loaded.apiKey).toBe('key');
  });

  it('keeps the two switches independent in storage', async () => {
    await saveSettings(settings({ includeMrCommits: false }));
    const loaded = await loadSettings();
    expect(loaded.includeMrDescription).toBe(true);
    expect(loaded.includeMrCommits).toBe(false);
  });
});

describe('ReviewEngine skips the whole section when the switch is off', () => {
  it('drops the description block and stops charging its characters', async () => {
    const runtime = runtimeReturning();
    const engine = new ReviewEngine(runtime, settings({ includeMrDescription: false }));
    const result = await engine.run({ files: currentFiles, mrDescription: DESCRIPTION, mrCommits: COMMITS });

    expect(reviewOptions(runtime).mrDescription).toBeUndefined();
    expect(result.context.descriptionCharacters).toBe(0);
    expect(summarizeReviewContext(result.context).descriptionCharacters).toBeUndefined();

    const baseline = await new ReviewEngine(runtimeReturning(), settings())
      .run({ files: currentFiles, mrCommits: COMMITS });
    expect(result.context.estimatedCharacters).toBe(baseline.context.estimatedCharacters);
  });

  it('drops both blocks and charges nothing when the engine runs on the shipped defaults', async () => {
    const runtime = runtimeReturning();
    const result = await new ReviewEngine(runtime, defaultSettings)
      .run({ files: currentFiles, mrDescription: DESCRIPTION, mrCommits: COMMITS });

    expect(reviewOptions(runtime).mrDescription).toBeUndefined();
    expect(reviewOptions(runtime).mrCommits).toBeUndefined();
    expect(result.context.descriptionCharacters).toBe(0);
    expect(result.context.commitsCharacters).toBe(0);
    const summary = summarizeReviewContext(result.context);
    expect(summary.descriptionCharacters).toBeUndefined();
    expect(summary.commitsCharacters).toBeUndefined();

    const bare = await new ReviewEngine(runtimeReturning(), settings({ includeMrDescription: false, includeMrCommits: false }))
      .run({ files: currentFiles, mrDescription: DESCRIPTION, mrCommits: COMMITS });
    expect(result.context.estimatedCharacters).toBe(bare.context.estimatedCharacters);
  });

  it('drops the commits block and stops charging its characters', async () => {
    const runtime = runtimeReturning();
    const engine = new ReviewEngine(runtime, settings({ includeMrCommits: false }));
    const result = await engine.run({ files: currentFiles, mrDescription: DESCRIPTION, mrCommits: COMMITS });

    expect(reviewOptions(runtime).mrCommits).toBeUndefined();
    expect(result.context.commitsCharacters).toBe(0);
    expect(summarizeReviewContext(result.context).commitsCharacters).toBeUndefined();

    const baseline = await new ReviewEngine(runtimeReturning(), settings())
      .run({ files: currentFiles, mrDescription: DESCRIPTION });
    expect(result.context.estimatedCharacters).toBe(baseline.context.estimatedCharacters);
  });

  it('keeps the other section untouched when only one switch is off', async () => {
    const runtime = runtimeReturning();
    await new ReviewEngine(runtime, settings({ includeMrDescription: false }))
      .run({ files: currentFiles, mrDescription: DESCRIPTION, mrCommits: COMMITS });

    expect(reviewOptions(runtime).mrDescription).toBeUndefined();
    expect(reviewOptions(runtime).mrCommits).toContain('## MR Commits');
    expect(reviewOptions(runtime).mrCommits).toContain('最多重试 3 次');
  });

  it('keeps the other section untouched when only the commits switch is off', async () => {
    const runtime = runtimeReturning();
    const result = await new ReviewEngine(runtime, settings({ includeMrCommits: false }))
      .run({ files: currentFiles, mrDescription: DESCRIPTION, mrCommits: COMMITS });

    expect(reviewOptions(runtime).mrCommits).toBeUndefined();
    expect(reviewOptions(runtime).mrDescription).toContain('## MR 说明');
    expect(result.context.descriptionCharacters).toBeGreaterThan(0);
  });

  it('renders both sections and charges both when the switches stay on', async () => {
    const runtime = runtimeReturning();
    const result = await new ReviewEngine(runtime, settings())
      .run({ files: currentFiles, mrDescription: DESCRIPTION, mrCommits: COMMITS });

    expect(reviewOptions(runtime).mrDescription).toContain('## MR 说明');
    expect(reviewOptions(runtime).mrCommits).toContain('## MR Commits');
    expect(result.context.descriptionCharacters).toBe(mrDescriptionContext(DESCRIPTION).length);
    expect(result.context.commitsCharacters).toBe(mrCommitsContext(COMMITS).length);

    const bare = await new ReviewEngine(runtimeReturning(), settings({ includeMrDescription: false, includeMrCommits: false }))
      .run({ files: currentFiles, mrDescription: DESCRIPTION, mrCommits: COMMITS });
    expect(bare.context.estimatedCharacters)
      .toBe(result.context.estimatedCharacters - result.context.descriptionCharacters - result.context.commitsCharacters);
  });

  it('drops the section on every bundle of a split review', async () => {
    const manyFiles = Array.from({ length: 8 }, (_, index) =>
      diffFile(`src/file-${index}.ts`, `@@ -1 +1,2 @@\n-old\n+const value${index} = ${index};`));
    const runtime = runtimeReturning();
    await new ReviewEngine(runtime, settings({ includeMrDescription: false, includeMrCommits: false }))
      .run({ files: manyFiles, mrDescription: DESCRIPTION, mrCommits: COMMITS });

    expect(runtime.review.mock.calls.length).toBeGreaterThan(1);
    for (const call of runtime.review.mock.calls) {
      const options = call[5] as { mrDescription?: string; mrCommits?: string };
      expect(options.mrDescription).toBeUndefined();
      expect(options.mrCommits).toBeUndefined();
    }
  });

  it('charges nothing in rules-only mode either', async () => {
    const runtime = { configured: false, review: vi.fn(), reflect: vi.fn() };
    const result = await new ReviewEngine(runtime, settings({ includeMrDescription: false, includeMrCommits: false }), [BUILT_IN_PACK])
      .run({ files: currentFiles, mrDescription: DESCRIPTION, mrCommits: COMMITS });

    expect(runtime.review).not.toHaveBeenCalled();
    expect(result.context.descriptionCharacters).toBe(0);
    expect(result.context.commitsCharacters).toBe(0);
  });
});


describe('reference MR sections follow the same switches', () => {
  it('leaves the reference description out when the switch is off', () => {
    const block = referenceContextBlock([reference()], undefined, { description: false });
    expect(block.text).not.toContain('MR 说明');
    expect(block.text).not.toContain('配套改动说明');
    expect(block.text).toContain('[参考 platform/sdk!12] MR Commits');
    expect(block.text).toContain('src/companion.ts');
  });

  it('leaves the reference commits out when the switch is off', () => {
    const block = referenceContextBlock([reference()], undefined, { commits: false });
    expect(block.text).not.toContain('MR Commits');
    expect(block.text).not.toContain('最多重试 3 次');
    expect(block.text).toContain('[参考 platform/sdk!12] MR 说明');
    expect(block.text).toContain('src/companion.ts');
  });

  it('drops both sections without leaving an empty heading behind', () => {
    const block = referenceContextBlock([reference()], undefined, { description: false, commits: false });
    expect(block.text).not.toContain('MR 说明');
    expect(block.text).not.toContain('MR Commits');
    expect(block.text.split('####').length - 1).toBe(1);
    expect(block.text).toContain('### 参考 MR 1：platform/sdk!12');
    expect(block.text).toContain('#### [参考 platform/sdk!12] src/companion.ts');
  });

  it('gives the freed budget back to the reference diffs', () => {
    const files = Array.from({ length: 30 }, (_, index) =>
      diffFile(`src/file-${index}.ts`, '@@ -1 +1,10 @@\n+const v = 1;'.repeat(10)));
    const full = referenceContextBlock([reference({ files })], 4_000);
    const trimmed = referenceContextBlock([reference({ files })], 4_000, { description: false, commits: false });
    expect(trimmed.fileCount).toBeGreaterThan(full.fileCount);
    expect(trimmed.text).not.toContain('配套改动说明');
  });

  it('keeps the reference sections when both switches stay on', () => {
    const { text } = referenceContextBlock([reference()]);
    expect(text).toContain('[参考 platform/sdk!12] MR 说明');
    expect(text).toContain('[参考 platform/sdk!12] MR Commits');
  });

  it('passes the switches through the engine into the model input', async () => {
    const runtime = runtimeReturning();
    const result = await new ReviewEngine(runtime, settings({ includeMrDescription: false, includeMrCommits: false }))
      .run({ files: currentFiles, mrDescription: DESCRIPTION, mrCommits: COMMITS, references: [reference()] });

    const options = reviewOptions(runtime);
    expect(options.references).toContain('## 参考变更');
    expect(options.references).not.toContain('MR 说明');
    expect(options.references).not.toContain('MR Commits');
    expect(options.references).toContain('src/companion.ts');

    const baseline = await new ReviewEngine(runtimeReturning(), settings())
      .run({ files: currentFiles, references: [reference()] });
    expect(result.context.referenceCharacters).toBeLessThan(baseline.context.referenceCharacters);
  });

  it('does not call the commits endpoint of a reference MR when the switch is off', async () => {
    const listMrCommits = vi.fn().mockResolvedValue(COMMITS);
    const loaded = await loadReferenceMr(companionRef, {
      getMergeRequest: vi.fn().mockResolvedValue(companionContext()),
      listDiffs: vi.fn().mockResolvedValue([diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')]),
      listMrCommits,
    }, undefined, { commits: false });

    expect(listMrCommits).not.toHaveBeenCalled();
    expect(loaded.status).toBe('ready');
    expect(loaded.commits).toBeUndefined();
    expect(loaded.description).toBe('配套改动说明');
    expect(loaded.files).toHaveLength(1);
  });

  it('still calls it when the switch is on', async () => {
    const listMrCommits = vi.fn().mockResolvedValue(COMMITS);
    const loaded = await loadReferenceMr(companionRef, {
      getMergeRequest: vi.fn().mockResolvedValue(companionContext()),
      listDiffs: vi.fn().mockResolvedValue([diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')]),
      listMrCommits,
    });

    expect(listMrCommits).toHaveBeenCalledTimes(1);
    expect(loaded.commits).toEqual(COMMITS);
  });

  it('applies to every reference MR loaded in one batch', async () => {
    const listMrCommits = vi.fn().mockResolvedValue(COMMITS);
    const other: MrLinkRef = { origin: 'https://other.test', projectPath: 'platform/web', iid: 30 };
    const loaded = await loadReferenceMrs(
      [companionRef, other],
      () => ({
        getMergeRequest: vi.fn().mockResolvedValue(companionContext()),
        listDiffs: vi.fn().mockResolvedValue([diffFile('src/companion.ts', '@@ -0,0 +1 @@\n+export const a = 1;')]),
        listMrCommits,
      }),
      undefined,
      { commits: false },
    );

    expect(listMrCommits).not.toHaveBeenCalled();
    expect(loaded).toHaveLength(2);
    expect(loaded.every((item) => item.status === 'ready' && item.commits === undefined)).toBe(true);
  });
});

describe('delegation export follows the switches', () => {
  const meta = { project: 'g/p', mergeRequestIid: 7, headSha: 'abc123' };

  it('omits the description section entirely, not as an empty block', () => {
    const text = buildDelegationContext({
      files: currentFiles, packs: [BUILT_IN_PACK], description: DESCRIPTION, commits: COMMITS,
      includeDescription: false, meta,
    });
    expect(text).not.toContain('## MR 说明');
    expect(text).not.toContain('重试最多 3 次');
    expect(text).toContain('## MR Commits');
    expect(text).toContain('feat(pay): 支持支付失败重试');
  });

  it('omits the commits section entirely, not as an empty block', () => {
    const text = buildDelegationContext({
      files: currentFiles, packs: [BUILT_IN_PACK], description: DESCRIPTION, commits: COMMITS,
      includeCommits: false, meta,
    });
    expect(text).not.toContain('## MR Commits');
    expect(text).not.toContain('feat(pay): 支持支付失败重试');
    expect(text).toContain('## MR 说明');
    expect(text).toContain('重试最多 3 次');
  });

  it('keeps the document structure intact when both are off', () => {
    const text = buildDelegationContext({
      files: currentFiles, packs: [BUILT_IN_PACK], description: DESCRIPTION, commits: COMMITS,
      includeDescription: false, includeCommits: false, meta,
    });
    expect(text).not.toContain('## MR 说明');
    expect(text).not.toContain('## MR Commits');
    expect(text).toContain('```\n\n## 参考背景');
    expect(text).not.toContain('\n\n\n');
    expect(text).toContain('## 输出要求');
  });

  it('exports both sections when the switches stay on', () => {
    const text = buildDelegationContext({
      files: currentFiles, packs: [BUILT_IN_PACK], description: DESCRIPTION, commits: COMMITS, meta,
    });
    expect(text).toContain('## MR 说明\n## 需求');
    expect(text).toContain('## MR Commits\n1. `a1b2c3d4` feat(pay): 支持支付失败重试');
  });
});

function settingsView(patch: Partial<RuntimeSettings> = {}, onSettingsChange = (_s: RuntimeSettings) => undefined) {
  return render(
    createElement(SettingsView, {
      settings: { ...defaultSettings, ...patch },
      onSettingsChange,
      onSave: () => undefined,
      onTestModel: () => undefined,
      onClearApiKey: () => undefined,
      rulePacks: [BUILT_IN_PACK],
      onToggleRulePack: () => undefined,
      onDeleteRulePack: () => undefined,
      onImportRulePack: () => undefined,
      onExportRulePack: () => undefined,
      onUpdateRulePack: () => undefined,
      onToggleRule: () => undefined,
      onNewRulePack: () => undefined,
      projectKey: 'acme/app',
      packScope: { kind: 'public' },
      projectLabel: 'acme/app',
      publicCustomCount: 0,
      onPackScopeChange: () => undefined,
      onSettingsCommit: () => undefined,
      onOpenDebug: () => undefined,
      importError: '',
      usageSummary: null,
      onClearUsage: () => undefined,
      capabilities: undefined,
      onProbeCapabilities: () => undefined,
      onExportSiteConfig: () => undefined,
      testing: false,
    }),
  );
}

describe('SettingsView exposes the two switches', () => {
  afterEach(() => cleanup());

  it('renders both off by default next to the review settings', () => {
    settingsView();
    const description = screen.getByRole('switch', { name: 'MR 说明进上下文' });
    const commits = screen.getByRole('switch', { name: 'Commit 信息进上下文' });
    expect(description.getAttribute('aria-checked')).toBe('false');
    expect(commits.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/关闭后整段不渲染、字符不入账，省 token/)).toBeTruthy();
    expect(screen.getByText(/关闭后连 commits 接口都不打，省 token/)).toBeTruthy();
  });

  it('reflects a stored on state', () => {
    settingsView({ includeMrDescription: true, includeMrCommits: true });
    expect(screen.getByRole('switch', { name: 'MR 说明进上下文' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Commit 信息进上下文' }).getAttribute('aria-checked')).toBe('true');
  });

  it('reflects a stored off state', () => {
    settingsView({ includeMrDescription: false, includeMrCommits: false });
    expect(screen.getByRole('switch', { name: 'MR 说明进上下文' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('switch', { name: 'Commit 信息进上下文' }).getAttribute('aria-checked')).toBe('false');
  });

  it('flips one switch on without touching the other', () => {
    const changed: RuntimeSettings[] = [];
    settingsView({}, (next) => changed.push(next));
    fireEvent.click(screen.getByRole('switch', { name: 'Commit 信息进上下文' }));

    expect(changed).toHaveLength(1);
    expect(changed[0].includeMrCommits).toBe(true);
    expect(changed[0].includeMrDescription).toBe(false);
  });

  it('flips one stored switch off without touching the other', () => {
    const changed: RuntimeSettings[] = [];
    settingsView({ includeMrDescription: true, includeMrCommits: true }, (next) => changed.push(next));
    fireEvent.click(screen.getByRole('switch', { name: 'MR 说明进上下文' }));

    expect(changed).toHaveLength(1);
    expect(changed[0].includeMrDescription).toBe(false);
    expect(changed[0].includeMrCommits).toBe(true);
  });
});

describe('the switches in the app review flow', () => {
  const page: PageContext = {
    origin: 'https://gitlab.test', route: 'diff', projectPath: 'acme/app',
    projectNumericId: 42, mergeRequestIid: 248,
  };

  const HYBRID = {
    provider: 'openai', modelBaseUrl: 'https://model.test/v1', model: 'test-model', apiKey: 'test-key',
    reviewMode: 'hybrid', gitlabToken: 'glpat-test', language: 'zh-CN', effort: 'balanced',
  };

  const modelFindings = JSON.stringify({
    findings: [{
      title: '硬编码 API Key 应移至安全配置', severity: 'high', category: 'security', confidence: 'high',
      path: 'src/payment.ts', line: 2, endLine: 2, side: 'new', existingCode: 'const apiKey = "sk-live-123";',
      content: '新增赋值涉及密码、Token 或 API Key，应从安全配置读取。',
      evidence: [{ path: 'src/payment.ts', lines: 'L2', quote: 'const apiKey = "sk-live-123";' }],
      comment: '发现硬编码 API Key，应从安全配置读取。',
    }],
  });

  const currentDiff = {
    old_path: 'src/payment.ts', new_path: 'src/payment.ts',
    new_file: false, deleted_file: false, renamed_file: false,
    diff: ['@@ -1,2 +1,4 @@ export function pay() {', ' export function pay() {', '+  const apiKey = "sk-live-123";', '+  return charge(apiKey);', ' }'].join('\n'),
  };

  interface Call { url: string; body: string }

  function stubNetwork(): Call[] {
    const calls: Call[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });

      if (url.startsWith('https://model.test')) {
        return json({
          id: 'c1', object: 'chat.completion', model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: modelFindings }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      if (url.includes('/merge_requests/248/commits')) {
        return json([{
          id: 'a1b2c3d4e5f6a1b2', short_id: 'a1b2c3d4', title: 'feat(pay): 支付失败重试 3 次',
          message: 'feat(pay): 支付失败重试 3 次\n\n需求：网关超时后指数退避重试。',
          author_name: 'mizuka', created_at: '2026-10-13T10:00:00.000Z',
        }]);
      }
      if (url.includes('/discussions')) return json([]);
      if (url.includes('/merge_requests/248/diffs')) return json([currentDiff]);
      if (url.includes('/merge_requests/248')) {
        return json({
          title: 'Harden checkout payment error handling', description: DESCRIPTION, state: 'opened',
          source_branch: 'feature/payment', target_branch: 'main', sha: 'head-sha',
          diff_refs: { base_sha: 'base-sha', head_sha: 'head-sha', start_sha: 'start-sha' },
        });
      }
      return json({ message: '404 Not Found' }, 404);
    }));
    return calls;
  }

  function reviewPrompts(calls: Call[]): string[] {
    return calls
      .filter((call) => call.url.includes('/chat/completions'))
      .map((call) => decodeURIComponent(call.body))
      .filter((body) => body.includes('你是代码评审引擎'));
  }

  const commitsCalls = (calls: Call[]) => calls.filter((call) => call.url.includes('/merge_requests/248/commits'));

  function mount(patch: Record<string, unknown> = {}) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...HYBRID, ...patch }));
    localStorage.setItem('review-agent-ui-v1', JSON.stringify({ width: 460, top: 72, right: 16, open: true, hintDismissed: true }));
    return render(createElement(App, { page }));
  }

  async function runReview() {
    fireEvent.click(screen.getByRole('button', { name: '开始 Review' }));
    await waitFor(() => expect(screen.getByText(/个问题/)).toBeInTheDocument(), { timeout: 8000 });
  }

  beforeEach(() => localStorage.clear());
  afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

  it('never calls the commits endpoint and sends no commits block when the switch is off', async () => {
    const calls = stubNetwork();
    mount({ includeMrDescription: true, includeMrCommits: false });
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    await waitFor(() => expect(commitsCalls(calls)).toHaveLength(0));

    await runReview();

    expect(commitsCalls(calls)).toHaveLength(0);
    const prompts = reviewPrompts(calls);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('MR Commits');
    expect(prompts[0]).not.toContain('网关超时后指数退避重试');
    expect(prompts[0]).toContain('## MR 说明（提交者写的需求背景，用来判断实现是否符合意图）');
    expect(screen.getByText('硬编码 API Key 应移至安全配置')).toBeInTheDocument();
    expect(screen.queryByText(/读取 MR 数据失败/)).not.toBeInTheDocument();
  });

  it('keeps the MR body request but drops the description block when its switch is off', async () => {
    const calls = stubNetwork();
    mount({ includeMrDescription: false, includeMrCommits: true });
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());

    await runReview();

    const prompts = reviewPrompts(calls);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('MR 说明');
    expect(prompts[0]).not.toContain('重试最多 3 次');
    expect(prompts[0]).toContain('## MR Commits（提交者写在 commit message 里的需求与实现说明）');
    expect(prompts[0]).toContain('src/payment.ts');
    // description 是 MR 主体自带字段：开关只管进不进上下文，不动拉取逻辑
    expect(calls.some((call) => call.url.endsWith('/merge_requests/248'))).toBe(true);
  });

  it('drops both sections when both switches are off', async () => {
    const calls = stubNetwork();
    mount({ includeMrDescription: false, includeMrCommits: false });
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());

    await runReview();

    expect(commitsCalls(calls)).toHaveLength(0);
    const prompts = reviewPrompts(calls);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('MR 说明');
    expect(prompts[0]).not.toContain('MR Commits');
    expect(prompts[0]).not.toContain('\n\n\n');
    expect(screen.getByText('硬编码 API Key 应移至安全配置')).toBeInTheDocument();
  });

  it('injects neither section for settings saved before the switches existed', async () => {
    const calls = stubNetwork();
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    expect(commitsCalls(calls)).toHaveLength(0);

    await runReview();

    expect(commitsCalls(calls)).toHaveLength(0);
    const prompts = reviewPrompts(calls);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('MR 说明');
    expect(prompts[0]).not.toContain('重试最多 3 次');
    expect(prompts[0]).not.toContain('MR Commits');
    expect(prompts[0]).not.toContain('网关超时后指数退避重试');
    // 缺省关只影响这两段：diff 与评审本身照旧
    expect(prompts[0]).toContain('src/payment.ts');
    expect(screen.getByText('硬编码 API Key 应移至安全配置')).toBeInTheDocument();
    expect(screen.queryByText(/读取 MR 数据失败/)).not.toBeInTheDocument();
  });

  it('injects both sections once the user turns both switches on', async () => {
    const calls = stubNetwork();
    mount({ includeMrDescription: true, includeMrCommits: true });
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    expect(commitsCalls(calls).length).toBeGreaterThan(0);

    await runReview();

    const prompts = reviewPrompts(calls);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('## MR 说明（提交者写的需求背景，用来判断实现是否符合意图）');
    expect(prompts[0]).toContain('重试最多 3 次');
    expect(prompts[0]).toContain('## MR Commits（提交者写在 commit message 里的需求与实现说明）');
    expect(prompts[0]).toContain('网关超时后指数退避重试');
  });

  it('logs the description injection only while its switch is on', async () => {
    stubNetwork();
    mount({ includeMrDescription: false, includeMrCommits: true });
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    debugBus.clear();

    await runReview();

    const messages = debugBus.getLogs().map((entry) => entry.message);
    expect(messages.some((message) => message.includes('注入 MR 说明'))).toBe(false);
    expect(messages.some((message) => message.includes('注入 MR 提交记录 1 条'))).toBe(true);
  });

  it('logs both injections when both switches are on', async () => {
    stubNetwork();
    mount({ includeMrDescription: true, includeMrCommits: true });
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    debugBus.clear();

    await runReview();

    const messages = debugBus.getLogs().map((entry) => entry.message);
    expect(messages.some((message) => message.includes('注入 MR 说明'))).toBe(true);
    expect(messages.some((message) => message.includes('注入 MR 提交记录 1 条'))).toBe(true);
  });

  it('logs neither injection while the defaults stay off', async () => {
    stubNetwork();
    mount();
    await waitFor(() => expect(screen.getByText('Harden checkout payment error handling')).toBeInTheDocument());
    debugBus.clear();

    await runReview();

    const messages = debugBus.getLogs().map((entry) => entry.message);
    expect(messages.some((message) => message.includes('注入 MR 说明'))).toBe(false);
    expect(messages.some((message) => message.includes('注入 MR 提交记录'))).toBe(false);
  });
});
