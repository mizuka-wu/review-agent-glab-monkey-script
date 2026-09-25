export type FindingCategory =
  | 'bug'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'test';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';
export type FindingConfidence = 'high' | 'medium' | 'low';
export type FindingStatus = 'draft' | 'ignored' | 'published' | 'failed';

export interface FindingEvidence {
  path: string;
  lines: string;
  quote: string;
}

export interface FindingAnchor {
  source: 'diff' | 'full-file';
  publishable: boolean;
  relocatedFromPath?: string;
}

export interface Finding {
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
  evidence: FindingEvidence[];
  existingCode: string;
  suggestionCode: string;
  comment: string;
  source: 'model' | 'rule';
  status: FindingStatus;
  anchor?: FindingAnchor;
  edited?: boolean;
}

export interface DiffLine {
  hunkId: string;
  oldLine?: number;
  newLine?: number;
  kind: 'context' | 'added' | 'removed';
  text: string;
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  diff: string;
  newFileContent?: string;
  binary?: boolean;
  generated?: boolean;
  newFile: boolean;
  deletedFile: boolean;
  renamedFile: boolean;
  lines: DiffLine[];
}

export interface DiffRefs {
  baseSha: string;
  headSha: string;
  startSha: string;
}

export interface MergeRequestRef {
  origin: string;
  projectPath: string;
  projectNumericId?: number;
  mergeRequestIid: number;
}

export interface MergeRequestContext extends MergeRequestRef {
  title: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  sha: string;
  diffRefs: DiffRefs;
}

export type GitLabRoute =
  | 'merge-request'
  | 'diff'
  | 'file'
  | 'commit'
  | 'unknown';

export interface PageContext {
  origin: string;
  route: GitLabRoute;
  projectPath: string;
  projectNumericId?: number;
  mergeRequestIid?: number;
  filePath?: string;
  commitSha?: string;
}

export interface CodeSelection {
  filePath: string;
  side: 'old' | 'new' | 'unified';
  startLine: number;
  endLine: number;
  text: string;
  top: number;
  left: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachment?: CodeSelection;
  error?: boolean;
}

export type ModelProvider = 'openai' | 'anthropic' | 'gemini';

export interface McpSettings {
  enabled: boolean;
  serverUrl: string;
}

export interface RuntimeSettings {
  provider: ModelProvider;
  modelBaseUrl: string;
  apiKey: string;
  model: string;
  gitlabToken: string;
  effort: 'fast' | 'balanced' | 'thorough';
  language: 'zh-CN' | 'en-US';
  mcp: McpSettings;
}

export interface AdapterCapabilities {
  authenticated: boolean;
  canReadMergeRequests: boolean;
  canCreateDiscussions: boolean;
}

export interface DiscussionDraft {
  body: string;
  path: string;
  oldPath?: string;
  newPath?: string;
  startLine: number;
  endLine: number;
  side: 'old' | 'new';
  newFile?: boolean;
  deletedFile?: boolean;
  diffRefs: DiffRefs;
}

export interface PublishedDiscussion {
  id: string;
  noteId: string;
  deduplicated?: boolean;
}

export interface ReviewContextFile extends FileDiff {
  included: boolean;
  omittedReason?: 'binary' | 'generated' | 'lockfile' | 'secret' | 'unsupported' | 'budget';
}

export interface ReviewContext {
  files: ReviewContextFile[];
  selection?: CodeSelection;
  background?: string;
  estimatedCharacters: number;
  budgetCharacters: number;
  omittedFiles: { path: string; reason: NonNullable<ReviewContextFile['omittedReason']> }[];
  fullFiles: FullFileSnapshot[];
  omittedFullFiles: FullFileOmission[];
}

export interface FullFileSnapshot {
  path: string;
  ref: string;
  content: string;
  lines: string[];
}

export type FullFileOmissionReason =
  | 'binary'
  | 'generated'
  | 'lockfile'
  | 'secret'
  | 'unsupported'
  | 'too_large'
  | 'budget'
  | 'read_error';

export interface FullFileOmission {
  path: string;
  reason: FullFileOmissionReason;
  message?: string;
}

export interface ReviewEngineResult {
  findings: Finding[];
  context: ReviewContext;
  source: 'model' | 'rule';
  warnings: string[];
}
