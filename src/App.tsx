import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { BookOpen, Bug, CheckSquare, Database, ExternalLink, FileText, GitMerge, History, Loader2, MessageSquare, Play, Settings as SettingsIcon, ShieldCheck, Sparkles, Square, Undo2, X } from 'lucide-react';
import { ChatThread } from './components/ChatThread';
import { DebugPanel, type DebugLogEntry } from './components/DebugPanel';
import { normalizeFileDiff } from './core/diff';
import { FindingsPanel, severityLabel, statusLabel } from './components/review/FindingsPanel';
import {
  buildSummaryComment, extractPartialFindings, parseModelFindings, publishedCountLabel,
  publishModeSummary, serializeFindingsExport,
} from './core/findings';
import { buildDelegationContext } from './core/delegation';
import { compactThinking, extractThinkingOutline } from './core/thinking';
import { ReferenceMrPanel, type ReferenceCandidate } from './components/review/ReferenceMrPanel';
import { RepoPanel } from './components/review/RepoPanel';
import { BatchPublishDialog, PublishDialog } from './components/review/PublishDialog';
import { FixDialog, type FixStage } from './components/review/FixDialog';
import { SelectionToolbar } from './components/review/SelectionToolbar';
import { SettingsView, ModelPicker } from './components/SettingsView';
import {
  Banner, Btn, IconButton, InjectAnimations, Pill, Select, Tabs, Toggle, tokens as C,
} from './components/ui/modern';
import { resolvePublishPosition, type PublishPosition } from './core/anchor';
import { runAgentLoop, type AgentLoopEvent } from './core/agent-loop';
import { CompositeToolExecutor, GitLabToolExecutor, RepoIndexToolExecutor } from './core/agent-tools';
import { debugBus } from './core/debug-bus';
import {
  clearHighlights, highlightFindingOnPage, injectHighlightStyles, takePendingLocate, type LocateOutcome,
} from './core/finding-highlight';
import { applyFindingEdit, type FindingEdit } from './core/finding-edit';
import {
  buildFixPayload, createFixPlan, describeFixFailure, isFixCandidate, parseFixResponse,
  type FixPlan,
} from './core/finding-fix';
import { exportSiteConfig, probeCapabilities, type DiagnosticEntry, type ExtendedCapabilities } from './core/capabilities';
import { GitLabAdapter, GitLabApiError, mergeRequestRefFromPage, projectAdapter } from './core/gitlab-adapter';
import { McpClient, MultiMcpClient } from './core/mcp-client';
import { createModelRuntime, type AgentMessage, type ModelRuntime } from './core/model-runtime';
import { createRepoIndex, type RepoIndex, type RepoIndexStatus } from './core/repo-index';
import { ReviewEngine } from './core/review-engine';
import {
  addScopedRulePack, BUILT_IN_PACK, countEnabledRules, exportRulePack, generateRuleId,
  generateRulePackId, importRulePack, loadScopedRulePacks, mergeScopedRulePacks,
  PUBLIC_RULE_PACK_SCOPE, removeScopedRulePack, saveScopedRulePacks,
  type RuleDef, type RulePack, type RulePackScope,
} from './core/rule-packs';
import { captureCodeSelection, isCodeSelection, selectionLabel, selectionQuote, watchSelection } from './core/selection';
import {
  createReviewSession, fromSessionFinding, loadLatestReviewSession, resumeReviewSession, reviewSessionKey, updateSessionFindingStatus,
  saveReviewSession, summarizeReviewContext, toSessionFinding, updateReviewSession,
  type ReviewSessionManifest,
} from './core/session';
import {
  CHAT_STORAGE_KEY, deriveChatTitle, loadChatSessions, newChatSession, saveChatSessions, trimSessionMessages,
  type ChatSession,
} from './core/chat-sessions';
import {
  PROMPT_HISTORY_KEY, loadPromptHistory, pushPromptHistory, removePromptHistory, savePromptHistory,
} from './core/prompt-history';
import {
  loadReferenceMrs, mrLinkKey, mrLinkLabel, mrWebUrl, parseMrLinks, type MrLinkParseFailure,
} from './core/reference-mrs';
import { clearSensitiveSettings, defaultSettings, loadSettings, inspectConfiguration, saveSettings } from './core/settings';
import { httpTransport } from './core/http';
import { clearUsage, getUsageSummary, type UsageSummary } from './core/usage';
import type {
  ChatMessage, CodeSelection, DiscussionPosition, FileDiff, Finding, MergeRequestContext,
  MergeRequestRef, MrLinkRef, PageContext, PublishMode, ReferenceMr, ReviewStageReport, RuntimeSettings,
} from './core/types';

function locateLabel(path: string, line: number) {
  return `${path.replace(/^.*\//, '')}:${line}`;
}

/** 定位结果如实播报：找不到文件就说找不到，只在折叠区展开失败时说明降级到了文件级。 */
function locateMessage(label: string, outcome: LocateOutcome) {
  if (outcome.highlighted.length > 0) return `已高亮 ${label}（${outcome.highlighted.length} 行）`;
  if (outcome.failure === 'navigated') return '正在跳转到 Changes 视图，随后继续定位…';
  if (outcome.fileLevel) return `已滚动到 ${label} 所在文件，Diff 里找不到该行（可能仍在未展开的折叠区）`;
  if (outcome.failure === 'no-diff-tab') return '当前页面没有 Changes 视图，无法定位';
  return `未在页面找到该文件的 diff（${label}）`;
}

type Tab = 'review' | 'chat' | 'repo' | 'settings' | 'debug';
type ReviewStatus = 'idle' | 'preparing' | 'running' | 'completed' | 'cancelled' | 'failed';

interface AppProps {
  page: PageContext;
}

const UI_STORAGE_KEY = 'review-agent-ui-v1';
const SESSION_STORAGE_KEY = 'review-agent-review-sessions-v1';
const MIN_WIDTH = 380;
const MAX_WIDTH = 780;

const suggestions = ['解释这段变更的失败路径', '检查并发与幂等性', '补充可执行的测试建议'];

/** 参考 MR 候选：本工具评审过的（置顶）+ GitLab 最近活动。 */
interface ReferenceCandidateSource {
  ref: MrLinkRef;
  group: 'history' | 'recent';
  title: string;
  meta: string;
}

interface UiPrefs {
  width: number;
  top: number;
  right: number;
  open: boolean;
  hintDismissed: boolean;
}

const defaultUiPrefs: UiPrefs = { width: 460, top: 72, right: 16, open: false, hintDismissed: false };

function loadUiPrefs(): UiPrefs {
  try {
    return { ...defaultUiPrefs, ...JSON.parse(localStorage.getItem(UI_STORAGE_KEY) ?? '{}') as Partial<UiPrefs> };
  } catch {
    return defaultUiPrefs;
  }
}

