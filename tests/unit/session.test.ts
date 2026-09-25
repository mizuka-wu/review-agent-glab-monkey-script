import { describe, expect, it } from 'vitest';
import {
  createReviewSession,
  fromSessionFinding,
  loadLatestReviewSession,
  resumeReviewSession,
  saveReviewSession,
  toSessionFinding,
  updateReviewSession,
  type SessionStorage,
} from '../../src/core/session';
import type { Finding, MergeRequestRef, RuntimeSettings } from '../../src/core/types';

const ref: MergeRequestRef = {
  origin: 'https://gitlab.test', projectPath: 'group/project', mergeRequestIid: 7,
};
const settings: RuntimeSettings = {
  modelBaseUrl: 'https://model.test/v1', apiKey: 'secret', model: 'model', gitlabToken: 'secret',
  effort: 'balanced', language: 'zh-CN',
};
const finding: Finding = {
  id: 'finding-1', fingerprint: 'ra-fingerprint', path: 'src/a.ts', line: 4, endLine: 4, side: 'new',
  category: 'bug', severity: 'medium', confidence: 'medium', title: 'Title', content: 'Content',
  evidence: [{ path: 'src/a.ts', lines: '4', quote: 'private code' }], existingCode: 'private code',
  suggestionCode: 'fixed code', comment: 'Comment', source: 'model', status: 'draft',
};

function memoryStorage(): SessionStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async getValue(key, fallback) { return values.get(key) ?? fallback; },
    async setValue(key, value) { values.set(key, value); },
  };
}

describe('review sessions', () => {
  it('persists a sanitized manifest and restores the latest matching session', async () => {
    const storage = memoryStorage();
    const session = createReviewSession({ ref, headSha: 'head', title: 'MR title', scope: 'all', source: 'model', settings, now: '2026-01-01T00:00:00.000Z' });
    const completed = updateReviewSession(session, {
      status: 'completed',
      findings: [toSessionFinding(finding)],
    }, '2026-01-01T00:01:00.000Z');

    await saveReviewSession(completed, storage);
    const loaded = await loadLatestReviewSession(completed.key, storage);

    expect(loaded).toMatchObject({ id: completed.id, status: 'completed' });
    expect(JSON.stringify(loaded)).not.toContain('secret');
    expect(JSON.stringify(loaded)).not.toContain('private code');
    expect(fromSessionFinding(loaded!.findings[0])).toMatchObject({
      id: 'finding-1', evidence: [], existingCode: '', suggestionCode: '', comment: 'Comment',
    });
  });

  it('marks interrupted running sessions as cancelled on resume', () => {
    const session = createReviewSession({ ref, headSha: 'head', title: 'MR title', scope: 'all', source: 'model', settings, now: '2026-01-01T00:00:00.000Z' });
    const resumed = resumeReviewSession(session);

    expect(resumed.status).toBe('cancelled');
    expect(resumed.session.status).toBe('cancelled');
    expect(resumed.error).toContain('中断');
  });
});
