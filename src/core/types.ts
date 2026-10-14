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
  /** 文件级规则命中：没有「就改这几行」的锚点，不参与自动修复。 */
  fileLevel?: boolean;
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
  /** GitLab 自己标的「diff 被折叠」（用户要在页面上点开才渲染），此时接口不给 diff 内容。 */
  collapsed?: boolean;
  /** GitLab 自己标的「diff 过大」：超出上限，接口不给 diff 内容，任何行都挂不上行内评论。 */
  tooLarge?: boolean;
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
  /** MR 说明正文（GitLab 的 description，可能为空）。评审时作为需求背景注入模型上下文。 */
  description: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  sha: string;
  diffRefs: DiffRefs;
}

/** MR 的一条提交：很多需求细节只写在 commit message 里，评审时作为背景注入。 */
export interface MrCommit {
  id: string;
  shortId: string;
  /** commit 标题，GitLab 取的是 message 第一行。 */
  title: string;
  /** commit 完整正文（含标题行）。 */
  message: string;
  authorName: string;
  createdAt: string;
}

/** 用户粘贴/勾选的另一个 MR：只作为当前评审的参考上下文，永不作为发布目标。 */
export interface MrLinkRef {
  origin: string;
  projectPath: string;
  iid: number;
}

export type ReferenceMrStatus = 'loading' | 'ready' | 'failed';

export interface ReferenceMr {
  ref: MrLinkRef;
  status: ReferenceMrStatus;
  title?: string;
  /** 参考 MR 的说明：同样只读，用来理解配套改动的意图。 */
  description?: string;
  /** 参考 MR 的提交记录：同样只读，拿不到就没有这一段。 */
  commits?: MrCommit[];
  headSha?: string;
  files: FileDiff[];
  addedAt: string;
  /** 拉取失败/为空的原因，直接展示给用户，不静默吞掉。 */
  error?: string;
}

/** GitLab「最近活动 MR」列表条目（scope=all，跨项目）。 */
export interface RecentMergeRequest {
  ref: MrLinkRef;
  title: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  updatedAt: string;
  webUrl: string;
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

/** 全局历史池里的一条：内容 + 当初是在哪个项目下存进去的（列表里显示成来源标注）。 */
export interface ProjectPromptHistoryEntry {
  value: string;
  projectKey: string;
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
  /** 按项目（projectPath）配置的 Review 补充 system prompt（当前生效值）。 */
  projectPrompts: Record<string, string>;
  /**
   * 全局共用的补充要求历史池（跨项目共享一个列表），最新在前、最多 GLOBAL_PROMPT_HISTORY_LIMIT 条，
   * 每条记住来源项目。打字只改 projectPrompts，失焦才把当前值追加到这里，
   * 起始页和设置页两个输入框的历史列表挑的都是这一份。
   */
  projectPromptHistory: ProjectPromptHistoryEntry[];
  /** Review 时把"Diff 外调用点"等仓库符号上下文注入提示词。 */
  repoContext: boolean;
  /**
   * MR 说明（GitLab description）是否进评审上下文（默认关：缺省不进上下文，用户手动打开才进）。
   * 关闭时当前 MR 与参考 MR 的说明段整段不渲染、字符不入账，省 token。
   */
  includeMrDescription: boolean;
  /**
   * MR 提交记录是否进评审上下文（默认关：缺省不进上下文，用户手动打开才进）。
   * 关闭时连 commits 接口都不打，当前 MR 与参考 MR 的 Commits 段整段不渲染、字符不入账。
   */
  includeMrCommits: boolean;
  /** 调试标签页开关（默认关闭，在设置中打开）。 */
  debugEnabled: boolean;
  /** 'off' 时通过 chat_template_kwargs 关闭 omlx/vLLM 系服务端的思考输出。 */
  thinking: 'default' | 'off';
  /** 允许把 Finding 的修复直接提交回 MR 源分支（默认关闭，关闭时入口不渲染）。 */
  applyFixEnabled: boolean;
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

/** 行内位置被 GitLab 拒绝后降级为全文评论的原因；用户要能看出是数据问题还是脚本问题。 */
export interface PublishDowngrade {
  reason: string;
  status?: number;
}

export interface PublishedComment extends PublishedDiscussion {
  mode: PublishMode;
  /** 只有「本来要发行内、被 GitLab 拒了才改全文」时才有值；一开始就判定不可行内的走 publishable=false。 */
  downgrade?: PublishDowngrade;
}

export interface ReviewContextFile extends FileDiff {
  included: boolean;
  /** collapsed = GitLab 没返回该文件的 diff（超出 diff 上限被折叠），任何行都挂不上行内评论。 */
  omittedReason?: 'binary' | 'generated' | 'lockfile' | 'secret' | 'unsupported' | 'budget' | 'collapsed';
}

export interface ReviewContext {
  files: ReviewContextFile[];
  selection?: CodeSelection;
  background?: string;
  /** MR 说明块实际拼进输入的字符数（空说明为 0，不渲染该段）。 */
  descriptionCharacters?: number;
  /** MR commits 块实际拼进输入的字符数（拿不到提交为 0，不渲染该段）。 */
  commitsCharacters?: number;
  /** 参考 MR：只读上下文，不产出 Finding，也不参与发布位置解析。 */
  references?: ReferenceMr[];
  /** 参考块实际拼进输入的字符数。 */
  referenceCharacters?: number;
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
