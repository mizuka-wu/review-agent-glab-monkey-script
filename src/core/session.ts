import type {
  Finding,
  FindingAnchor,
  FindingCategory,
  FindingConfidence,
  FindingSeverity,
  FindingStatus,
  FullFileOmission,
  MergeRequestRef,
  ReviewContext,
  RuntimeSettings,
} from './types';

export type ReviewSessionStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface SessionFinding {
  id: string;
  fingerprint: string;
  path: string;
  oldPath?: string;
  newPath?: string;
  newFile?: boolean;
  deletedFile?: boolean;
  line: number;
  endLine: number;
  side: 'old' | 'new';
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  title: string;
  content: string;
  comment: string;
  source: 'model' | 'rule';
  status: FindingStatus;
  anchor?: FindingAnchor;
  edited?: boolean;
}

export interface ReviewSessionContextSummary {
  includedFiles: number;
  omittedFiles: ReviewContext['omittedFiles'];
  fullFiles: number;
  omittedFullFiles: FullFileOmission[];
  estimatedCharacters: number;
  budgetCharacters: number;
}

export interface ReviewSessionManifest {
  version: 1;
  id: string;
  key: string;
  origin: string;
  projectPath: string;
  mergeRequestIid: number;
  headSha: string;
  title: string;
  scope: 'all' | 'selection';
  source: 'model' | 'rule';
  status: ReviewSessionStatus;
  effort: RuntimeSettings['effort'];
  language: RuntimeSettings['language'];
  createdAt: string;
  updatedAt: string;
  findings: SessionFinding[];
  warnings: string[];
  context: ReviewSessionContextSummary;
  error?: string;
}

export interface SessionStorage {
  getValue(key: string, fallback: unknown): Promise<unknown>;
  setValue(key: string, value: unknown): Promise<void>;
}

const STORAGE_KEY = 'review-agent-review-sessions-v1';
const MAX_SESSIONS = 20;

function fallbackStorage(): SessionStorage {
  return {
    async getValue(key, fallback) {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    },
    async setValue(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
  };
}

function defaultStorage(): SessionStorage {
  const gm = (globalThis as typeof globalThis & { GM?: SessionStorage }).GM;
  return gm ?? fallbackStorage();
}

function hash(value: string) {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result.toString(16).padStart(8, '0');
}

export function reviewSessionKey(ref: MergeRequestRef, headSha: string) {
  return [ref.origin, ref.projectPath, ref.mergeRequestIid, headSha].join('\u0000');
}

export function toSessionFinding(finding: Finding): SessionFinding {
  return {
    id: finding.id,
    fingerprint: finding.fingerprint,
    path: finding.path,
    oldPath: finding.oldPath,
    newPath: finding.newPath,
    newFile: finding.newFile,
    deletedFile: finding.deletedFile,
    line: finding.line,
    endLine: finding.endLine,
    side: finding.side,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    title: finding.title,
    content: finding.content,
    comment: finding.comment,
    source: finding.source,
    status: finding.status,
    anchor: finding.anchor,
    edited: finding.edited,
  };
}

export function fromSessionFinding(finding: SessionFinding): Finding {
  return {
    ...finding,
    evidence: [],
    existingCode: '',
    suggestionCode: '',
  };
}

export function summarizeReviewContext(context: ReviewContext): ReviewSessionContextSummary {
  return {
    includedFiles: context.files.filter((file) => file.included).length,
    omittedFiles: context.omittedFiles,
    fullFiles: context.fullFiles.length,
    omittedFullFiles: context.omittedFullFiles,
    estimatedCharacters: context.estimatedCharacters,
    budgetCharacters: context.budgetCharacters,
  };
}

export function createReviewSession(input: {
  ref: MergeRequestRef;
  headSha: string;
  title: string;
  scope: 'all' | 'selection';
  source: 'model' | 'rule';
  settings: RuntimeSettings;
  now?: string;
}): ReviewSessionManifest {
  const key = reviewSessionKey(input.ref, input.headSha);
  const timestamp = input.now ?? new Date().toISOString();
  return {
    version: 1,
    id: `ra-session-${hash(key)}-${hash(timestamp)}`,
    key,
    origin: input.ref.origin,
    projectPath: input.ref.projectPath,
    mergeRequestIid: input.ref.mergeRequestIid,
    headSha: input.headSha,
    title: input.title,
    scope: input.scope,
    source: input.source,
    status: 'running',
    effort: input.settings.effort,
    language: input.settings.language,
    createdAt: timestamp,
    updatedAt: timestamp,
    findings: [],
    warnings: [],
    context: {
      includedFiles: 0,
      omittedFiles: [],
      fullFiles: 0,
      omittedFullFiles: [],
      estimatedCharacters: 0,
      budgetCharacters: 0,
    },
  };
}

export function updateReviewSession(
  session: ReviewSessionManifest,
  changes: Partial<Omit<ReviewSessionManifest, 'version' | 'id' | 'key' | 'createdAt'>>,
  now = new Date().toISOString(),
): ReviewSessionManifest {
  return { ...session, ...changes, updatedAt: now };
}

export function resumeReviewSession(session: ReviewSessionManifest) {
  if (session.status === 'running') {
    return {
      session: updateReviewSession(session, {
        status: 'cancelled' as const,
        error: '上次任务在页面刷新时中断，未完成结果不会进入发布队列。',
      }),
      findings: session.findings.map(fromSessionFinding),
      status: 'cancelled' as const,
      error: '上次任务在页面刷新时中断，未完成结果不会进入发布队列。',
    };
  }
  return {
    session,
    findings: session.findings.map(fromSessionFinding),
    status: session.status,
    error: session.error,
  };
}

async function readSessions(storage: SessionStorage) {
  const raw = await storage.getValue(STORAGE_KEY, {});
  return raw && typeof raw === 'object' ? raw as Record<string, ReviewSessionManifest> : {};
}

export async function saveReviewSession(
  session: ReviewSessionManifest,
  storage: SessionStorage = defaultStorage(),
) {
  const sessions = await readSessions(storage);
  sessions[session.id] = session;
  const pruned = Object.values(sessions)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_SESSIONS);
  await storage.setValue(STORAGE_KEY, Object.fromEntries(pruned.map((item) => [item.id, item])));
  return session;
}

export async function loadLatestReviewSession(
  key: string,
  storage: SessionStorage = defaultStorage(),
) {
  const sessions = await readSessions(storage);
  return Object.values(sessions)
    .filter((session) => session.key === key)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}
