export type FindingCategory =
  | 'bug'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'test';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';
export type FindingConfidence = 'high' | 'medium' | 'low';
export type FindingStatus = 'draft' | 'ignored' | 'published' | 'failed' | 'fixed';

/** 规则命中 = 确定性检查（无需模型），model = AI 评审。 */
export type FindingSource = 'rule' | 'model';

export interface FindingEvidence {
  path: string;
  lines: string;
  quote: string;
}

export interface FindingAnchor {
  source: 'diff' | 'full-file';
  publishable: boolean;
  relocatedFromPath?: string;
  /** 原行号不在 diff 行内，发布前按 Finding 内容重新定位过。 */
  corrected?: boolean;
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
  source: FindingSource;
  status: FindingStatus;
  anchor?: FindingAnchor;
  edited?: boolean;
  /** 规则来源信息，仅 source === 'rule' 时有值。 */
  ruleId?: string;
  rulePackId?: string;
  rulePackName?: string;
  /** 同一规则在同一文件的命中总数，用于提示“共 N 处”。 */
  occurrences?: number;
  /** 另一个来源独立命中了同一处问题，已合并进本条。 */
  corroborated?: FindingSource;
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
  /** 只有落在 diff / blob 代码区的选区才有位置语义；页面其它文本只带 text，四项位置信息全部缺省。 */
  filePath?: string;
  side?: 'old' | 'new' | 'unified';
  /** 页面 DOM 读不到行号时为 undefined：引用降级为无行号，不编造行号。 */
  startLine?: number;
  endLine?: number;
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
  findings?: Finding[];
}

/** 评审阶段组合：hybrid = 规则 + AI，rules = 仅确定性规则，ai = 仅模型。 */
export type ReviewMode = 'hybrid' | 'rules' | 'ai';

export type ModelProvider = 'openai' | 'anthropic' | 'gemini';
export type AuthMode = 'bearer' | 'api-key-header' | 'query-param' | 'custom';

export interface McpServerEntry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface McpSettings {
  enabled: boolean;
  servers: McpServerEntry[];
}

export interface AuthSettings {
  mode: AuthMode;
  customHeaders: Record<string, string>;
  apiKeyHeader: string;
  apiKeyQueryParam: string;
}

export interface UsageRecord {
  timestamp: string;
  provider: ModelProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface RepoIndexSettings {
  enabled: boolean;
  maxFiles: number;
  /** 单个索引的字节上限。 */
  maxBytes: number;
  /** 注册表保留的索引份数（不同 branch/commit 各一份），超出清理最旧。 */
  maxIndexes: number;
}

export interface RuntimeSettings {
  provider: ModelProvider;
  modelBaseUrl: string;
  apiKey: string;
  model: string;
  gitlabToken: string;
  effort: 'fast' | 'balanced' | 'thorough';
  reviewMode: ReviewMode;
  language: 'zh-CN' | 'en-US';
  mcp: McpSettings;
  auth: AuthSettings;
  repoIndex: RepoIndexSettings;
  /** 按项目（projectPath）配置的 Review 补充 system prompt。 */
  projectPrompts: Record<string, string>;
  /** Review 时把"Diff 外调用点"等仓库符号上下文注入提示词。 */
  repoContext: boolean;
  /** 调试标签页开关（默认关闭，在设置中打开）。 */
  debugEnabled: boolean;
  /** 'off' 时通过 chat_template_kwargs 关闭 omlx/vLLM 系服务端的思考输出。 */
  thinking: 'default' | 'off';
}

export interface AdapterCapabilities {
  authenticated: boolean;
  canReadMergeRequests: boolean;
  canCreateDiscussions: boolean;
}

/** 评论落地形态：行内 Discussion（带 position）或 MR 级全文评论（不带 position）。 */
export type PublishMode = 'inline' | 'full';

/**
 * GitLab 用 (old_line, new_line) 精确比对 diff 行：added 行只有 newLine，removed 行只有 oldLine，
 * context 行两者都有。多填或漏填任何一侧都匹配不到 diff 行，评论会以 400 被拒。
 */
export interface PositionLineRef {
  oldLine?: number;
  newLine?: number;
}

export interface DiscussionPosition {
  path: string;
  oldPath?: string;
  newPath?: string;
  startLine: number;
  endLine: number;
  side: 'old' | 'new';
  /** 起止行在真实 diff 行上的行号配对，对应 GitLab 的 position[line_range][start|end]。 */
  start?: PositionLineRef;
  end?: PositionLineRef;
  diffRefs: DiffRefs;
}

/** position 缺省时创建 MR 级全文评论，payload 不含任何 position[...] 字段。 */
export interface DiscussionDraft {
  body: string;
  position?: DiscussionPosition;
}

export interface PublishedDiscussion {
  id: string;
  noteId: string;
  deduplicated?: boolean;
}

export interface PublishedComment extends PublishedDiscussion {
  mode: PublishMode;
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

export interface ReviewStageReport {
  ran: boolean;
  findings: number;
  /** 规则阶段：参与评估的规则条数。 */
  rules?: number;
  /** 模型阶段失败原因（失败时仍会返回规则结果）。 */
  error?: string;
}

export interface ReviewEngineResult {
  findings: Finding[];
  context: ReviewContext;
  /** 主要来源：模型参与过就是 'model'，否则 'rule'。 */
  source: FindingSource;
  /** 本次实际产出结果的阶段，用于 UI 区分“规则命中 / AI 评审”。 */
  sources: FindingSource[];
  stages: { rules: ReviewStageReport; model: ReviewStageReport };
  warnings: string[];
}