export default function App({ page }: AppProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const reviewAbort = useRef<AbortController | undefined>(undefined);
  const chatAbort = useRef<AbortController | undefined>(undefined);
  const fixAbort = useRef<AbortController | undefined>(undefined);
  const currentSessionRef = useRef<ReviewSessionManifest | undefined>(undefined);
  const dragState = useRef<{ startX: number; startY: number; startTop: number; startRight: number } | null>(null);
  const resizeState = useRef<{ startX: number; startWidth: number } | null>(null);

  const initialPrefs = useRef<UiPrefs>(loadUiPrefs());
  const [ui, setUi] = useState<UiPrefs>(initialPrefs.current);

  const [settings, setSettings] = useState<RuntimeSettings>(defaultSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [publicPacks, setPublicPacks] = useState<RulePack[]>([BUILT_IN_PACK]);
  const [projectPacks, setProjectPacks] = useState<RulePack[]>([]);
  const [packScopeKind, setPackScopeKind] = useState<'public' | 'project'>('public');
  const [importError, setImportError] = useState('');
  const [quickBusy, setQuickBusy] = useState(false);
  const [modelStream, setModelStream] = useState('');
  const [modelThinking, setModelThinking] = useState('');
  const [showThinking, setShowThinking] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [partialModelCount, setPartialModelCount] = useState(0);
  const [scanMode, setScanMode] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerKey, setViewerKey] = useState('');
  const [hideHandled, setHideHandled] = useState(false);
  const [showRawThinking, setShowRawThinking] = useState(false);
  const [scanning, setScanning] = useState(false);
  const modelContentRef = useRef('');
  const bundleModelRef = useRef<Finding[]>([]);
  const lastBackgroundRef = useRef('');
  const ruleLiveRef = useRef<Finding[]>([]);
  const lastPartialParseRef = useRef(0);
  const lastPartialCountRef = useRef(0);
  const thinkingPreRef = useRef<HTMLPreElement>(null);
  const streamPreStyle: CSSProperties = {
    marginTop: 4, maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    fontSize: 11, lineHeight: 1.5, color: C.textSecondary, background: C.bgSubtle,
    border: `1px solid ${C.border}`, borderRadius: C.radiusSm, padding: 6,
  };

  const [tab, setTab] = useState<Tab>('review');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState('');
  const [draft, setDraft] = useState('');
  const [promptHistory, setPromptHistory] = useState<string[]>(() => loadPromptHistory(PROMPT_HISTORY_KEY));
  const promptHistoryRef = useRef<string[]>(promptHistory);
  const [referenceInput, setReferenceInput] = useState('');
  const [references, setReferences] = useState<ReferenceMr[]>([]);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [referenceInvalid, setReferenceInvalid] = useState<MrLinkParseFailure[]>([]);
  const [referenceCandidates, setReferenceCandidates] = useState<ReferenceCandidateSource[]>([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState('');
  const [attachment, setAttachment] = useState<CodeSelection | undefined>(undefined);
  const [selection, setSelection] = useState<CodeSelection | null>(null);
  /** 工具条锚定的 DOM 节点：不放进 CodeSelection（要序列化进会话），单独留着判活。 */
  const selectionNodeRef = useRef<Node | null>(null);
  const [responding, setResponding] = useState(false);
  const [toolEvents, setToolEvents] = useState<AgentLoopEvent[]>([]);

  const [mrContext, setMrContext] = useState<MergeRequestContext | undefined>(undefined);
  const [files, setFiles] = useState<FileDiff[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>('idle');
  const [reviewError, setReviewError] = useState('');
  const [reviewWarnings, setReviewWarnings] = useState<string[]>([]);
  const [stages, setStages] = useState<{ rules: ReviewStageReport; model: ReviewStageReport } | undefined>(undefined);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [expandedFinding, setExpandedFinding] = useState('');
  const [selectedFindings, setSelectedFindings] = useState<Set<string>>(new Set());
  /** 复位后把焦点交回 prompt 输入框：递增一次，触发 IdleReview 的 focus effect。 */
  const [promptFocus, setPromptFocus] = useState(0);

  const [publishFinding, setPublishFinding] = useState<Finding | undefined>(undefined);
  const [publishBody, setPublishBody] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [batchPublishing, setBatchPublishing] = useState(false);

  const [fixTarget, setFixTarget] = useState<Finding | undefined>(undefined);
  const [fixPlan, setFixPlan] = useState<FixPlan | undefined>(undefined);
  const [fixStage, setFixStage] = useState<FixStage>('ready');
  const [fixError, setFixError] = useState('');

  const [savedSession, setSavedSession] = useState<ReviewSessionManifest | undefined>(undefined);
  const [sessionHistory, setSessionHistory] = useState<ReviewSessionManifest[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const [capabilities, setCapabilities] = useState<ExtendedCapabilities | undefined>(undefined);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [testing, setTesting] = useState(false);

  const [toast, setToast] = useState('');
  const [repoIndex, setRepoIndex] = useState<RepoIndex | undefined>(undefined);
  const [repoStatus, setRepoStatus] = useState<RepoIndexStatus | undefined>(undefined);

  const addLog = useCallback((level: DebugLogEntry['level'], source: string, message: string, detail?: string) => {
    debugBus.log(level, source, message, detail);
  }, []);

  const projectKey = page.projectPath ?? '';
  const activePackScope: RulePackScope = packScopeKind === 'project' && projectKey
    ? { kind: 'project', key: projectKey }
    : PUBLIC_RULE_PACK_SCOPE;
  const rulePacks = useMemo(() => mergeScopedRulePacks(publicPacks, projectPacks), [publicPacks, projectPacks]);
  const scopePacks = activePackScope.kind === 'project' ? projectPacks : publicPacks;
  const setScopePacks = activePackScope.kind === 'project' ? setProjectPacks : setPublicPacks;

  const api = useMemo(() => new GitLabAdapter(page, settings.gitlabToken), [page, settings.gitlabToken]);
  const runtime: ModelRuntime = useMemo(() => createModelRuntime(settings), [settings]);
  const reviewEngine = useMemo(() => new ReviewEngine(runtime, settings, rulePacks), [runtime, settings, rulePacks]);
  const mergeRequestRef = useMemo(() => mergeRequestRefFromPage(page), [page]);
  const config = useMemo(() => inspectConfiguration(settings), [settings]);
  const modelReady = config.modelReady;
  const enabledRuleCount = useMemo(() => countEnabledRules(rulePacks), [rulePacks]);
  const running = reviewStatus === 'running' || reviewStatus === 'preparing';

  /** 发布位置校验：行号落在该文件真实 diff 行内才发行内评论，落不到（含扫描结果）就降级为全文评论。 */
  const publishPositions = useMemo(() => {
    const positions = new Map<string, PublishPosition>();
    if (scanMode) return positions;
    for (const finding of findings) positions.set(finding.id, resolvePublishPosition(finding, files));
    return positions;
  }, [findings, files, scanMode]);

  const resolvedFindings = useMemo(
    () => findings.map((finding) => publishPositions.get(finding.id)?.finding ?? finding),
    [findings, publishPositions],
  );

  /** 行号落不到当前 diff 的原因；只用于说明「为什么是全文评论」，不再阻断发布。 */
  const publishPositionIssue = useCallback((finding: Finding) => {
    const position = publishPositions.get(finding.id);
    return position && !position.publishable ? position.reason ?? '无法确定行内评论位置' : undefined;
  }, [publishPositions]);

  const publishMode = useCallback((finding: Finding): PublishMode =>
    publishPositions.get(finding.id)?.publishable ? 'inline' : 'full',
  [publishPositions]);

  const publishable = useCallback((finding: Finding) =>
    finding.status === 'draft' && Boolean(finding.comment.trim()), []);

  /** 只有点了必失败的状态才禁用发布入口；缺行号一律降级为全文评论，不留 4xx 给 GitLab。 */
  const publishDisabledReason = !mergeRequestRef || !mrContext
    ? '当前页面不是 MR，无法创建 Discussion'
    : capabilities && !capabilities.canCreateDiscussions
      ? 'GitLab Token 没有创建 Discussion 的权限'
      : running
        ? '评审进行中，请等本次 Review 结束后再发布'
        : publishing || batchPublishing || quickBusy
          ? '正在执行发布操作，请稍候'
          : undefined;
  const canPublish = publishDisabledReason === undefined;

  const persistUi = useCallback((next: UiPrefs) => {
    setUi(next);
    try { localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(next)); } catch { /* 忽略存储失败 */ }
  }, []);

  // --- Bootstrap ---

  useEffect(() => {
    let active = true;
    void (async () => {
      const [loaded, packs, summary] = await Promise.all([
        loadSettings(),
        loadScopedRulePacks(PUBLIC_RULE_PACK_SCOPE),
        getUsageSummary().catch(() => null),
      ]);
      if (!active) return;
      setSettings(loaded);
      setSettingsLoaded(true);
      setPublicPacks(packs);
      if (summary && summary.callCount > 0) setUsageSummary(summary);
      addLog('info', 'settings', `模型${inspectConfiguration(loaded).modelReady ? '已配置' : '未配置'} · 规则 ${countEnabledRules(packs)} 条`);
    })();
    return () => { active = false; };
  }, [addLog]);

  // 载入聊天会话（全局池，与 MR 无关），激活最近一条
  useEffect(() => {
    const sessions = loadChatSessions(CHAT_STORAGE_KEY);
    const active = sessions[0] ?? newChatSession();
    const list = sessions.length > 0 ? sessions : [active];
    setChatSessions(list);
    setActiveChatId(active.id);
    setMessages(trimSessionMessages(active.messages));
  }, []);

  // 消息变化 → 落盘当前会话
  useEffect(() => {
    if (!activeChatId) return;
    const now = new Date().toISOString();
    const trimmed = trimSessionMessages(messages);
    const next: ChatSession[] = chatSessions.some((session) => session.id === activeChatId)
      ? chatSessions.map((session) => (session.id === activeChatId
        ? { ...session, title: deriveChatTitle(messages), updatedAt: now, messages: trimmed }
        : session))
      : [...chatSessions, { ...newChatSession(), id: activeChatId, title: deriveChatTitle(messages), updatedAt: now, messages: trimmed }];
    saveChatSessions(CHAT_STORAGE_KEY, next);
    setChatSessions(next);
  }, [messages]);

  const startNewChat = useCallback(() => {
    const session = newChatSession();
    setChatSessions((prev) => [session, ...prev]);
    setActiveChatId(session.id);
    setMessages([]);
    setDraft('');
  }, []);

  const switchChat = useCallback((id: string) => {
    if (id === activeChatId) return;
    const session = chatSessions.find((item) => item.id === id);
    if (!session) return;
    setActiveChatId(id);
    setMessages(trimSessionMessages(session.messages));
    setDraft('');
  }, [chatSessions, activeChatId]);

  const deleteChat = useCallback((id: string) => {
    const remaining = chatSessions.filter((session) => session.id !== id);
    if (remaining.length === 0) {
      const fresh = newChatSession();
      saveChatSessions(CHAT_STORAGE_KEY, [fresh]);
      setChatSessions([fresh]);
      setActiveChatId(fresh.id);
      setMessages([]);
      setDraft('');
      return;
    }
    saveChatSessions(CHAT_STORAGE_KEY, remaining);
    setChatSessions(remaining);
    if (id === activeChatId) {
      setActiveChatId(remaining[0].id);
      setMessages(trimSessionMessages(remaining[0].messages));
      setDraft('');
    }
  }, [chatSessions, activeChatId]);

  useEffect(() => {
    const controller = new AbortController();
    if (!mergeRequestRef) {
      setLoading(false);
      addLog('info', 'gitlab', '当前页面不是 MR，仅支持划词提问');
      return () => controller.abort();
    }
    addLog('debug', 'gitlab', `读取 ${page.projectPath} !${mergeRequestRef.mergeRequestIid}`);
    void Promise.all([
      api.getMergeRequest(mergeRequestRef),
      page.route === 'commit' && page.commitSha
        ? api.listCommitDiffs(page.commitSha)
        : api.listDiffs(mergeRequestRef, { signal: controller.signal }),
    ]).then(([context, diffs]) => {
      if (controller.signal.aborted) return;
      setMrContext(context);
      setFiles(diffs);
      setLoading(false);
      addLog('info', 'gitlab', `已从 GitLab API 读取 ${diffs.length} 个变更文件`, `head ${context.diffRefs.headSha.slice(0, 8)}`);
      void loadLatestReviewSession(reviewSessionKey(mergeRequestRef, context.diffRefs.headSha))
        .then((session) => { if (!controller.signal.aborted) setSavedSession(session); })
        .catch(() => undefined);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      setLoading(false);
      addLog('error', 'gitlab', '读取 MR 数据失败', message);
    });
    return () => controller.abort();
  }, [api, mergeRequestRef, page.projectPath, page.route, page.commitSha, addLog]);

  useEffect(() => {
    const onResize = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const next = { ...ui };
      let changed = false;
      if (rect.right > window.innerWidth) { next.right = 16; changed = true; }
      if (rect.bottom > window.innerHeight) { next.top = Math.max(8, window.innerHeight - rect.height - 16); changed = true; }
      if (next.width > window.innerWidth - 32) { next.width = Math.max(MIN_WIDTH, window.innerWidth - 32); changed = true; }
      if (changed) persistUi(next);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [ui, persistUi]);

  useEffect(() => {
    const goOnline = () => { setIsOnline(true); addLog('info', 'network', '网络已恢复'); };
    const goOffline = () => { setIsOnline(false); addLog('warn', 'network', '网络已断开'); };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [addLog]);

  useEffect(() => {
    const handleMouseUp = (event: MouseEvent) => {
      // composedPath 只在派发期间有效，需同步读取：点击落在面板（Shadow DOM）内时隐藏工具条。
      const clickedInHost = Boolean(hostRef.current && event.composedPath().includes(hostRef.current));
      window.setTimeout(() => {
        if (clickedInHost) {
          setSelection(null);
          return;
        }
        const selected = captureCodeSelection(document, page.filePath ?? '');
        const anchor = document.getSelection()?.anchorNode ?? null;
        const anchorRoot = anchor?.getRootNode();
        // contains() 不跨 Shadow 边界，需再用 getRootNode 判定选区是否落在面板内。
        const inHost = Boolean(anchor && hostRef.current
          && (anchorRoot === hostRef.current.shadowRoot || hostRef.current.contains(anchor)));
        if (inHost) {
          setSelection(null);
          return;
        }
        if (selected) {
          selectionNodeRef.current = anchor;
          setSelection(selected);
        }
      }, 0);
    };
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [page.filePath]);

  // 切 tab / SPA 路由会把选区所在的 diff 行整块移除，工具条不能悬在空处。
  useEffect(() => {
    if (!selection) return;
    return watchSelection(selectionNodeRef.current, document, () => setSelection(null));
  }, [selection]);

  useEffect(() => {
    if (!showThinking) return;
    const node = thinkingPreRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [modelThinking, showThinking]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void probeCapabilities(page.origin, settings.gitlabToken).then(({ capabilities: caps, diagnostics: diags }) => {
        if (!active) return;
        setCapabilities(caps);
        setDiagnostics(diags);
        addLog('info', 'capabilities', `认证 ${caps.authMode} · MR ${caps.canReadMergeRequests ? '可读' : '不可读'} · Discussion ${caps.canCreateDiscussions ? '可写' : '不可写'}`);
      }).catch(() => undefined);
    }, 400);
    return () => { active = false; window.clearTimeout(timer); };
  }, [page.origin, settings.gitlabToken, addLog]);

  useEffect(() => {
    if (tab !== 'settings') return;
    let active = true;
    void (async () => {
      const gm = (globalThis as typeof globalThis & { GM?: { getValue: (k: string, fb: unknown) => Promise<unknown> } }).GM;
      const raw = gm
        ? await gm.getValue(SESSION_STORAGE_KEY, {})
        : JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? '{}');
      const sessions = Object.values((raw ?? {}) as Record<string, ReviewSessionManifest>);
      if (active) {
        setSessionHistory(sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 10));
      }
    })();
    return () => { active = false; };
  }, [tab]);

  // --- Repo index (symbol search / call chain) ---

  useEffect(() => {
    let active = true;
    void createRepoIndex().then((index) => {
      if (!active) return;
      setRepoIndex(index);
      setRepoStatus(index.status);
      index.subscribe((status) => setRepoStatus(status));
      addLog('info', 'repo-index', `存储后端：${index.store.backend}`);
    });
    return () => { active = false; };
  }, [addLog]);

  useEffect(() => {
    debugBus.attachConsole();
    return debugBus.registerSnapshot(() => ({
      settings: { ...settings, apiKey: settings.apiKey ? '***' : '', gitlabToken: settings.gitlabToken ? '***' : '' },
      capabilities,
      repoIndex: repoStatus,
      review: { status: reviewStatus, findings: findings.length, files: files.length },
      session: savedSession?.id,
      transport: httpTransport(),
    }));
  }, [settings, capabilities, repoStatus, reviewStatus, findings.length, files.length, savedSession]);

  useEffect(() => {
    if (!repoIndex || !mrContext) return;
    repoIndex.markCurrentRef(mrContext.diffRefs.headSha);
    if (!settings.repoIndex.enabled) return;
    if (repoIndex.status.ref === mrContext.diffRefs.headSha && repoIndex.status.state !== 'idle') return;
    void repoIndex.restore(mrContext.diffRefs.headSha).then((restored) => {
      if (restored) addLog('info', 'repo-index', '命中本地索引缓存，无需重新拉取');
    });
  }, [repoIndex, settings.repoIndex.enabled, mrContext, addLog]);

  // --- Panel drag & resize ---

  const handleDragStart = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragState.current = { startX: event.clientX, startY: event.clientY, startTop: rect.top, startRight: window.innerWidth - rect.right };
    const onMove = (move: MouseEvent) => {
      const state = dragState.current;
      if (!state || !panelRef.current) return;
      panelRef.current.style.top = `${Math.max(0, state.startTop + move.clientY - state.startY)}px`;
      panelRef.current.style.right = `${Math.max(0, state.startRight - (move.clientX - state.startX))}px`;
    };
    const onUp = () => {
      dragState.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const rect = panelRef.current?.getBoundingClientRect();
      if (rect) persistUi({ ...ui, top: rect.top, right: window.innerWidth - rect.right });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleResizeStart = (event: React.MouseEvent) => {
    event.preventDefault();
    resizeState.current = { startX: event.clientX, startWidth: ui.width };
    const onMove = (move: MouseEvent) => {
      const state = resizeState.current;
      if (!state || !panelRef.current) return;
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, state.startWidth + (state.startX - move.clientX)));
      panelRef.current.style.width = `${width}px`;
    };
    const onUp = () => {
      resizeState.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const rect = panelRef.current?.getBoundingClientRect();
      if (rect) persistUi({ ...ui, width: Math.round(rect.width) });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // --- Chat ---

  const commitPromptHistory = useCallback((entries: string[]) => {
    promptHistoryRef.current = entries;
    setPromptHistory(entries);
    savePromptHistory(entries, PROMPT_HISTORY_KEY);
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content || responding) return;
    commitPromptHistory(pushPromptHistory(promptHistoryRef.current, content));
    const userMessage: ChatMessage = { id: `user-${Date.now()}`, role: 'user', content, attachment };
    const history = [...messages, userMessage];
    setMessages(history);
    setDraft('');
    setAttachment(undefined);
    setTab('chat');

    if (!modelReady) {
      setMessages([...history, {
        id: `notice-${Date.now()}`, role: 'assistant', error: true,
        content: `对话需要配置模型。当前缺少：${config.issues.map((issue) => issue.label).join('、') || 'API Key'}。\n规则检查不需要模型，可以直接在「结果」页运行。`,
      }]);
      addLog('warn', 'chat', '模型未配置，已拒绝对话请求');
      return;
    }

    const controller = new AbortController();
    chatAbort.current = controller;
    setResponding(true);
    setToolEvents([]);
    const streamId = `stream-${Date.now()}`;
    let streamed = '';
    addLog('debug', 'chat', `发送对话请求（${content.length} 字）`);
    try {
      if (mergeRequestRef && mrContext) {
        const gitlabExecutor = new GitLabToolExecutor(api, mrContext.diffRefs.headSha);
        let executor = new CompositeToolExecutor(
          gitlabExecutor,
          undefined,
          repoIndex ? [new RepoIndexToolExecutor(repoIndex)] : [],
        );
        if (settings.mcp?.enabled) {
          const entries = (settings.mcp.servers ?? []).filter((entry) => entry.enabled && entry.url.trim());
          const connected: { id: string; client: McpClient }[] = [];
          for (const entry of entries) {
            try {
              const client = new McpClient({ url: entry.url, enabled: true });
              await client.initialize();
              if (client.availableTools.length > 0) connected.push({ id: entry.id, client });
              else addLog('warn', 'mcp', `MCP ${entry.name} 无可用工具`, entry.url);
            } catch (error) {
              addLog('warn', 'mcp', `MCP ${entry.name} 连接失败，已跳过`, String(error));
            }
          }
          if (connected.length > 0) {
            const multi = new MultiMcpClient(connected);
            executor = new CompositeToolExecutor(
              gitlabExecutor,
              multi,
              repoIndex ? [new RepoIndexToolExecutor(repoIndex)] : [],
            );
            addLog('info', 'mcp', `已接入 ${connected.length} 个 MCP 服务 / ${multi.availableTools.length} 个工具`);
          }
        }
        const agentMessages: AgentMessage[] = history
          .filter((message) => message.role !== 'system' && !message.error)
          .map((message) => ({
            role: message.role as 'user' | 'assistant',
            content: message.attachment
              ? `${message.content}\n\n${selectionQuote(message.attachment)}\n\`\`\`\n${message.attachment.text}\n\`\`\``
              : message.content,
          }));
        const result = await runAgentLoop(runtime, executor, agentMessages, {
          onEvent: (event) => setToolEvents((prev) => [...prev, event]),
          language: settings.language,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setMessages((current) => [...current, {
          id: `assistant-${Date.now()}`, role: 'assistant',
          content: result.text + (result.toolCalls.length > 0
            ? `\n\n---\n调用了 ${result.toolCalls.length} 次工具，${result.iterations} 轮推理`
            : ''),
        }]);
        addLog('info', 'chat', `对话完成（${result.iterations} 轮，${result.toolCalls.length} 次工具调用）`);
      } else {
        setMessages((current) => [...current, { id: streamId, role: 'assistant', content: '' }]);
        const answer = await runtime.chat(history, attachment, controller.signal, (token) => {
          streamed += token;
          setMessages((current) => current.map((message) => message.id === streamId ? { ...message, content: streamed } : message));
        });
        if (controller.signal.aborted) return;
        setMessages((current) => current.map((message) => message.id === streamId ? { ...message, content: answer } : message));
        addLog('info', 'chat', '对话完成');
      }
    } catch (error) {
      const cancelled = controller.signal.aborted || (error as Error).name === 'AbortError';
      const message = error instanceof Error ? error.message : String(error);
      // 流式占位必须收拾干净：空占位移除，半截内容保留并标记失败，绝不残留空转圈气泡。
      setMessages((current) => {
        const kept = current.filter((item) => item.id !== streamId);
        if (cancelled) return streamed ? current : kept;
        return [...kept, {
          id: `error-${Date.now()}`, role: 'assistant' as const, error: true,
          content: streamed ? `${streamed}\n\n---\n模型响应中断：${message}` : `模型调用失败：${message}`,
        }];
      });
      if (!cancelled) addLog('error', 'chat', '模型调用失败', message);
    } finally {
      setResponding(false);
      chatAbort.current = undefined;
    }
  }, [responding, attachment, messages, modelReady, config.issues, mergeRequestRef, mrContext, api, settings, runtime, addLog, commitPromptHistory]);

  const stopChat = () => {
    chatAbort.current?.abort();
    setResponding(false);
    addLog('warn', 'chat', '用户中断了对话');
  };

  const testModelConnection = async () => {
    if (!settings.modelBaseUrl) { setToast('请先填写 Base URL'); return; }
    setTesting(true);
    const startedAt = Date.now();
    addLog('debug', 'model', `测试连接 ${settings.modelBaseUrl}`);
    try {
      const ok = await runtime.testConnection();
      const elapsed = Date.now() - startedAt;
      if (ok) {
        setToast(`✓ 连接成功（${elapsed}ms）· ${settings.model}`);
        addLog('info', 'model', `连接成功（${elapsed}ms）`);
      } else {
        setToast('连接失败：模型服务没有返回可用响应');
        addLog('error', 'model', '连接失败');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setToast(`连接失败：${message}`);
      addLog('error', 'model', '连接异常', message);
    } finally {
      setTesting(false);
    }
  };

  // --- Review ---

  // 页面文本选区没有文件与行号，不能当 Review 范围，只能拿去提问。
  const codeAttachment = attachment && isCodeSelection(attachment) ? attachment : undefined;
  const reviewTarget = codeAttachment ?? (selection && isCodeSelection(selection) ? selection : undefined);

  // --- 参考 MR（只读上下文：不产出 Finding，也不作为发布目标）---

  const referenceApi = useCallback(
    (ref: MrLinkRef) => projectAdapter(ref.origin, ref.projectPath, settings.gitlabToken),
    [settings.gitlabToken],
  );

  const currentMrKey = mergeRequestRef
    ? mrLinkKey({ origin: mergeRequestRef.origin, projectPath: mergeRequestRef.projectPath, iid: mergeRequestRef.mergeRequestIid })
    : '';

  const fetchReferences = async (refs: MrLinkRef[], signal?: AbortSignal): Promise<ReferenceMr[]> => {
    if (refs.length === 0) return [];
    setReferenceBusy(true);
    addLog('info', 'reference', `拉取 ${refs.length} 个参考 MR`, refs.map(mrLinkLabel).join(', '));
    try {
      const loaded = await loadReferenceMrs(refs, referenceApi, signal);
      setReferences((prev) => prev.map((item) => {
        const match = loaded.find((entry) => mrLinkKey(entry.ref) === mrLinkKey(item.ref));
        return match ? { ...match, addedAt: item.addedAt } : item;
      }));
      for (const item of loaded) {
        if (item.status === 'ready') {
          addLog('info', 'reference', `参考 MR ${mrLinkLabel(item.ref)} 已就绪：${item.files.length} 个变更文件`, item.title);
        } else {
          addLog('error', 'reference', `参考 MR ${mrLinkLabel(item.ref)} 拉取失败`, item.error);
        }
      }
      const failed = loaded.filter((item) => item.status === 'failed').length;
      setToast(failed > 0
        ? `${loaded.length - failed} 个参考 MR 已就绪，${failed} 个拉取失败（原因见参考 MR 面板）`
        : `已附加 ${loaded.length} 个参考 MR，只作为本次评审的上下文`);
      return loaded;
    } catch (error) {
      if (signal?.aborted || (error as Error).name === 'AbortError') return [];
      const message = error instanceof Error ? error.message : String(error);
      addLog('error', 'reference', '拉取参考 MR 失败', message);
      setToast(`拉取参考 MR 失败：${message}`);
      return [];
    } finally {
      setReferenceBusy(false);
    }
  };

  const addReferenceLinks = () => {
    const text = referenceInput.trim();
    if (!text) return;
    const { refs, invalid } = parseMrLinks(text, page.origin);
    const known = new Set(references.map((item) => mrLinkKey(item.ref)));
    const fresh: MrLinkRef[] = [];
    const rejected: MrLinkParseFailure[] = [];
    for (const ref of refs) {
      const key = mrLinkKey(ref);
      if (key === currentMrKey) rejected.push({ input: mrWebUrl(ref), reason: '这就是当前正在评审的 MR，不需要当参考' });
      else if (known.has(key)) rejected.push({ input: mrWebUrl(ref), reason: '已经在参考列表里' });
      else { known.add(key); fresh.push(ref); }
    }
    setReferenceInvalid([...invalid, ...rejected]);
    if (fresh.length === 0) {
      setToast('没有可附加的参考 MR：链接无法解析，或已经在列表里');
      return;
    }
    setReferenceInput('');
    setReferences((prev) => [
      ...prev,
      ...fresh.map((ref): ReferenceMr => ({ ref, status: 'loading', files: [], addedAt: new Date().toISOString() })),
    ]);
    void fetchReferences(fresh);
  };

  const removeReference = (key: string) => {
    setReferences((prev) => prev.filter((item) => mrLinkKey(item.ref) !== key));
  };

  const toggleReferenceCandidate = (key: string) => {
    const source = referenceCandidates.find((item) => mrLinkKey(item.ref) === key);
    if (!source) return;
    if (references.some((item) => mrLinkKey(item.ref) === key)) {
      removeReference(key);
      return;
    }
    setReferences((prev) => [...prev, { ref: source.ref, status: 'loading', files: [], addedAt: new Date().toISOString() }]);
    void fetchReferences([source.ref]);
  };

  /** 候选列表：本地评审记录置顶，再叠上 GitLab 最近活动（scope=all，跨项目）。 */
  const loadReferenceCandidates = async () => {
    setCandidateLoading(true);
    setCandidateError('');
    const history = await loadHistory();
    const pool: ReferenceCandidateSource[] = history
      .map((session) => ({
        ref: { origin: session.origin, projectPath: session.projectPath, iid: session.mergeRequestIid },
        group: 'history' as const,
        title: session.title,
        meta: session.updatedAt.slice(5, 16).replace('T', ' '),
      }))
      .filter((item) => mrLinkKey(item.ref) !== currentMrKey);
    const seen = new Set(pool.map((item) => mrLinkKey(item.ref)));
    try {
      const recent = await api.listRecentMergeRequests({ limit: 20 });
      addLog('info', 'reference', `GitLab 最近活动返回 ${recent.length} 个 MR`);
      for (const item of recent) {
        const key = mrLinkKey(item.ref);
        if (key === currentMrKey || seen.has(key)) continue;
        seen.add(key);
        pool.push({
          ref: item.ref, group: 'recent', title: item.title,
          meta: item.updatedAt.slice(5, 16).replace('T', ' '),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCandidateError(message);
      addLog('error', 'reference', '读取最近活动 MR 失败', message);
    } finally {
      setReferenceCandidates(pool);
      setCandidateLoading(false);
    }
  };

  /** 开跑前把还没就绪的参考 MR 再拉一次：换了 Token 或网络抖动能自己恢复，拉不到就在结果里说明。 */
  const settleReferences = async (signal?: AbortSignal): Promise<ReferenceMr[]> => {
    const pending = references.filter((item) => item.status !== 'ready');
    if (pending.length === 0) return references;
    const reloaded = await fetchReferences(pending.map((item) => item.ref), signal);
    return references.map((item) => reloaded.find((entry) => mrLinkKey(entry.ref) === mrLinkKey(item.ref)) ?? item);
  };

  const referenceCandidateList = useMemo<ReferenceCandidate[]>(() => {
    const attached = new Set(references.map((item) => mrLinkKey(item.ref)));
    return referenceCandidates.map((item) => ({
      key: mrLinkKey(item.ref), label: mrLinkLabel(item.ref), title: item.title, meta: item.meta,
      group: item.group, checked: attached.has(mrLinkKey(item.ref)),
    }));
  }, [referenceCandidates, references]);

  const startReview = async (scope: 'all' | 'selection') => {
    const selected = scope === 'selection' ? reviewTarget : codeAttachment;
    const scopedFiles = scope === 'selection' && selected
      ? files.filter((file) => file.newPath === selected.filePath || file.oldPath === selected.filePath)
      : files;

    if (scopedFiles.length === 0 && !selected) {
      setReviewError('没有可用的 MR Diff：请在 MR 的 Changes 页面打开侧栏，或先划选一段代码再针对选区 Review。');
      setReviewStatus('failed');
      setTab('review');
      return;
    }
    const runRules = settings.reviewMode !== 'ai';
    const runModel = settings.reviewMode !== 'rules';
    if (!runRules && !modelReady) {
      setReviewError('「仅 AI」模式需要配置模型。请补全模型配置，或切换到「规则 + AI」/「仅规则」。');
      setReviewStatus('failed');
      setTab('settings');
      return;
    }

    reviewAbort.current?.abort();
    const controller = new AbortController();
    reviewAbort.current = controller;
    setTab('review');
    setReviewStatus('preparing');
    setScanMode(false);
    setReviewError('');
    setReviewWarnings([]);
    setStages(undefined);
    setFindings([]);
    setModelStream('');
    setModelThinking('');
    setShowRaw(false);
    setShowThinking(false);
    setPartialModelCount(0);
    modelContentRef.current = '';
    bundleModelRef.current = [];
    lastBackgroundRef.current = '';
    ruleLiveRef.current = [];
    lastPartialCountRef.current = 0;
    lastPartialParseRef.current = 0;
    setSelectedFindings(new Set());
    addLog('info', 'review', `开始 Review（${scope === 'selection' ? '选区' : '整个 MR'} · ${settings.reviewMode}）`, `${scopedFiles.length} 个文件`);

    const session = mergeRequestRef && mrContext
      ? createReviewSession({
        ref: mergeRequestRef,
        headSha: mrContext.diffRefs.headSha,
        title: mrContext.title,
        scope,
        source: runModel && modelReady ? 'model' : 'rule',
        settings,
      })
      : undefined;
    if (session) {
      currentSessionRef.current = session;
      setSavedSession(session);
      void saveReviewSession(session);
    }

    try {
      setReviewStatus('running');
      const reviewReferences = await settleReferences(controller.signal);
      if (controller.signal.aborted) return;
      const readyReferences = reviewReferences.filter((item) => item.status === 'ready');
      if (readyReferences.length > 0) {
        addLog('info', 'review', `本次评审附加 ${readyReferences.length} 个参考 MR（只读上下文）`,
          readyReferences.map((item) => `${mrLinkLabel(item.ref)} · ${item.files.length} 文件`).join(', '));
      }
      const repoContext = runModel && modelReady && settings.repoContext && repoIndex?.ready && repoIndex.inSync
        ? repoIndex.contextForFiles(scopedFiles.map((file) => file.newPath))
        : '';
      if (repoContext) addLog('debug', 'review', `注入仓库符号上下文 ${repoContext.length} 字符`);
      lastBackgroundRef.current = repoContext;
      const projectPrompt = (settings.projectPrompts ?? {})[page.projectPath ?? '']?.trim();
      if (projectPrompt) addLog('info', 'review', `注入项目补充 prompt ${projectPrompt.length} 字符（${page.projectPath}）`);
      const result = await reviewEngine.run({
        files: scopedFiles,
        selection: selected,
        signal: controller.signal,
        rules: runRules,
        model: runModel,
        references: reviewReferences,
        background: repoContext ? `仓库符号上下文（本地索引 @${repoIndex?.status.ref.slice(0, 8)}）：\n${repoContext}` : undefined,
        loadFile: (path, ref) => api.getFile(path, ref),
        fullFileRef: mrContext?.diffRefs.headSha ?? page.commitSha,
        onRuleFindings: (ruleFindings) => {
          ruleLiveRef.current = ruleFindings;
          setFindings(ruleFindings);
        },
        onModelToken: (token) => {
          modelContentRef.current += token;
          setModelStream((prev) => (prev + token).slice(-20000));
          const now = Date.now();
          if (now - lastPartialParseRef.current < 200) return;
          lastPartialParseRef.current = now;
          const objects = extractPartialFindings(modelContentRef.current);
          if (objects.length === lastPartialCountRef.current) return;
          lastPartialCountRef.current = objects.length;
          try {
            const partial = parseModelFindings(`{"findings":[${objects.join(',')}]}`, scopedFiles);
            setPartialModelCount(partial.length);
            setFindings([...ruleLiveRef.current, ...partial]);
          } catch {
            // 片段尚未完整，等待后续 token
          }
        },
        onModelThinking: (token) => setModelThinking((prev) => (prev + token).slice(-20000)),
        projectPrompt: (settings.projectPrompts ?? {})[page.projectPath ?? '']?.trim() || undefined,
        onBundleFindings: (bundleFindings) => {
          bundleModelRef.current = [...bundleModelRef.current, ...bundleFindings];
          setFindings([...ruleLiveRef.current, ...bundleModelRef.current]);
        },
      });
      if (controller.signal.aborted) return;

      let synced = result.findings;
      if (mergeRequestRef) {
        try {
          const existing = await api.getExistingCommentBodies(mergeRequestRef);
          if (existing.size > 0) {
            const matched = synced.filter((finding) => existing.has(finding.comment.trim())).length;
            synced = synced.map((finding) => existing.has(finding.comment.trim())
              ? { ...finding, status: 'published' as const }
              : finding);
            if (matched > 0) setToast(`${matched} 个问题匹配到已有 Discussion，已标记为已发布`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addLog('warn', 'review', '读取已有 Discussion 失败，跳过去重标记', message);
          setReviewWarnings((current) => [...current, `读取已有 Discussion 失败（${message}），已跳过去重标记；发布前请人工确认未重复评论。`]);
          setToast('读取已有 Discussion 失败，已跳过去重标记');
        }
      }

      setFindings(synced);
      setStages(result.stages);
      if (result.stages.model.ran === false && result.stages.model.error) {
        setToast(`AI 评审未运行：${result.stages.model.error}`);
      }
      setReviewWarnings(result.warnings);
      setExpandedFinding(synced[0]?.id ?? '');
      setReviewStatus('completed');
      addLog('info', 'review',
        `Review 完成：规则 ${result.stages.rules.findings} 条 · AI ${result.stages.model.findings} 条`,
        result.warnings.join(' | '));

      const ruleCount = synced.filter((finding) => finding.source === 'rule').length;
      const modelCount = synced.filter((finding) => finding.source === 'model').length;
      const corroborated = synced.filter((finding) => finding.corroborated).length;
      const high = synced.filter((finding) => finding.severity === 'critical' || finding.severity === 'high').length;
      setMessages((prev) => [...prev, {
        id: `review-${Date.now()}`,
        role: 'assistant',
        content: synced.length === 0
          ? 'Review 完成，没有发现需要处理的问题。'
          : [
            `**Review 完成**：共 ${synced.length} 个问题${high > 0 ? `，其中 ${high} 个高危` : ''}。`,
            `- 规则命中：${ruleCount} 条（确定性检查，本地执行）`,
            `- AI 评审：${modelCount} 条${corroborated > 0 ? `，其中 ${corroborated} 条与规则相互印证` : ''}`,
            result.stages.model.ran ? '' : `- AI 评审未运行：${modelReady ? '当前为仅规则模式' : '未配置模型'}`,
            '',
            '结果已列在「结果」页，可逐条编辑、定位、忽略，确认后发布到 GitLab。',
          ].filter((line) => line !== '').join('\n'),
        findings: synced,
      }]);

      if (session) {
        const completed = updateReviewSession(session, {
          status: 'completed',
          source: result.source,
          findings: synced.map(toSessionFinding),
          warnings: result.warnings,
          context: summarizeReviewContext(result.context),
        });
        currentSessionRef.current = completed;
        setSavedSession(completed);
        void saveReviewSession(completed);
      }
    } catch (error) {
      if (controller.signal.aborted || (error as Error).name === 'AbortError') return;
      const message = error instanceof Error ? error.message : String(error);
      setReviewError(message);
      setReviewStatus('failed');
      addLog('error', 'review', 'Review 失败', message);
      if (session) {
        const failed = updateReviewSession(session, { status: 'failed', error: message });
        currentSessionRef.current = failed;
        setSavedSession(failed);
        void saveReviewSession(failed);
      }
    }
  };

  const cancelReview = () => {
    reviewAbort.current?.abort();
    setReviewStatus('cancelled');
    setReviewError('');
    addLog('warn', 'review', '用户取消了 Review');
    const session = currentSessionRef.current;
    if (session) {
      const cancelled = updateReviewSession(session, { status: 'cancelled', error: '运行已取消。' });
      currentSessionRef.current = cancelled;
      setSavedSession(cancelled);
      void saveReviewSession(cancelled);
    }
  };

  /** 只复位本轮 Review 生命周期：chat 会话、设置、GitLab 配置、debug 记录、已落盘会话（含已发布标记）都原样保留。 */
  const resetReview = () => {
    if (running) return;
    modelContentRef.current = '';
    bundleModelRef.current = [];
    ruleLiveRef.current = [];
    lastBackgroundRef.current = '';
    lastPartialParseRef.current = 0;
    lastPartialCountRef.current = 0;
    setReviewStatus('idle');
    setReviewError('');
    setReviewWarnings([]);
    setStages(undefined);
    setFindings([]);
    setExpandedFinding('');
    setSelectedFindings(new Set());
    setModelStream('');
    setModelThinking('');
    setShowThinking(false);
    setShowRaw(false);
    setShowRawThinking(false);
    setPartialModelCount(0);
    setScanMode(false);
    setPublishFinding(undefined);
    setBatchConfirm(false);
    clearHighlights();
    setTab('review');
    setPromptFocus((tick) => tick + 1);
    addLog('info', 'review', '已复位 Review：清除本轮结果，回到 prompt 输入界面');
    setToast('已回到初始状态，可以开始新一轮 Review');
  };

  const persistFindings = (next: Finding[]) => {
    setFindings(next);
    const session = currentSessionRef.current;
    if (!session) return;
    const updated = updateReviewSession(session, { findings: next.map(toSessionFinding) });
    currentSessionRef.current = updated;
    setSavedSession(updated);
    void saveReviewSession(updated);
  };

  const editFinding = (id: string, edit: FindingEdit) => {
    persistFindings(findings.map((finding) => finding.id === id ? applyFindingEdit(finding, edit) : finding));
    addLog('info', 'finding', `已编辑 Finding ${id}`);
    setToast('Finding 修改已保存');
  };

  const ignoreFinding = (id: string) => {
    persistFindings(findings.map((finding) => finding.id === id ? { ...finding, status: 'ignored' as const } : finding));
    setSelectedFindings((prev) => { const next = new Set(prev); next.delete(id); return next; });
  };

  const setFindingStatus = (id: string, status: Finding['status']) => {
    persistFindings(findings.map((finding) => (finding.id === id ? { ...finding, status } : finding)));
  };

  const viewerSession = sessionHistory.find((item) => item.key === viewerKey) ?? savedSession;
  const viewerFindings = useMemo(() => {
    const list = (viewerSession?.findings ?? []).map(fromSessionFinding);
    return hideHandled ? list.filter((finding) => !['published', 'ignored', 'fixed'].includes(finding.status)) : list;
  }, [viewerSession, hideHandled]);

  const markViewerFinding = (id: string, status: Finding['status']) => {
    if (!viewerSession) return;
    const updated = updateSessionFindingStatus(viewerSession, id, status);
    setSessionHistory((list) => list.map((item) => (item.key === updated.key ? updated : item)));
    if (savedSession?.key === updated.key) setSavedSession(updated);
    void saveReviewSession(updated);
    if (currentSessionRef.current?.key === updated.key) {
      currentSessionRef.current = updated;
      setFindings((current) => current.map((finding) => (finding.id === id ? { ...finding, status } : finding)));
    }
  };

  const openViewer = () => {
    if (sessionHistory.length === 0) void loadHistory();
    setViewerKey(savedSession?.key ?? sessionHistory[0]?.key ?? '');
    setViewerOpen(true);
  };

  const restoreViewerSession = async () => {
    if (!viewerSession) return;
    const resumed = resumeReviewSession(viewerSession);
    currentSessionRef.current = resumed.session;
    setSavedSession(resumed.session);
    setFindings(resumed.findings);
    setStages(undefined);
    setExpandedFinding(resumed.findings[0]?.id ?? '');
    setReviewStatus(resumed.status);
    setReviewError(resumed.error ?? '');
    setScanMode(false);
    setViewerOpen(false);
    setTab('review');
    await saveReviewSession(resumed.session);
    setToast(`已恢复会话（${resumed.findings.length} 个问题）`);
  };

  const locateFinding = (finding: Finding) => {
    injectHighlightStyles();
    const label = locateLabel(finding.path, finding.line);
    void highlightFindingOnPage(finding).then((outcome) => {
      setToast(locateMessage(label, outcome));
      addLog(outcome.highlighted.length > 0 ? 'debug' : 'warn', 'finding',
        `定位 ${label} → ${outcome.highlighted.length} 行`,
        outcome.failure ?? (outcome.fileLevel ? 'file-level' : undefined));
    });
  };

  /** 切 Changes tab 触发整页跳转时，定位意图存在 sessionStorage 里，新页面加载完接着走完。 */
  useEffect(() => {
    const pending = takePendingLocate();
    if (!pending) return;
    const label = locateLabel(pending.path, pending.line);
    const timer = window.setTimeout(() => {
      injectHighlightStyles();
      void highlightFindingOnPage(pending).then((outcome) => {
        setToast(locateMessage(label, outcome));
        addLog(outcome.highlighted.length > 0 ? 'debug' : 'warn', 'finding',
          `跳转后续定位 ${label} → ${outcome.highlighted.length} 行`, outcome.failure);
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [addLog]);

  const copyFinding = (finding: Finding) => {
    void navigator.clipboard?.writeText(finding.comment);
    setToast('评论草稿已复制，可直接粘贴到 GitLab');
  };

  const resumeSession = async () => {
    if (!savedSession) return;
    const resumed = resumeReviewSession(savedSession);
    currentSessionRef.current = resumed.session;
    setSavedSession(resumed.session);
    setFindings(resumed.findings);
    setStages(undefined);
    setExpandedFinding(resumed.findings[0]?.id ?? '');
    setReviewStatus(resumed.status);
    setReviewError(resumed.error ?? '');
    setTab('review');
    await saveReviewSession(resumed.session);
    setToast(`已恢复上次 Review（${resumed.findings.length} 个问题）`);
    addLog('info', 'session', `恢复会话 ${resumed.session.id}`);
  };

  useEffect(() => {
    if (!projectKey) {
      setProjectPacks([]);
      return;
    }
    let active = true;
    void loadScopedRulePacks({ kind: 'project', key: projectKey }).then((packs) => {
      if (active) setProjectPacks(packs.filter((pack) => !pack.builtIn));
    });
    return () => { active = false; };
  }, [projectKey]);

  // --- Rule packs ---

  const updatePacks = async (next: RulePack[]) => {
    setScopePacks(next);
    await saveScopedRulePacks(next, activePackScope);
  };

  const toggleRulePack = async (packId: string, enabled: boolean) => {
    await updatePacks(scopePacks.map((pack) => pack.id === packId ? { ...pack, enabled } : pack));
    setToast(enabled ? '规则包已启用' : '规则包已停用');
  };

  const toggleRule = async (packId: string, ruleId: string) => {
    await updatePacks(scopePacks.map((pack) => pack.id !== packId ? pack : {
      ...pack,
      rules: pack.rules.map((rule) => rule.id === ruleId ? { ...rule, enabled: !rule.enabled } : rule),
    }));
  };

  const deleteRulePack = async (packId: string) => {
    const next = await removeScopedRulePack(packId, activePackScope);
    setScopePacks(next.filter((pack) => activePackScope.kind === 'public' || !pack.builtIn));
    setToast('规则包已删除');
  };

  const createNewPack = async () => {
    const pack: RulePack = {
      id: generateRulePackId(), name: '自定义规则包', version: '1.0.0', description: '',
      enabled: true, builtIn: false,
      rules: [{
        id: generateRuleId(), enabled: true, severity: 'medium', category: 'maintainability',
        title: '新规则', content: '说明这条规则为什么重要。', matchPatterns: [{ type: 'regex', pattern: '' }],
      } satisfies RuleDef],
    };
    const next = await addScopedRulePack(pack, activePackScope);
    setScopePacks(next.filter((pack) => activePackScope.kind === 'public' || !pack.builtIn));
    setToast('已创建规则包');
  };

  const handleImportPack = (json: string) => {
    const result = importRulePack(json);
    if (result.errors.length > 0 || !result.pack) {
      setImportError(result.errors.join('; ') || '导入失败');
      setToast('规则包导入失败');
      return;
    }
    setImportError('');
    void addScopedRulePack(result.pack, activePackScope).then((next) => {
      setScopePacks(next.filter((pack) => activePackScope.kind === 'public' || !pack.builtIn));
      setToast(`规则包「${result.pack?.name}」已导入`);
    });
  };

  const handleExportPack = (packId: string) => {
    const pack = scopePacks.find((item) => item.id === packId);
    if (!pack) return;
    void navigator.clipboard?.writeText(exportRulePack(pack));
    setToast('规则包 JSON 已复制到剪贴板');
  };

  const commitSettings = useCallback((next: RuntimeSettings) => {
    setSettings(next);
    void saveSettings(next);
  }, []);

  const handleApprove = async () => {
    if (!mergeRequestRef) return;
    setQuickBusy(true);
    try {
      await api.approveMergeRequest(mergeRequestRef);
      setToast('已 Approve 该 MR');
      addLog('info', 'publish', `已 Approve MR !${mergeRequestRef.mergeRequestIid}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setToast(`Approve 失败：${message}`);
      addLog('error', 'publish', 'Approve 失败', message);
    } finally {
      setQuickBusy(false);
    }
  };

  const handlePublishAll = async () => {
    if (!mergeRequestRef || !mrContext || !canPublish) return;
    const targets = resolvedFindings.filter(publishable);
    if (targets.length === 0) return;
    setQuickBusy(true);
    const { inline, full, published, failed } = await publishEach(mergeRequestRef, targets);
    setQuickBusy(false);
    setToast(`已发布 ${publishedCountLabel(published, inline, full)}${failed > 0 ? `，失败 ${failed} 条` : ''}`);
  };

  const handleScanIndexed = async () => {
    if (!repoIndex?.ready) return;
    setScanning(true);
    try {
      const indexed = await repoIndex.readIndexedFiles();
      const diffs = indexed.map((entry) => normalizeFileDiff({
        old_path: entry.path,
        new_path: entry.path,
        diff: `@@ -0,0 +1,${entry.content.split('\n').length} @@\n${entry.content.split('\n').map((line) => `+${line}`).join('\n')}`,
      }));
      const scanned = reviewEngine.scan(diffs);
      setScanMode(true);
      setFindings(scanned);
      setStages(undefined);
      setReviewWarnings([]);
      setReviewStatus('completed');
      setTab('review');
      setToast(`扫描完成：${indexed.length} 个文件 → ${scanned.length} 条规则命中`);
      addLog('info', 'review', `全文件扫描 ${indexed.length} 文件 → ${scanned.length} 命中`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setToast(`扫描失败：${message}`);
      addLog('error', 'review', '全文件扫描失败', message);
    } finally {
      setScanning(false);
    }
  };

  const handleExportFindings = () => {
    const payload = serializeFindingsExport(findings, {
      project: page.projectPath ?? undefined,
      mergeRequestIid: mergeRequestRef?.mergeRequestIid,
      headSha: mrContext?.diffRefs.headSha,
    });
    void navigator.clipboard?.writeText(payload);
    setToast(`已复制 ${findings.length} 条 findings 的结构化 JSON`);
    addLog('info', 'publish', '导出 findings JSON', `${payload.length} 字符`);
  };

  const handleExportDelegation = () => {
    const payload = buildDelegationContext({
      files,
      packs: rulePacks,
      background: lastBackgroundRef.current || undefined,
      meta: {
        project: page.projectPath ?? undefined,
        mergeRequestIid: mergeRequestRef?.mergeRequestIid,
        headSha: mrContext?.diffRefs.headSha,
      },
    });
    void navigator.clipboard?.writeText(payload);
    setToast('已复制 Delegation 上下文（文件选择 + 规则解析 + Diff）');
    addLog('info', 'review', '导出 Delegation 上下文', `${payload.length} 字符`);
  };

  const handleSummaryComment = async () => {
    if (!mergeRequestRef || findings.length === 0) return;
    setQuickBusy(true);
    try {
      await api.createNote(mergeRequestRef, buildSummaryComment(findings));
      setToast('总评论已发布');
      addLog('info', 'publish', '已发布 MR 总评论');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setToast(`总评论发布失败：${message}`);
      addLog('error', 'publish', '总评论发布失败', message);
    } finally {
      setQuickBusy(false);
    }
  };

  // --- Publishing ---

  /** 位置校验通过的 Finding 才带 position；其余交给 publishComment 发 MR 级全文评论。 */
  const buildPosition = (input: Finding): DiscussionPosition | undefined => {
    const position = publishPositions.get(input.id);
    if (!position?.publishable) return undefined;
    const finding = position.finding;
    return {
      path: finding.path,
      oldPath: finding.oldPath ?? finding.path,
      newPath: finding.newPath ?? finding.path,
      startLine: finding.line,
      endLine: finding.endLine,
      side: finding.side,
      ...position.lines,
      diffRefs: mrContext!.diffRefs,
    };
  };

  /** 逐条发布（行内不可用自动降级全文），返回各形态条数并回写状态。 */
  const publishEach = async (ref: MergeRequestRef, targets: Finding[]) => {
    const succeeded = new Set<string>();
    let inline = 0;
    let full = 0;
    for (const finding of targets) {
      try {
        const published = await api.publishComment(ref, finding, finding.comment, buildPosition(finding));
        succeeded.add(finding.id);
        if (published.mode === 'inline') inline += 1; else full += 1;
      } catch (error) {
        addLog('error', 'publish', `发布失败 ${finding.path}:${finding.line}`, error instanceof Error ? error.message : String(error));
      }
    }
    const attempted = new Set(targets.map((finding) => finding.id));
    persistFindings(findings.map((finding) => {
      if (!attempted.has(finding.id)) return finding;
      return { ...finding, status: succeeded.has(finding.id) ? 'published' as const : 'failed' as const };
    }));
    return { inline, full, published: succeeded.size, failed: targets.length - succeeded.size };
  };

  const confirmPublish = async () => {
    if (!publishFinding || !mergeRequestRef || !mrContext || !canPublish) return;
    setPublishing(true);
    try {
      const published = await api.publishComment(mergeRequestRef, publishFinding, publishBody, buildPosition(publishFinding));
      persistFindings(findings.map((finding) => finding.id === publishFinding.id ? { ...finding, status: 'published' as const, comment: publishBody } : finding));
      setPublishFinding(undefined);
      setToast(published.mode === 'inline' ? '行级 Discussion 已发布' : '行内不可用，已改为全文评论');
      addLog('info', 'publish', `已发布${published.mode === 'inline' ? '行内' : '全文'}评论 ${publishFinding.path}:${publishFinding.line}`);
    } catch (error) {
      const code = error instanceof GitLabApiError ? `${error.code}: ` : '';
      const message = error instanceof Error ? error.message : String(error);
      setToast(`发布失败 ${code}${message}`);
      addLog('error', 'publish', '发布失败', `${code}${message}`);
      persistFindings(findings.map((finding) => finding.id === publishFinding.id ? { ...finding, status: 'failed' as const } : finding));
    } finally {
      setPublishing(false);
    }
  };

  const publishableSelected = resolvedFindings.filter(
    (finding) => selectedFindings.has(finding.id) && publishable(finding),
  );

  const selectAllPublishable = () => {
    setSelectedFindings(new Set(resolvedFindings.filter(publishable).map((finding) => finding.id)));
  };

  const toggleFindingSelection = (id: string) => {
    setSelectedFindings((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const batchConfirmPublish = async () => {
    if (publishableSelected.length === 0 || !mergeRequestRef || !mrContext || !canPublish) return;
    setBatchPublishing(true);
    const { inline, full, published, failed } = await publishEach(mergeRequestRef, publishableSelected);
    setSelectedFindings(new Set());
    setBatchConfirm(false);
    setBatchPublishing(false);
    setToast(`批量发布完成：${published} 成功${full > 0 ? `（${publishModeSummary(inline, full)}）` : ''}${failed > 0 ? `，${failed} 失败` : ''}`);
    addLog('info', 'publish', `批量发布 ${published} 成功（行内 ${inline} · 全文 ${full}）/ ${failed} 失败`);
  };

  // --- Apply fix：模型生成补丁 → 用户确认 → 提交回 MR 源分支（与发布链路互不干涉）---

  /** 开关关掉时入口整个不渲染；开着但不是可修复候选（模糊建议 / 架构类 / 文件级规则）同样不渲染。 */
  const fixable = useCallback(
    (finding: Finding) => settings.applyFixEnabled && isFixCandidate(finding),
    [settings.applyFixEnabled],
  );

  const fixDisabledReason = !settings.applyFixEnabled
    ? undefined
    : !mergeRequestRef || !mrContext
      ? '当前页面不是 MR，无法提交修复'
      : !modelReady
        ? '生成修复需要先配置模型服务'
        : running
          ? '评审进行中，请等本次 Review 结束后再应用修复'
          : fixStage === 'committing'
            ? '正在提交修复，请稍候'
            : undefined;

  const closeFixDialog = () => {
    fixAbort.current?.abort();
    fixAbort.current = undefined;
    setFixTarget(undefined);
    setFixPlan(undefined);
    setFixError('');
    setFixStage('ready');
  };

  /** 修复提交成功后 MR 的 head 变了：重新拉一次变更，行号锚点与 diff_refs 才不会停留在旧 head。 */
  const reloadMrChanges = useCallback(async () => {
    if (!mergeRequestRef) return;
    try {
      const [context, diffs] = await Promise.all([
        api.getMergeRequest(mergeRequestRef),
        api.listDiffs(mergeRequestRef),
      ]);
      setMrContext(context);
      setFiles(diffs);
      addLog('info', 'gitlab', `已刷新 MR 变更（${diffs.length} 个文件）`, `head ${context.diffRefs.headSha.slice(0, 8)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog('warn', 'gitlab', '修复已提交，但刷新 MR 变更失败', message);
      setToast(`修复已提交，但刷新 MR 变更失败：${message}`);
    }
  }, [api, mergeRequestRef, addLog]);

  const openApplyFix = async (finding: Finding) => {
    // 开关关掉后入口不渲染，这里再挡一次：任何路径都走不到提交
    if (!settings.applyFixEnabled || !isFixCandidate(finding) || !mrContext) return;
    const branch = mrContext.sourceBranch;
    const controller = new AbortController();
    fixAbort.current?.abort();
    fixAbort.current = controller;
    setFixTarget(finding);
    setFixPlan(undefined);
    setFixError('');
    setFixStage('generating');
    addLog('info', 'fix', `生成修复方案 ${finding.path}:${finding.line}`, `源分支 ${branch} · ${finding.ruleId ?? 'model'}`);
    try {
      const before = await api.getFile(finding.path, branch, controller.signal);
      const raw = await runtime.generateFix(buildFixPayload(finding, before), settings.language, controller.signal);
      const result = parseFixResponse(raw, before);
      if (controller.signal.aborted) return;
      setFixPlan(createFixPlan({ finding, branch, before, content: result.content }));
      setFixStage('ready');
      addLog('info', 'fix', `修复方案已生成（${result.mode}）`, `${finding.path} · ${result.content.length} 字符`);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = describeFixFailure(error);
      setFixError(message);
      setFixStage('ready');
      addLog('error', 'fix', `生成修复失败 ${finding.path}`, message);
    }
  };

  const confirmApplyFix = async () => {
    const target = fixTarget;
    const plan = fixPlan;
    if (!target || !plan || !settings.applyFixEnabled) return;
    setFixStage('committing');
    setFixError('');
    try {
      const commit = await api.createCommit({
        branch: plan.branch,
        message: plan.message,
        description: plan.description,
        files: plan.changes.map((change) => ({ path: change.path, content: change.content, action: change.action })),
      });
      closeFixDialog();
      setFindingStatus(target.id, 'fixed');
      setToast(`已提交修复 ${commit.shortId} 到 ${plan.branch}`);
      addLog('info', 'fix', `已提交修复 ${commit.shortId} 到 ${plan.branch}`, `${commit.webUrl}`);
      await reloadMrChanges();
    } catch (error) {
      const message = describeFixFailure(error);
      setFixError(message);
      setFixStage('ready');
      addLog('error', 'fix', `提交修复失败（${plan.branch}）`, message);
      setToast(`提交修复失败：${message}`);
    }
  };

  // --- Keyboard shortcuts ---

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return; // IME 组合输入中，快捷键全部让位
      if (event.key === 'Escape') {
        // 提交进行中不接 Escape：这时候关掉弹窗也拦不住已经发出去的提交
        if (fixTarget && fixStage !== 'committing') closeFixDialog();
        else if (publishFinding) setPublishFinding(undefined);
        else if (batchConfirm) setBatchConfirm(false);
        else if (selection) setSelection(null);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        if (reviewStatus !== 'running' && reviewStatus !== 'preparing') void startReview(codeAttachment ? 'selection' : 'all');
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        persistUi({ ...ui, open: true });
        setTab((current) => current === 'chat' ? 'review' : 'chat');
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  });

  const loadHistory = useCallback(async (): Promise<ReviewSessionManifest[]> => {
    const gm = (globalThis as typeof globalThis & { GM?: { getValue: (k: string, fb: unknown) => Promise<unknown> } }).GM;
    const raw = gm
      ? await gm.getValue(SESSION_STORAGE_KEY, {})
      : JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? '{}');
    const sessions = Object.values((raw ?? {}) as Record<string, ReviewSessionManifest>)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .slice(0, 10);
    setSessionHistory(sessions);
    return sessions;
  }, []);

  const unseenErrors = useSyncExternalStore(
    useCallback((listener: () => void) => debugBus.subscribe(listener), []),
    () => debugBus.unseenErrorCount(),
  );

  useEffect(() => {
    if (tab === 'debug') debugBus.markErrorsSeen();
  }, [tab]);

  useEffect(() => {
    if (!settings.debugEnabled && tab === 'debug') setTab('review');
  }, [settings.debugEnabled, tab]);

  return (
    <div ref={hostRef} className="ra-host" style={{ position: 'relative' }}>
      <InjectAnimations />

      {!ui.open && (
        <button
          type="button" onClick={() => persistUi({ ...ui, open: true })} aria-label="打开 Review Agent"
          title="Review Agent（Ctrl/⌘ + K）"
          style={{
            position: 'fixed', bottom: 20, right: 20, zIndex: 2147483647,
            width: 44, height: 44, borderRadius: 22, border: 0, cursor: 'pointer',
            display: 'grid', placeItems: 'center', color: '#fff', background: C.primary,
            boxShadow: '0 6px 18px rgba(36,95,199,0.35), 0 2px 6px rgba(0,0,0,0.15)',
          }}
        >
          <Sparkles size={19} />
          {!modelReady && settingsLoaded && (
            <span title="模型未配置：仅规则检查可用" style={{ position: 'absolute', top: 1, right: 1, width: 9, height: 9, borderRadius: '50%', background: C.warning, border: '2px solid #fff' }} />
          )}
        </button>
      )}

      <aside
        ref={panelRef}
        aria-label="Review Agent"
        style={{
          position: 'fixed', zIndex: 2147483000, display: ui.open ? 'flex' : 'none', flexDirection: 'column',
          top: ui.top, right: ui.right, width: ui.width,
          height: `min(calc(100vh - ${Math.max(24, ui.top + 16)}px), 760px)`,
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: C.radiusLg,
          boxShadow: '0 18px 48px rgba(15,23,42,0.24), 0 4px 12px rgba(15,23,42,0.12)',
          overflow: 'hidden',
        }}
      >
        <div
          onMouseDown={handleResizeStart}
          title="拖动调整宽度"
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, cursor: 'col-resize', zIndex: 5 }}
        />

        {/* Header */}
        <header
          onMouseDown={handleDragStart}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px 9px 14px',
            background: C.headerBg, color: C.headerText, cursor: 'grab', userSelect: 'none', flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Sparkles size={14} style={{ color: '#7ea6f0', flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.01em' }}>Review Agent</span>
              {modelReady
                ? <span title={`模型 ${settings.model}`} style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 10, background: 'rgba(126,166,240,0.22)', color: '#c9dcff' }}>规则 + AI</span>
                : <span title="未配置模型 API Key，只能运行本地规则检查" style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 10, background: 'rgba(217,119,6,0.25)', color: '#ffd79a' }}>仅规则</span>}
            </div>
            <div style={{ marginTop: 3, fontSize: 11, color: C.headerMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {loading ? '正在读取 GitLab API…'
                : mrContext ? mrContext.title
                  : page.projectPath ? `${page.projectPath}${page.filePath ? ` · ${page.filePath}` : ''}`
                    : 'GitLab 页面'}
            </div>
          </div>
          {mergeRequestRef && (
            <a
              href={`${page.origin}/${page.projectPath}/-/merge_requests/${mergeRequestRef.mergeRequestIid}`}
              target="_blank" rel="noopener noreferrer" aria-label="在 GitLab 中打开此 MR" title="在 GitLab 中打开此 MR"
              style={{ display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: C.radiusSm, color: C.headerMuted }}
            ><ExternalLink size={14} /></a>
          )}
          <a
            href="https://mizuka-wu.github.io/review-agent-glab-monkey-script/"
            target="_blank" rel="noopener noreferrer" aria-label="技术文档" title="技术文档（GitHub Pages）"
            style={{ display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: C.radiusSm, color: C.headerMuted }}
          ><BookOpen size={14} /></a>
          <IconButton
            tone="dark" icon={<X size={15} />} label="关闭侧栏"
            onClick={() => { clearHighlights(); persistUi({ ...ui, open: false }); }}
          />
        </header>

        {/* Action bar */}
        <div role="toolbar" aria-label="Review 操作" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: C.headerBg, borderTop: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          <Btn
            variant="primary" size="sm"
            icon={running ? <Loader2 size={13} className="ra-spin" /> : <Play size={13} />}
            disabled={running || (files.length === 0 && !reviewTarget)}
            onClick={() => void startReview(reviewTarget ? 'selection' : 'all')}
            title={reviewTarget ? 'Review 当前选区（Ctrl/⌘ + Enter）' : 'Review 整个 MR（Ctrl/⌘ + Enter）'}
          >
            {running ? 'Review 中' : reviewTarget ? 'Review 选区' : '开始 Review'}
          </Btn>
          {running ? (
            <Btn variant="outline" size="sm" icon={<Square size={12} />} onClick={cancelReview}
              style={{ background: 'rgba(255,255,255,0.08)', borderColor: 'rgba(255,255,255,0.16)', color: '#e6ebf2' }}>
              取消
            </Btn>
          ) : (
            <span style={{ fontSize: 11, color: C.headerMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {reviewTarget
                ? selectionLabel(reviewTarget)
                : loading ? '读取中…' : `${files.length} 个变更文件 · ${enabledRuleCount} 条规则`}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {savedSession && savedSession.status !== 'running' && findings.length === 0 && (
            <Btn variant="ghost" size="sm" icon={<History size={13} />} onClick={() => void resumeSession()}
              style={{ color: C.headerMuted }}>恢复</Btn>
          )}
          {(findings.length > 0 || reviewStatus !== 'idle') && (
            <Btn
              variant="ghost" size="sm" icon={<Undo2 size={13} />} disabled={running} onClick={resetReview}
              title="清除本轮结果，回到可以输入 prompt 的初始界面（会话、设置、调试记录都保留）"
              style={{ color: C.headerMuted }}
            >
              重新开始
            </Btn>
          )}
        </div>

        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: 'review', label: '结果', icon: <CheckSquare size={13} />, count: findings.length },
            { value: 'chat', label: '对话', icon: <MessageSquare size={13} />, dot: responding },
            { value: 'repo', label: '索引', icon: <Database size={13} />, dot: repoStatus?.state === 'ready' },
            { value: 'settings', label: '设置', icon: <SettingsIcon size={13} />, dot: (!modelReady && settingsLoaded) || unseenErrors > 0, title: [!modelReady && settingsLoaded ? '模型未配置' : '', unseenErrors > 0 ? `${unseenErrors} 条未读错误日志` : ''].filter(Boolean).join('；') || undefined },
            ...(settings.debugEnabled
              ? [{ value: 'debug' as Tab, label: '调试', icon: <Bug size={13} />, dot: unseenErrors > 0, title: unseenErrors > 0 ? `${unseenErrors} 条未读错误日志` : undefined }]
              : []),
          ]}
        />

        {/* Body */}
        <div style={{ flex: '1 1 0%', minHeight: 0, display: 'flex', flexDirection: 'column', background: C.bg, overflow: 'hidden' }}>
          {tab === 'review' && (
            <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0%', minHeight: 0 }}>
              <div className="ra-scroll" style={{ flexShrink: 0, maxHeight: '45%', overflowY: 'auto', padding: findings.length > 0 ? '8px 10px 0' : 10, display: 'flex', flexDirection: 'column', gap: 7, borderBottom: findings.length > 0 ? 'none' : `1px solid ${C.border}` }}>
                {stages?.model.ran === false && stages.model.error && (
                  <Banner
                    tone="danger"
                    title="AI 评审未运行"
                    action={<Btn size="sm" variant="outline" onClick={() => setTab('settings')}>打开设置</Btn>}
                  >
                    {stages.model.error}
                    <div style={{ marginTop: 4 }}>
                      常见原因：Base URL 路径与服务不一致（OpenAI 兼容通常以 /v1 结尾）、模型名不存在或已卸载、本地服务未启动、本地服务内存不足装不下模型（HTTP 507）。规则检查结果不受影响。
                    </div>
                  </Banner>
                )}
                {loadError && (
                  <Banner tone="danger" title="读取 GitLab 数据失败" onDismiss={() => setLoadError('')}>
                    {loadError}
                    <div style={{ marginTop: 6 }}>
                      <Btn size="sm" variant="outline" onClick={() => location.reload()}>重新加载页面</Btn>
                    </div>
                  </Banner>
                )}
                {!isOnline && (
                  <Banner tone="danger" title="网络已断开">规则检查仍可离线运行，AI 评审和发布需要网络。</Banner>
                )}
                {!modelReady && settingsLoaded && !ui.hintDismissed && (
                  <Banner
                    tone="warning" icon={<ShieldCheck size={14} />} title="未配置模型 API Key"
                    onDismiss={() => persistUi({ ...ui, hintDismissed: true })}
                    action={
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Btn size="sm" variant="primary" icon={<SettingsIcon size={12} />} onClick={() => setTab('settings')}>去配置</Btn>
                        <Btn size="sm" variant="outline" icon={<Play size={12} />} onClick={() => void startReview(reviewTarget ? 'selection' : 'all')}>
                          先跑规则检查
                        </Btn>
                      </div>
                    }
                  >
                    规则检查（{enabledRuleCount} 条）、划词定位、Finding 编辑和复制评论草稿都不需要 API Key，现在就能用。
                    {config.issues.length > 0 && <>缺少：{config.issues.map((issue) => <span key={issue.field} title={issue.hint} style={{ fontWeight: 700 }}> {issue.label}</span>)}。</>}
                  </Banner>
                )}
                {running && (
                  <Banner tone="info" icon={<Loader2 size={14} className="ra-spin" />} title={reviewStatus === 'preparing' ? '准备 Review 上下文…' : 'Review 进行中'}>
                    {settings.reviewMode === 'rules' || !modelReady
                      ? `正在本地执行 ${enabledRuleCount} 条确定性规则…`
                      : '规则检查已完成，模型正在分析变更…'}
                    {(modelThinking || partialModelCount > 0 || modelStream) && (
                      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {modelThinking && (
                          <div>
                            <button type="button" onClick={() => setShowThinking(!showThinking)}
                              style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 11, fontWeight: 600, color: C.textSecondary }}>
                              {showThinking ? '▾ 模型思考过程' : `▸ 模型思考过程（${modelThinking.length} 字）`}
                            </button>
                            {showThinking && (() => {
                              const outline = extractThinkingOutline(modelThinking.slice(-6000));
                              return (
                                <div style={{ ...streamPreStyle, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  {outline.bullets.length > 0 && (
                                    <div>
                                      <div style={{ fontWeight: 700 }}>要点 {outline.bullets.length}</div>
                                      <ul style={{ margin: '4px 0 0', paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                        {outline.bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}
                                      </ul>
                                    </div>
                                  )}
                                  <div>
                                    <div style={{ fontWeight: 700 }}>时间轴 {outline.timeline.length} 段</div>
                                    <ol style={{ margin: '4px 0 0', paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                      {outline.timeline.slice(-8).map((segment, index) => (
                                        <li key={index}>
                                          {segment.kind === 'json' ? `JSON 草稿 ${segment.chars} 字` : segment.kind === 'code' ? `代码块 ${segment.chars} 字` : `推理 ${segment.chars} 字`}
                                          ：{segment.preview}…
                                        </li>
                                      ))}
                                    </ol>
                                  </div>
                                  <button type="button" onClick={() => setShowRawThinking(!showRawThinking)}
                                    style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 11, color: C.textMuted, textDecoration: 'underline', textAlign: 'left' }}>
                                    {showRawThinking ? '收起原文' : '查看原文'}
                                  </button>
                                  {showRawThinking && (
                                    <pre ref={thinkingPreRef} style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                      {modelThinking.length > 1500 ? `…（前 ${modelThinking.length - 1500} 字已省略）\n` : ''}
                                      {compactThinking(modelThinking.slice(-1500))}
                                    </pre>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: C.textSecondary }}>
                          <span>{partialModelCount > 0 ? `AI 已流式产出 ${partialModelCount} 条问题，继续接收中…` : '模型正在分析变更…'}</span>
                          {modelStream && (
                            <button type="button" onClick={() => setShowRaw(!showRaw)}
                              style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 11, color: C.textMuted, textDecoration: 'underline' }}>
                              {showRaw ? '隐藏原始输出' : '查看原始输出'}
                            </button>
                          )}
                        </div>
                        {showRaw && <pre style={streamPreStyle}>{modelStream.slice(-1500)}</pre>}
                      </div>
                    )}
                    <div style={{ marginTop: 6 }}>
                      <Btn size="sm" variant="outline" icon={<Square size={12} />} onClick={cancelReview}>取消</Btn>
                    </div>
                  </Banner>
                )}
                {reviewStatus === 'completed' && !running && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, color: C.textMuted }}>
                    <GitMerge size={12} />
                    {mergeRequestRef && <span>MR !{mergeRequestRef.mergeRequestIid}</span>}
                    {mrContext && <span>head {mrContext.diffRefs.headSha.slice(0, 8)}</span>}
                    {stages && (
                      <>
                        <Pill tone="rule" count={stages.rules.findings}>规则</Pill>
                        {stages.model.ran
                          ? <Pill tone="model" count={stages.model.findings}>AI</Pill>
                          : <Pill tone="warning">AI 未运行</Pill>}
                      </>
                    )}
                    <span style={{ flex: 1 }} />
                    {savedSession && <span>已保存会话</span>}
                    <Btn size="sm" variant="ghost" icon={<History size={12} />} onClick={openViewer}>回放</Btn>
                  </div>
                )}
                {scanMode && !running && (
                  <Banner tone="info" title="扫描模式（全文件规则扫描）">结果没有 diff 位置，发布时会降级为 MR 级全文评论。</Banner>
                )}
                {reviewStatus === 'cancelled' && !reviewError && (
                  <Banner tone="warning" title="已取消">模型分析已停止；已完成的规则结果仍保留并可发布。</Banner>
                )}
                <ReferenceMrPanel
                  references={references}
                  input={referenceInput}
                  onInputChange={setReferenceInput}
                  onAddLinks={addReferenceLinks}
                  onRemove={removeReference}
                  busy={referenceBusy}
                  invalid={referenceInvalid}
                  onDismissInvalid={() => setReferenceInvalid([])}
                  candidates={referenceCandidateList}
                  candidatesLoading={candidateLoading}
                  candidatesError={candidateError}
                  onLoadCandidates={() => void loadReferenceCandidates()}
                  onToggleCandidate={toggleReferenceCandidate}
                  disabled={running}
                />
              </div>

              {findings.length > 0 || reviewError || reviewStatus !== 'idle' ? (
                <FindingsPanel
                  findings={resolvedFindings}
                  running={running}
                  stages={stages}
                  warnings={reviewWarnings}
                  error={reviewError}
                  modelReady={modelReady}
                  rulesOnlyMode={settings.reviewMode === 'rules'}
                  enabledRuleCount={enabledRuleCount}
                  canPublish={canPublish}
                  publishDisabledReason={publishDisabledReason}
                  publishPositionIssue={publishPositionIssue}
                  publishMode={publishMode}
                  publishable={publishable}
                  fixable={fixable}
                  fixDisabledReason={fixDisabledReason}
                  onApplyFix={(finding) => void openApplyFix(finding)}
                  canApprove={Boolean(mergeRequestRef)}
                  quickBusy={quickBusy}
                  onApprove={() => void handleApprove()}
                  onPublishAll={() => void handlePublishAll()}
                  onSummaryComment={() => void handleSummaryComment()}
                  onExportFindings={handleExportFindings}
                  onExportDelegation={handleExportDelegation}
                  canDelegate={files.length > 0}
                  expandedId={expandedFinding}
                  selectedIds={selectedFindings}
                  onToggleExpand={(id) => setExpandedFinding((current) => current === id ? '' : id)}
                  onToggleSelect={toggleFindingSelection}
                  onSelectPublishable={selectAllPublishable}
                  onClearSelection={() => setSelectedFindings(new Set())}
                  onBatchPublish={() => setBatchConfirm(true)}
                  onLocate={locateFinding}
                  onCopy={copyFinding}
                  onPublish={(finding) => { setPublishFinding(finding); setPublishBody(finding.comment); }}
                  onIgnore={(finding) => ignoreFinding(finding.id)}
                  onMarkFixed={(finding) => setFindingStatus(finding.id, 'fixed')}
                  onEdit={editFinding}
                  onOpenSettings={() => setTab('settings')}
                  onDismissError={() => { setReviewError(''); setReviewStatus('idle'); }}
                  onReset={resetReview}
                />
              ) : running ? (
                <div style={{ flex: '1 1 0%', minHeight: 0, display: 'grid', placeItems: 'center', padding: 20 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: C.textMuted, fontSize: 12 }}>
                    <Loader2 size={20} className="ra-spin" style={{ color: C.primary }} />
                    {settings.reviewMode === 'rules' || !modelReady
                      ? `正在本地执行 ${enabledRuleCount} 条规则…`
                      : '规则检查完成，模型正在分析变更…'}
                  </div>
                </div>
              ) : (
                <div className="ra-scroll" style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto', padding: '0 10px 10px' }}>
                  <IdleReview
                    focusTick={promptFocus}
                    projectKey={page.projectPath ?? ''}
                    projectPrompt={(settings.projectPrompts ?? {})[page.projectPath ?? ''] ?? ''}
                    onProjectPromptChange={(value) => commitSettings({ ...settings, projectPrompts: { ...(settings.projectPrompts ?? {}), [page.projectPath ?? '']: value } })}
                    loading={loading}
                    filesCount={files.length}
                    enabledRuleCount={enabledRuleCount}
                    modelReady={modelReady}
                    hasMr={Boolean(mergeRequestRef && mrContext)}
                    savedSession={savedSession}
                    sessionHistory={sessionHistory}
                    showHistory={showHistory}
                    onToggleHistory={() => {
                      const next = !showHistory;
                      setShowHistory(next);
                      if (next && sessionHistory.length === 0) void loadHistory();
                    }}
                    onOpenSession={(session) => {
                      currentSessionRef.current = session;
                      setSavedSession(session);
                      setFindings(resumeReviewSession(session).findings);
                      setReviewWarnings(session.warnings ?? []);
                      setReviewStatus(session.status === 'running' ? 'idle' : session.status);
                      setExpandedFinding('');
                      setShowHistory(false);
                      setToast('已载入历史会话结果');
                    }}
                    onResume={() => void resumeSession()}
                    onStart={() => void startReview(reviewTarget ? 'selection' : 'all')}
                    onOpenSettings={() => setTab('settings')}
                  />
                </div>
              )}
            </div>
          )}

          {tab === 'chat' && (
            <ChatThread
              messages={messages}
              sessions={chatSessions}
              activeSessionId={activeChatId}
              onNewSession={startNewChat}
              onSwitchSession={switchChat}
              onDeleteSession={deleteChat}
              responding={responding}
              draft={draft}
              onDraftChange={setDraft}
              onSend={(text) => void sendMessage(text)}
              onStop={stopChat}
              attachment={attachment}
              onClearAttachment={() => setAttachment(undefined)}
              toolEvents={toolEvents}
              suggestions={suggestions}
              promptHistory={promptHistory}
              onRemovePrompt={(text) => commitPromptHistory(removePromptHistory(promptHistoryRef.current, text))}
              modelPicker={modelReady ? (
                <ModelPicker
                  compact
                  value={settings.model}
                  baseUrl={settings.modelBaseUrl}
                  apiKey={settings.apiKey}
                  onChange={(m) => { setSettings({ ...settings, model: m }); void saveSettings({ ...settings, model: m }); }}
                />
              ) : undefined}
              modelReady={modelReady}
              onOpenSettings={() => setTab('settings')}
            />
          )}

          {tab === 'repo' && repoStatus && repoIndex && (
            <RepoPanel
              status={repoStatus}
              enabled={settings.repoIndex.enabled}
              hasMr={Boolean(mrContext)}
              scanning={scanning}
              onScan={() => void handleScanIndexed()}
              onIndex={() => {
                if (!mrContext) return;
                repoIndex.updateOptions({
                  maxFiles: settings.repoIndex.maxFiles,
                  maxBytes: settings.repoIndex.maxBytes,
                  maxIndexes: settings.repoIndex.maxIndexes,
                });
                setTab('repo');
                void repoIndex.index(api, {
                  ref: mrContext.diffRefs.headSha,
                  label: mrContext.sourceBranch || mrContext.diffRefs.headSha.slice(0, 8),
                  projectPath: page.projectPath,
                });
              }}
              onCancel={() => repoIndex.cancel()}
              onClear={() => { void repoIndex.clear(); setToast('本地索引缓存已全部清除'); }}
              onActivate={(ref) => { void repoIndex.activate(ref); }}
              onRemove={(ref) => { void repoIndex.remove(ref); setToast('该索引已删除'); }}
              maxIndexes={settings.repoIndex.maxIndexes}
              onOpenSettings={() => setTab('settings')}
              onSearch={(query) => repoIndex.search(query)}
              onCallChain={(symbol, depth) => repoIndex.callChain(symbol, depth)}
            />
          )}

          {tab === 'settings' && (
            <div className="ra-scroll" style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto' }}>
              <SettingsView
                settings={settings}
                onSettingsChange={setSettings}
                onSettingsCommit={commitSettings}
                onSave={() => { void saveSettings(settings).then(() => setToast('设置已保存')); }}
                onTestModel={() => void testModelConnection()}
                onClearApiKey={() => {
                  setSettings({ ...settings, apiKey: '' });
                  void clearSensitiveSettings();
                  setToast('密钥已清除');
                }}
                projectKey={page.projectPath ?? ''}
                rulePacks={scopePacks}
                packScope={activePackScope.kind}
                projectLabel={projectKey}
                publicCustomCount={publicPacks.filter((pack) => !pack.builtIn).length}
                onPackScopeChange={(kind) => setPackScopeKind(kind)}
                onToggleRulePack={(id, enabled) => void toggleRulePack(id, enabled)}
                onToggleRule={(packId, ruleId) => void toggleRule(packId, ruleId)}
                onDeleteRulePack={(id) => void deleteRulePack(id)}
                onImportRulePack={handleImportPack}
                onExportRulePack={handleExportPack}
                onUpdateRulePack={(id, patch) => void updatePacks(scopePacks.map((pack) => pack.id === id ? { ...pack, ...patch } : pack))}
                importError={importError}
                usageSummary={usageSummary}
                onClearUsage={() => { void clearUsage().then(() => { setUsageSummary(null); setToast('用量记录已清空'); }); }}
                capabilities={capabilities}
                onProbeCapabilities={() => {
                  void probeCapabilities(page.origin, settings.gitlabToken).then(({ capabilities: caps, diagnostics: diags }) => {
                    setCapabilities(caps);
                    setDiagnostics(diags);
                    setToast('权限检测完成');
                  });
                }}
                onExportSiteConfig={() => {
                  if (!capabilities) { setToast('请先点击「检测权限」，再导出站点配置'); return; }
                  const siteConfig = exportSiteConfig(page, capabilities, { ...settings, apiKey: '', gitlabToken: '' });
                  void navigator.clipboard?.writeText(siteConfig);
                  setToast('站点配置已复制到剪贴板（已剔除密钥）');
                }}
                onNewRulePack={() => void createNewPack()}
                onOpenDebug={() => setTab('debug')}
                testing={testing}
              />
            </div>
          )}

          {tab === 'debug' && (
            <DebugPanel
              diagnostics={diagnostics}
              toolEvents={toolEvents}
              usageSummary={usageSummary}
              reviewStatus={reviewStatus}
              findingsCount={findings.length}
              filesCount={files.length}
              modelConfigured={modelReady}
              mcpEnabled={settings.mcp?.enabled ?? false}
            />
          )}
        </div>
      {viewerOpen && (
        <div role="dialog" aria-label="会话回放" style={{ position: 'absolute', inset: 0, zIndex: 20, background: C.bg, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <History size={14} />
              <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>会话回放</span>
              <span style={{ flex: 1 }} />
              <Btn size="sm" variant="ghost" icon={<X size={13} />} onClick={() => setViewerOpen(false)}>关闭</Btn>
            </div>
            <Select
              value={viewerKey}
              onChange={setViewerKey}
              options={sessionHistory.map((item) => ({
                value: item.key,
                label: `!${item.mergeRequestIid} ${item.title.slice(0, 16)} · ${item.scope === 'selection' ? '选区' : '整个 MR'} · ${new Date(item.updatedAt).toLocaleString('zh-CN')}`,
              }))}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 11, color: C.textMuted }}>只读回放；标记会写回该会话。</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.textSecondary }}>
                <Toggle checked={hideHandled} onChange={setHideHandled} /> 隐藏已处理
              </label>
            </div>
          </div>
          <div className="ra-scroll" style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {viewerFindings.length === 0 && (
              <div style={{ fontSize: 12, color: C.textMuted, textAlign: 'center', padding: 20 }}>
                {hideHandled ? '没有未处理的 Finding（已隐藏已处理项）。' : '该会话没有 Finding。'}
              </div>
            )}
            {viewerFindings.map((finding) => (
              <div key={finding.id} style={{ border: `1px solid ${C.border}`, borderRadius: C.radiusSm, padding: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{finding.title}</div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                  {severityLabel[finding.severity]} · {statusLabel[finding.status]} · {finding.path}:{finding.line}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <Btn size="sm" variant="outline" onClick={() => markViewerFinding(finding.id, 'fixed')}>标记已修复</Btn>
                  <Btn size="sm" variant="ghost" onClick={() => markViewerFinding(finding.id, 'ignored')}>标记忽略</Btn>
                  <Btn size="sm" variant="ghost" onClick={() => markViewerFinding(finding.id, 'draft')}>恢复草稿</Btn>
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: '8px 12px', borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
            <Btn variant="primary" size="sm" icon={<History size={13} />} onClick={() => void restoreViewerSession()}>恢复为当前会话</Btn>
          </div>
        </div>
      )}
      </aside>

      {selection && (
        <SelectionToolbar
          state={selection}
          onAsk={() => {
            setAttachment(selection);
            setSelection(null);
            setTab('chat');
            persistUi({ ...ui, open: true });
            setDraft('请解释这段代码的潜在风险，并给出验证建议。');
          }}
          onReview={() => {
            setAttachment(selection);
            setSelection(null);
            persistUi({ ...ui, open: true });
            void startReview('selection');
          }}
          onCopy={() => {
            void navigator.clipboard?.writeText(selection.text);
            setToast('选中代码已复制');
            setSelection(null);
          }}
          onClose={() => setSelection(null)}
        />
      )}

      {publishFinding && mergeRequestRef && (
        <PublishDialog
          finding={publishPositions.get(publishFinding.id)?.finding ?? publishFinding}
          body={publishBody}
          onBodyChange={setPublishBody}
          publishing={publishing}
          mode={publishMode(publishFinding)}
          positionIssue={publishPositionIssue(publishFinding)}
          blockReason={publishDisabledReason}
          meta={{ projectPath: page.projectPath, mergeRequestIid: mergeRequestRef.mergeRequestIid, headSha: mrContext?.diffRefs.headSha }}
          onCancel={() => setPublishFinding(undefined)}
          onConfirm={() => void confirmPublish()}
        />
      )}

      {batchConfirm && (
        <BatchPublishDialog
          findings={publishableSelected}
          publishing={batchPublishing}
          publishMode={publishMode}
          skipped={selectedFindings.size - publishableSelected.length}
          blockReason={publishDisabledReason}
          meta={{ projectPath: page.projectPath, mergeRequestIid: mergeRequestRef?.mergeRequestIid, headSha: mrContext?.diffRefs.headSha }}
          onCancel={() => setBatchConfirm(false)}
          onConfirm={() => void batchConfirmPublish()}
        />
      )}

      {fixTarget && mergeRequestRef && (
        <FixDialog
          finding={fixTarget}
          plan={fixPlan}
          stage={fixStage}
          error={fixError}
          meta={{
            projectPath: page.projectPath,
            mergeRequestIid: mergeRequestRef.mergeRequestIid,
            branch: fixPlan?.branch ?? mrContext?.sourceBranch ?? '',
          }}
          onCancel={closeFixDialog}
          onRetry={() => void openApplyFix(fixTarget)}
          onConfirm={() => void confirmApplyFix()}
        />
      )}

      {toast && (
        <div role="status" style={{
          position: 'fixed', zIndex: 2147483200, right: 18, bottom: 18, maxWidth: 360,
          display: 'flex', alignItems: 'center', gap: 8, padding: '9px 13px', borderRadius: C.radius,
          background: '#1e2536', color: '#f0f4f8', fontSize: 12, lineHeight: 1.5,
          boxShadow: '0 8px 24px rgba(15,23,42,0.3)',
        }}>{toast}</div>
      )}
    </div>
  );

}

function IdleReview({ loading, filesCount, enabledRuleCount, modelReady, hasMr, savedSession, sessionHistory, showHistory, onToggleHistory, onOpenSession, onResume, onStart, onOpenSettings, projectKey, projectPrompt, onProjectPromptChange, focusTick }: {
  loading: boolean; filesCount: number; enabledRuleCount: number; modelReady: boolean; hasMr: boolean;
  projectKey: string;
  /** 大于 0 说明这次是复位回来的：把焦点交回 prompt 输入框，首次挂载不打断用户在页面上的操作。 */
  focusTick: number;
  projectPrompt: string;
  onProjectPromptChange: (value: string) => void;
  savedSession?: ReviewSessionManifest;
  sessionHistory: ReviewSessionManifest[];
  showHistory: boolean;
  onToggleHistory: () => void;
  onOpenSession: (session: ReviewSessionManifest) => void;
  onResume: () => void;
  onStart: () => void;
  onOpenSettings: () => void;
}) {
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusTick > 0) promptRef.current?.focus();
  }, [focusTick]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{
        padding: '14px 14px 16px', borderRadius: C.radiusLg, border: `1px solid ${C.border}`,
        background: `linear-gradient(180deg, ${C.bgSubtle} 0%, ${C.bg} 100%)`, textAlign: 'center',
      }}>
        <div style={{ display: 'grid', placeItems: 'center', width: 38, height: 38, borderRadius: 19, margin: '0 auto 9px', background: C.primaryLight, color: C.primary }}>
          <ShieldCheck size={19} />
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
          {loading ? '正在读取 MR 数据…' : hasMr ? '开始一次混合评审' : '当前页面没有可用的 MR Diff'}
        </div>
        <div style={{ marginTop: 5, fontSize: 12, color: C.textSecondary, lineHeight: 1.65 }}>
          {loading
            ? '正在通过 GitLab REST API 拉取变更文件和 Diff Refs。'
            : hasMr
              ? <>
                {filesCount} 个变更文件已就绪。规则检查在浏览器本地执行（{enabledRuleCount} 条规则，零 token），
                {modelReady ? 'AI 评审会补充语义层面的问题，两类结果分开标注。' : '配置 API Key 后可叠加 AI 深度评审。'}
              </>
              : <>在 MR 的 Changes 页面打开侧栏即可评审整个 MR；也可以先划选一段代码，再针对选区提问或 Review。</>}
        </div>
        {hasMr && projectKey && (
          <div style={{ marginTop: 10, textAlign: 'left' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: C.textSecondary }}>
              项目补充要求（按 {projectKey} 记住，注入混合评审 system prompt）
            </div>
            <textarea
              ref={promptRef}
              aria-label="项目补充要求"
              autoComplete="off"
              value={projectPrompt}
              onChange={(e) => onProjectPromptChange(e.target.value)}
              placeholder="可选：本项目评审的额外约束，例如「金额计算必须用 decimal」「不要评论命名风格」。"
              style={{
                marginTop: 4, width: '100%', minHeight: 64, resize: 'vertical', padding: 7,
                borderRadius: C.radiusSm, border: `1px solid ${C.border}`, fontSize: 12, lineHeight: 1.6,
                fontFamily: 'inherit', color: C.text, background: C.bg, outline: 'none',
              }}
            />
          </div>
        )}
        <div style={{ display: 'flex', gap: 7, justifyContent: 'center', marginTop: 11, flexWrap: 'wrap' }}>
          <Btn variant="primary" icon={<Play size={13} />} disabled={loading || (!hasMr && filesCount === 0)} onClick={onStart}>
            {modelReady ? '运行混合评审' : '运行规则检查'}
          </Btn>
          {!modelReady && (
            <Btn variant="outline" icon={<SettingsIcon size={13} />} onClick={onOpenSettings}>配置模型</Btn>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          <FileText size={12} />评审流程
        </div>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: C.textSecondary, lineHeight: 1.8 }}>
          <li>确定性规则先跑，命中结果标注为「规则」。</li>
          <li>{modelReady ? '模型再评审同一批 Diff，结果标注为「AI」。' : '配置模型后，AI 会评审同一批 Diff，结果标注为「AI」。'}</li>
          <li>两个来源命中同一处问题时自动合并，标注「规则 + AI」。</li>
          <li>逐条定位、编辑或忽略，确认后发布为 GitLab 行内评论；没有可用行号时降级为全文评论。</li>
        </ol>
      </div>

      {savedSession && (
        <Banner tone="info" icon={<History size={14} />} title="检测到本 MR 的历史 Review 会话"
          action={<Btn size="sm" variant="outline" onClick={onResume}>恢复上次结果</Btn>}>
          {new Date(savedSession.updatedAt).toLocaleString('zh-CN')} · {savedSession.findings.length} 个问题 · {savedSession.scope === 'selection' ? '选区' : '整个 MR'}
        </Banner>
      )}

      <div>
        <button type="button" onClick={onToggleHistory} style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, border: 0, background: 'transparent',
          cursor: 'pointer', padding: 0, fontSize: 11, fontWeight: 700, color: C.textMuted,
        }}>
          <History size={12} />{showHistory ? '收起历史会话' : '查看历史会话'}
        </button>
        {showHistory && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {sessionHistory.length === 0
              ? <div style={{ fontSize: 11, color: C.textMuted }}>暂无历史会话。</div>
              : sessionHistory.map((session) => (
                <SessionRow key={session.id} session={session} onOpen={() => onOpenSession(session)} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionRow({ session, onOpen }: { session: ReviewSessionManifest; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} title="载入这次会话的 Finding" style={{
      display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px', width: '100%',
      border: `1px solid ${C.border}`, borderRadius: C.radiusSm, background: C.bgSubtle,
      cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary }}>!{session.mergeRequestIid}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: C.textMuted }}>
        {session.projectPath.replace(/^.*\//, '')} · {session.scope === 'selection' ? '选区' : '整个 MR'} · {session.findings.length} 个问题
      </span>
      <span style={{ fontSize: 10, color: C.textMuted, flexShrink: 0 }}>
        {new Date(session.updatedAt).toLocaleDateString('zh-CN')}
      </span>
    </button>
  );
}
