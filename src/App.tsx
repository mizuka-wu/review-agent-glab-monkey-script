import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Bug, Check, Download, ExternalLink, FileText, LoaderCircle, MessageSquare, Package,
  Play, Plus, RefreshCw, Send, Settings, Sparkles, Square, Trash2, Upload, X,
} from 'lucide-react';
import { Button } from './components/ui/button';
import { FindingCard } from './components/review/FindingCard';
import { ChatThread } from './components/ChatThread';
import { SelectionToolbar } from './components/review/SelectionToolbar';
import { SettingsView } from './components/SettingsView';
import { DebugPanel, type DebugLogEntry } from './components/DebugPanel';
import { Markdown } from './components/Markdown';
import { highlightFindingOnPage, clearHighlights, injectHighlightStyles } from './core/finding-highlight';
import { applyFindingEdit, type FindingEdit } from './core/finding-edit';
import { GitLabAdapter, GitLabApiError, mergeRequestRefFromPage } from './core/gitlab-adapter';
import { createModelRuntime, type ModelRuntime, type AgentMessage } from './core/model-runtime';
import { runAgentLoop, type AgentLoopEvent } from './core/agent-loop';
import { CompositeToolExecutor, GitLabToolExecutor } from './core/agent-tools';
import { McpClient } from './core/mcp-client';
import { probeCapabilities, exportSiteConfig, type ExtendedCapabilities, type DiagnosticEntry } from './core/capabilities';
import { providerPresets } from './core/settings';
import { getUsageSummary, clearUsage, formatTokenCount, formatCost, type UsageSummary } from './core/usage';
import { ReviewEngine } from './core/review-engine';
import {
  addRulePack,
  BUILT_IN_PACK,
  exportRulePack,
  generateRuleId,
  generateRulePackId,
  importRulePack,
  loadRulePacks,
  removeRulePack,
  saveRulePacks,
  type RuleDef,
  type RulePack,
} from './core/rule-packs';
import {
  createReviewSession,
  loadLatestReviewSession,
  resumeReviewSession,
  reviewSessionKey,
  saveReviewSession,
  summarizeReviewContext,
  toSessionFinding,
  updateReviewSession,
  type ReviewSessionManifest,
} from './core/session';
import { captureCodeSelection } from './core/selection';
import { clearSensitiveSettings, defaultSettings, loadSettings, saveSettings } from './core/settings';
import type {
  ChatMessage, CodeSelection, FileDiff, Finding, MergeRequestContext,
  PageContext, RuntimeSettings,
} from './core/types';

type ReviewStatus = 'idle' | 'preparing' | 'running' | 'normalizing' | 'completed' | 'cancelled' | 'failed';

interface AppProps {
  page: PageContext;
  adapter: GitLabAdapter;
}

const suggestions = ['解释这段变更的失败路径', '检查并发与幂等性', '补充可执行的测试建议'];
const CHAT_STORAGE_KEY = 'review-agent-chat-v1';

export default function App({ page, adapter }: AppProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const reviewAbort = useRef<AbortController | undefined>(undefined);
  const currentSessionRef = useRef<ReviewSessionManifest | undefined>(undefined);
  const [settings, setSettings] = useState<RuntimeSettings>(defaultSettings);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [attachment, setAttachment] = useState<CodeSelection | undefined>(undefined);
  const [selection, setSelection] = useState<CodeSelection | null>(null);
  const [responding, setResponding] = useState(false);
  const [mrContext, setMrContext] = useState<MergeRequestContext | undefined>(undefined);
  const [files, setFiles] = useState<FileDiff[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [activeTab, setActiveTab] = useState<'chat' | 'config' | 'debug'>('chat');
  const [panelOpen, setPanelOpen] = useState(false);
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>('idle');
  const [reviewError, setReviewError] = useState('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [expandedFinding, setExpandedFinding] = useState('');
  const [publishFinding, setPublishFinding] = useState<Finding | undefined>(undefined);
  const [publishBody, setPublishBody] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [savedSession, setSavedSession] = useState<ReviewSessionManifest | undefined>(undefined);
  const [toast, setToast] = useState('');
  const [rulePacks, setRulePacks] = useState<RulePack[]>([BUILT_IN_PACK]);
  const [editingPackId, setEditingPackId] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [toolEvents, setToolEvents] = useState<AgentLoopEvent[]>([]);
  const [capabilities, setCapabilities] = useState<ExtendedCapabilities | undefined>(undefined);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
  const [visibleFindingCount, setVisibleFindingCount] = useState(20);
  const [diffLoadProgress, setDiffLoadProgress] = useState<{ loaded: number; hasMore: boolean } | null>(null);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [selectedFindings, setSelectedFindings] = useState<Set<string>>(new Set());
  const [batchPublishing, setBatchPublishing] = useState(false);
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);
  const [filterSeverity, setFilterSeverity] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'severity' | 'line' | 'path'>('severity');
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [sessionHistory, setSessionHistory] = useState<ReviewSessionManifest[]>([]);
  const [showFindings, setShowFindings] = useState(true);
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);
  const [debugFilter, setDebugFilter] = useState<'all' | 'info' | 'warn' | 'error' | 'debug'>('all');

  // Panel drag state
  const addLog = (level: DebugLogEntry['level'], source: string, message: string, detail?: string) => {
    setDebugLogs(prev => [...prev.slice(-499), {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      level, source, message, detail,
    }]);
  };
  const panelRef = useRef<HTMLElement>(null);
  const dragState = useRef<{ startX: number; startY: number; startTop: number; startRight: number } | null>(null);

  const handleDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTop: rect.top,
      startRight: window.innerWidth - rect.right,
    };
    const onMove = (me: MouseEvent) => {
      const ds = dragState.current;
      if (!ds) return;
      const dx = me.clientX - ds.startX;
      const dy = me.clientY - ds.startY;
      panel.style.top = `${Math.max(0, ds.startTop + dy)}px`;
      panel.style.right = `${Math.max(0, ds.startRight - dx)}px`;
    };
    const onUp = () => {
      dragState.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Keep panel in viewport on window resize
  useEffect(() => {
    const onResize = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        panel.style.right = '16px';
        panel.style.top = '72px';
      }
      if (rect.bottom > window.innerHeight) {
        panel.style.top = `${Math.max(0, window.innerHeight - rect.height - 16)}px`;
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    // Restore chat history
    try {
      const stored = localStorage.getItem(CHAT_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as ChatMessage[];
        if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed.slice(-50));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    // Save chat history when messages change
    if (messages.length > 0) {
      try {
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-50)));
      } catch { /* ignore */ }
    }
  }, [messages]);

  const runtime: ModelRuntime = useMemo(() => createModelRuntime(settings), [settings]);
  const reviewEngine = useMemo(() => new ReviewEngine(runtime, settings, rulePacks), [runtime, settings, rulePacks]);
  const mergeRequestRef = useMemo(() => mergeRequestRefFromPage(page), [page]);
  const runtimeConfigured = runtime.configured;

  // Filter and sort findings
  const filteredFindings = useMemo(() => {
    let result = [...findings];
    if (filterSeverity !== 'all') result = result.filter((f) => f.severity === filterSeverity);
    if (filterCategory !== 'all') result = result.filter((f) => f.category === filterCategory);
    if (filterStatus !== 'all') result = result.filter((f) => f.status === filterStatus);

    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    result.sort((a, b) => {
      if (sortBy === 'severity') return severityOrder[a.severity] - severityOrder[b.severity];
      if (sortBy === 'line') return a.line - b.line;
      return (a.path ?? '').localeCompare(b.path ?? '');
    });
    return result;
  }, [findings, filterSeverity, filterCategory, filterStatus, sortBy]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (publishFinding) setPublishFinding(undefined);
        else if (showBatchConfirm) setShowBatchConfirm(false);
        else if (editingPackId) setEditingPackId(null);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!reviewStatus || reviewStatus === 'idle' || reviewStatus === 'cancelled' || reviewStatus === 'failed') {
          void startReview(attachment ? 'selection' : 'all');
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setActiveTab((current) => current === 'chat' ? 'config' : 'chat');
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [publishFinding, showBatchConfirm, editingPackId, reviewStatus, attachment]);

  // Online/offline detection
  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    let active = true;
    void loadSettings().then((loaded) => {
      if (active) setSettings(loaded);
    });
    void loadRulePacks().then((loaded) => {
      if (active) setRulePacks(loaded);
    });
    void getUsageSummary().then((summary) => {
      if (active && summary.callCount > 0) setUsageSummary(summary);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    if (!mergeRequestRef) {
      setLoading(false);
      return () => controller.abort();
    }
    void Promise.all([
      mergeRequestRef ? adapter.getMergeRequest(mergeRequestRef) : Promise.resolve(undefined),
      page.route === 'commit' && page.commitSha
        ? adapter.listCommitDiffs(page.commitSha)
        : mergeRequestRef
          ? adapter.listDiffs(mergeRequestRef, { onPage: (loaded, hasMore) => setDiffLoadProgress({ loaded, hasMore }) })
          : Promise.resolve([]),
    ]).then(([context, diffs]) => {
      if (controller.signal.aborted) return;
      setDiffLoadProgress(null);
      setMrContext(context);
      setFiles(diffs);
      setLoading(false);
      if (mergeRequestRef && context) {
        void loadLatestReviewSession(reviewSessionKey(mergeRequestRef, context.diffRefs.headSha))
          .then((session) => {
            if (!controller.signal.aborted) setSavedSession(session);
          });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [adapter, mergeRequestRef]);

  useEffect(() => {
    const handleMouseUp = () => {
      window.setTimeout(() => {
        const selected = captureCodeSelection(document, page.filePath ?? '');
        const anchor = document.getSelection()?.anchorNode ?? null;
        if (!selected || (anchor && hostRef.current?.contains(anchor))) return;
        setSelection(selected);
      }, 0);
    };
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [page.filePath]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Probe GitLab capabilities once page context is available (debounced)
  useEffect(() => {
    if (!page.origin) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void probeCapabilities(page.origin, settings.gitlabToken).then(({ capabilities: caps, diagnostics: diags }) => {
        if (active) {
          setCapabilities(caps);
          setDiagnostics(diags);
        }
      }).catch(() => {});
    }, 500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [page.origin, settings.gitlabToken]);

  // Load session history for the session browser
  useEffect(() => {
    if (activeTab !== 'settings') return;
    let active = true;
    void (async () => {
      const storage = (globalThis as typeof globalThis & { GM?: { getValue: (k: string, fb: unknown) => Promise<unknown> } }).GM;
      const raw = storage
        ? await storage.getValue('review-agent-review-sessions-v1', {})
        : JSON.parse(localStorage.getItem('review-agent-review-sessions-v1') ?? '{}');
      const sessions = Object.values(raw ?? {}) as ReviewSessionManifest[];
      if (active) setSessionHistory(sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 10));
    })();
    return () => { active = false; };
  }, [activeTab]);

  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || responding) return;
    const userMessage: ChatMessage = { id: `user-${Date.now()}`, role: 'user', content, attachment };
    const history = [...messages, userMessage];
    setMessages(history);
    setDraft('');
    setAttachment(undefined);
    if (!runtimeConfigured) {
      setMessages([...history, {
        id: `error-${Date.now()}`, role: 'assistant', error: true,
        content: '尚未配置可用的 OpenAI-compatible 模型。请在“设置”中填写 Base URL、模型和 API Key。',
      }]);
      setActiveTab('config');
      return;
    }
    setResponding(true);
    setToolEvents([]);
    try {
      if (mergeRequestRef && mrContext) {
        // Use agent loop with GitLab + MCP tools when on an MR page
        const gitlabExecutor = new GitLabToolExecutor(adapter, mrContext.diffRefs.headSha);
        let compositeExecutor = new CompositeToolExecutor(gitlabExecutor);

        // Initialize MCP client if enabled
        if (settings.mcp?.enabled && settings.mcp.serverUrl) {
          try {
            const mcpClient = new McpClient({ url: settings.mcp.serverUrl, enabled: true });
            await mcpClient.initialize();
            if (mcpClient.availableTools.length > 0) {
              compositeExecutor = new CompositeToolExecutor(gitlabExecutor, mcpClient);
            }
          } catch (mcpError) {
            console.warn('MCP 连接失败，仅使用 GitLab 工具:', mcpError);
          }
        }

        const agentMessages: AgentMessage[] = [
          ...history.filter((m) => m.role !== 'system' && !m.error).map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.attachment
              ? `${m.content}\n\n[代码选区: ${m.attachment.filePath}:L${m.attachment.startLine}-${m.attachment.endLine}]\n\`\`\`\n${m.attachment.text}\n\`\`\``
              : m.content,
          })),
        ];
        const result = await runAgentLoop(runtime, compositeExecutor, agentMessages, {
          onEvent: (event) => setToolEvents((prev) => [...prev, event]),
          language: settings.language,
        });
        setMessages((current) => [...current, {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: result.text + (result.toolCalls.length > 0
            ? `\n\n---\n🔧 调用了 ${result.toolCalls.length} 次工具，${result.iterations} 轮推理`
            : ''),
        }]);
      } else {
        // Stream tokens to UI progressively
        const streamId = `stream-${Date.now()}`;
        setMessages((current) => [...current, { id: streamId, role: 'assistant', content: '' }]);
        let streamed = '';
        const answer = await runtime.chat(history, attachment, undefined, (token) => {
          streamed += token;
          setMessages((current) => current.map((m) => m.id === streamId ? { ...m, content: streamed } : m));
        });
        setMessages((current) => current.map((m) => m.id === streamId ? { ...m, content: answer } : m));
      }
    } catch (error) {
      setMessages((current) => [...current, {
        id: `error-${Date.now()}`, role: 'assistant', error: true,
        content: `模型调用失败：${String(error)}`,
      }]);
    } finally {
      setResponding(false);
    }
  };

  const startReview = async (scope: 'all' | 'selection') => {
    if (!runtimeConfigured) {
      setToast('请先在设置中配置模型（API Key）');
      setActiveTab('config');
      return;
    }
    reviewAbort.current?.abort();
    const controller = new AbortController();
    reviewAbort.current = controller;
    setActiveTab('chat');
    setReviewStatus('preparing');
    setReviewError('');
    setFindings([]);
    const selected = attachment ?? selection ?? undefined;
    const scopedFiles = scope === 'selection'
      ? files.filter((file) => file.newPath === selected?.filePath)
      : files;
    const session = mergeRequestRef && mrContext
      ? createReviewSession({
        ref: mergeRequestRef,
        headSha: mrContext.diffRefs.headSha,
        title: mrContext.title,
        scope,
        source: 'model',
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
      const result = await reviewEngine.run({
        files: scopedFiles,
        selection: selected,
        signal: controller.signal,
        loadFile: (path, ref, signal) => adapter.getFile(path, ref),
        fullFileRef: mrContext?.diffRefs.headSha ?? page.commitSha,
      });
      if (controller.signal.aborted) return;
      // Sync with existing GitLab discussions to mark already-published findings
      let syncedFindings = result.findings;
      if (mergeRequestRef) {
        try {
          const existingBodies = await adapter.getExistingCommentBodies(mergeRequestRef);
          if (existingBodies.size > 0) {
            syncedFindings = result.findings.map((finding) => {
              const alreadyPublished = existingBodies.has(finding.comment.trim());
              return alreadyPublished ? { ...finding, status: 'published' as const } : finding;
            });
            const syncedCount = syncedFindings.filter((f) => f.status === 'published').length;
            if (syncedCount > 0) {
              setToast(`${syncedCount} 个 Finding 匹配到已有 Discussion，已标记为已发布`);
            }
          }
        } catch {
          // Discussion sync is best-effort, don't block review results
        }
      }

      setFindings(syncedFindings);
      setExpandedFinding(result.findings[0]?.id ?? '');
      setReviewStatus('completed');
      if (session) {
        const completed = updateReviewSession(session, {
          status: 'completed',
          source: result.source,
          findings: result.findings.map(toSessionFinding),
          warnings: result.warnings,
          context: summarizeReviewContext(result.context),
        });
        currentSessionRef.current = completed;
        setSavedSession(completed);
        void saveReviewSession(completed);
      }
      if (result.warnings.length > 0) setToast(result.warnings[0]);
    } catch (error) {
      if (controller.signal.aborted || (error as Error).name === 'AbortError') return;
      const message = error instanceof Error ? error.message : String(error);
      setReviewError(message);
      setReviewStatus('failed');
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
    setReviewError('运行已取消。未完成结果不会进入发布队列。');
    const session = currentSessionRef.current;
    if (session) {
      const cancelled = updateReviewSession(session, {
        status: 'cancelled',
        error: '运行已取消。未完成结果不会进入发布队列。',
      });
      currentSessionRef.current = cancelled;
      setSavedSession(cancelled);
      void saveReviewSession(cancelled);
    }
  };

  const persistFindings = (next: Finding[]) => {
    const session = currentSessionRef.current;
    if (!session) return;
    const updated = updateReviewSession(session, { findings: next.map(toSessionFinding) });
    currentSessionRef.current = updated;
    setSavedSession(updated);
    void saveReviewSession(updated);
  };

  const editFinding = (id: string, edit: FindingEdit) => {
    const next = findings.map((finding) => finding.id === id ? applyFindingEdit(finding, edit) : finding);
    setFindings(next);
    persistFindings(next);
    setToast('Finding 修改已保存');
  };

  const ignoreFinding = (id: string) => {
    const next = findings.map((item) => item.id === id ? { ...item, status: 'ignored' as const } : item);
    setFindings(next);
    persistFindings(next);
  };

  const resumeSession = async () => {
    if (!savedSession) return;
    const resumed = resumeReviewSession(savedSession);
    currentSessionRef.current = resumed.session;
    setSavedSession(resumed.session);
    setFindings(resumed.findings);
    setExpandedFinding(resumed.findings[0]?.id ?? '');
    setReviewStatus(resumed.status);
    setReviewError(resumed.error ?? '');
    await saveReviewSession(resumed.session);
    setToast('已恢复上次 Review 会话');
  };

  // --- Rule Pack Management ---

  const toggleRulePack = async (packId: string) => {
    const next = rulePacks.map((pack) => pack.id === packId ? { ...pack, enabled: !pack.enabled } : pack);
    setRulePacks(next);
    await saveRulePacks(next);
    setToast('规则包状态已更新');
  };

  const toggleRule = async (packId: string, ruleId: string) => {
    const next = rulePacks.map((pack) => {
      if (pack.id !== packId) return pack;
      return {
        ...pack,
        rules: pack.rules.map((rule) => rule.id === ruleId ? { ...rule, enabled: !rule.enabled } : rule),
      };
    });
    setRulePacks(next);
    await saveRulePacks(next);
  };

  const deleteRulePack = async (packId: string) => {
    const next = await removeRulePack(packId);
    setRulePacks(next);
    if (editingPackId === packId) setEditingPackId(null);
    setToast('规则包已删除');
  };

  const createNewPack = async () => {
    const newPack: RulePack = {
      id: generateRulePackId(),
      name: '自定义规则包',
      version: '1.0.0',
      description: '',
      enabled: true,
      builtIn: false,
      rules: [],
    };
    const next = await addRulePack(newPack);
    setRulePacks(next);
    setEditingPackId(newPack.id);
    setToast('已创建新规则包');
  };

  const updatePack = async (updated: RulePack) => {
    const next = rulePacks.map((pack) => pack.id === updated.id ? updated : pack);
    setRulePacks(next);
    await saveRulePacks(next);
  };

  const addRuleToPack = async (packId: string) => {
    const newRule: RuleDef = {
      id: generateRuleId(),
      enabled: true,
      severity: 'medium',
      category: 'maintainability',
      title: '新规则',
      content: '',
      matchPatterns: [{ type: 'regex', pattern: '' }],
    };
    const next = rulePacks.map((pack) => {
      if (pack.id !== packId) return pack;
      return { ...pack, rules: [...pack.rules, newRule] };
    });
    setRulePacks(next);
    await saveRulePacks(next);
  };

  const removeRuleFromPack = async (packId: string, ruleId: string) => {
    const next = rulePacks.map((pack) => {
      if (pack.id !== packId) return pack;
      return { ...pack, rules: pack.rules.filter((rule) => rule.id !== ruleId) };
    });
    setRulePacks(next);
    await saveRulePacks(next);
  };

  const handleImportPack = async () => {
    setImportError('');
    const result = importRulePack(importText);
    if (result.errors.length > 0) {
      setImportError(result.errors.join('; '));
      return;
    }
    if (result.pack) {
      const next = await addRulePack(result.pack);
      setRulePacks(next);
      setImportText('');
      setEditingPackId(result.pack.id);
      setToast('规则包已导入');
    }
  };

  const handleExportPack = (pack: RulePack) => {
    const json = exportRulePack(pack);
    void navigator.clipboard?.writeText(json);
    setToast('规则包 JSON 已复制到剪贴板');
  };

  const editingPack = rulePacks.find((pack) => pack.id === editingPackId);

  const locateFinding = (finding: Finding) => {
    injectHighlightStyles();
    const highlighted = highlightFindingOnPage(finding);
    setToast(highlighted.length > 0
      ? `已高亮定位 ${finding.path}:${finding.line}（${highlighted.length} 行）`
      : '当前页面找不到对应 Diff 行');
  };

  // --- Batch publish ---

  const toggleFindingSelection = (id: string) => {
    setSelectedFindings((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllPublishable = () => {
    const publishable = findings.filter((f) => f.status === 'draft' && f.anchor?.publishable !== false);
    setSelectedFindings(new Set(publishable.map((f) => f.id)));
  };

  const clearSelection = () => setSelectedFindings(new Set());

  const batchConfirmPublish = async () => {
    const toPublish = findings.filter((f) => selectedFindings.has(f.id) && f.status === 'draft');
    if (toPublish.length === 0 || !mergeRequestRef || !mrContext) return;

    setBatchPublishing(true);
    let successCount = 0;
    let failCount = 0;
    const succeededIds = new Set<string>();

    for (const finding of toPublish) {
      try {
        await adapter.createDiscussion(mergeRequestRef, {
          body: finding.comment,
          path: finding.path,
          oldPath: finding.oldPath ?? finding.path,
          newPath: finding.newPath ?? finding.path,
          startLine: finding.line,
          endLine: finding.endLine,
          side: finding.side,
          newFile: finding.newFile,
          deletedFile: finding.deletedFile,
          diffRefs: mrContext.diffRefs,
        });
        successCount += 1;
        succeededIds.add(finding.id);
      } catch {
        failCount += 1;
      }
    }

    const next = findings.map((f) =>
      succeededIds.has(f.id) ? { ...f, status: 'published' as const } : f,
    );
    setFindings(next);
    persistFindings(next);
    setSelectedFindings(new Set());
    setShowBatchConfirm(false);
    setToast(`批量发布完成：${successCount} 成功${failCount > 0 ? `，${failCount} 失败` : ''}`);
    setBatchPublishing(false);
  };

  const confirmPublish = async () => {
    if (!publishFinding || !mergeRequestRef || !mrContext) return;
    setPublishing(true);
    try {
      await adapter.createDiscussion(mergeRequestRef, {
        body: publishBody,
        path: publishFinding.path,
        oldPath: publishFinding.oldPath ?? publishFinding.path,
        newPath: publishFinding.newPath ?? publishFinding.path,
        startLine: publishFinding.line,
        endLine: publishFinding.endLine,
        side: publishFinding.side,
        newFile: publishFinding.newFile,
        deletedFile: publishFinding.deletedFile,
        diffRefs: mrContext.diffRefs,
      });
      const next = findings.map((finding) =>
        finding.id === publishFinding.id ? { ...finding, status: 'published' } : finding,
      );
      setFindings(next);
      persistFindings(next);
      setPublishFinding(undefined);
      setToast('行级 Discussion 已发布');
    } catch (error) {
      const code = error instanceof GitLabApiError ? `${error.code}: ` : '';
      setToast(`发布失败 ${code}${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPublishing(false);
    }
  };

  const compactSelect: React.CSSProperties = {
    padding: '4px 8px', borderRadius: 6, border: '1px solid #d4dae3',
    fontSize: 11, color: '#2d3748', background: '#ffffff', cursor: 'pointer',
  };

  return (
    <div ref={hostRef} className="relative">
      {!panelOpen && (
        <button type="button" onClick={() => setPanelOpen(true)} aria-label="打开 Review Agent"
          className="fixed bottom-[18px] right-[18px] z-[2147483000] grid h-11 w-11 place-items-center rounded-full -foreground shadow-lg cursor-pointer border-0" style={{ color: "#245fc7", background: "#245fc7" }}>
          <span style={{ color: '#fff', fontSize: 22, lineHeight: 1 }}>✦</span>
        </button>
      )}
      <aside ref={panelRef} aria-label="Review Agent"
        className={`fixed z-[2147483000] rounded-lg shadow-2xl overflow-hidden flex flex-col ${panelOpen ? '' : 'hidden'}`}
        style={{ background: '#ffffff', border: '1px solid #d4dae3', top: '72px', right: '16px', width: '460px', height: 'calc(100vh - 88px)', resize: 'horizontal', minWidth: 320 }}>
        {/* Header */}
        <div onMouseDown={handleDragStart} className="flex items-center justify-between px-4 pt-4 pb-3 cursor-grab active:cursor-grabbing select-none" style={{ background: '#1e2536', color: '#f0f4f8' }}>
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold m-0" style={{ color: '#f0f4f8' }}>✦ Review Agent</h2>
            <p className="text-xs opacity-70 mt-1 truncate" style={{ color: '#c0c8d4' }}>{loading ? '正在读取 GitLab API…' : mrContext ? `${mrContext.title.slice(0, 42)} · !${page.mergeRequestIid}` : page.filePath || 'GitLab 页面'}</p>
          </div>
          <button type="button" onClick={() => { clearHighlights(); setPanelOpen(false); }} aria-label="关闭侧栏"
            className="grid h-8 w-8 place-items-center rounded-md hover:bg-white/10 border-0 bg-transparent cursor-pointer" style={{ color: '#c0c8d4' }}>
            <X size={16} />
          </button>
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-2 border-t border-white/10 px-3 py-2" style={{ background: '#1e2536' }}>
          <button type="button" onClick={() => void startReview(attachment ? 'selection' : 'all')}
            disabled={files.length === 0 && !attachment && !selection}
            className="flex items-center gap-1.5 min-h-[32px] px-3 rounded-md text-xs font-semibold border-0 cursor-pointer disabled:opacity-40"
            style={{ background: '#245fc7', color: '#fff' }}>
            <Play size={13} />开始 Review
            {findings.length > 0 && <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full text-[9px] font-bold" style={{ background: 'rgba(255,255,255,0.25)' }}>{findings.length}</span>}
          </button>
          <div className="flex-1" />
          <button type="button" onClick={() => setActiveTab(activeTab === 'debug' ? 'chat' : 'debug')} aria-label="调试"
            className="relative grid h-8 w-8 place-items-center rounded-md hover:bg-white/10 border-0 cursor-pointer"
            style={{ color: activeTab === 'debug' ? '#ffffff' : '#a0aec0' }}>
            <Bug size={15} />
            {debugLogs.filter(l => l.level === 'error').length > 0 && (
              <span style={{ position: 'absolute', top: 2, right: 2, width: 7, height: 7, borderRadius: '50%', background: '#d3453b' }} />
            )}
          </button>
          <button type="button" onClick={() => setActiveTab(activeTab === 'config' ? 'chat' : 'config')} aria-label="配置"
            className="grid h-8 w-8 place-items-center rounded-md hover:bg-white/10 border-0 cursor-pointer"
            style={{ color: activeTab === 'config' ? '#ffffff' : '#a0aec0' }}>
            <Settings size={15} />
          </button>
        </div>

        {/* Body */}
        <div style={{ background: '#ffffff', overflow: 'hidden', flex: '1 1 0%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {loadError && (
            <div className="flex items-center justify-between gap-2 m-4 p-2.5 rounded-md border border-destructive/20 text-xs" style={{ color: "#d3453b", background: "rgba(211,69,59,0.1)" }} role="alert">
              {loadError}
              <Button variant="outline" size="xs" onClick={() => location.reload()}><RefreshCw size={13} />重试</Button>
            </div>
          )}
          {!isOnline && (
            <div className="m-4 p-2.5 rounded-md border border-destructive/20 text-xs" style={{ color: "#d3453b", background: "rgba(211,69,59,0.1)" }} role="alert">
              网络已断开，部分功能可能不可用。
            </div>
          )}
          {/* Main view: Chat + Findings */}
          {activeTab === 'chat' && (
            <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0%', minHeight: 0, overflow: 'hidden' }}>
              {/* Status bar */}
              {(reviewStatus === 'running' || reviewStatus === 'preparing' || reviewStatus === 'normalizing') && (
                <div style={{ padding: '6px 12px', background: '#e8f0fe', borderBottom: '1px solid #d4dae3', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#245fc7' }}>
                    <LoaderCircle size={13} className="animate-spin" />
                    {reviewStatus === 'preparing' ? '准备中…' : reviewStatus === 'normalizing' ? '整理 Findings…' : 'Review 进行中…'}
                  </div>
                </div>
              )}
              {reviewError && (
                <div style={{ padding: '6px 12px', background: '#fef2f2', borderBottom: '1px solid #fecaca', fontSize: 12, color: '#d3453b', flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>{reviewError}</span>
                  <button type="button" onClick={() => setReviewError('')} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: '#d3453b' }}><X size={13} /></button>
                </div>
              )}

              {/* Findings header - always visible when findings exist */}
              {findings.length > 0 && (
                <div style={{ flexShrink: 0, borderBottom: '1px solid #d4dae3' }}>
                  <button type="button" onClick={() => setShowFindings(!showFindings)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: 0, background: '#f4f6f9', cursor: 'pointer', width: '100%', textAlign: 'left' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#1a2332' }}>Findings</span>
                    <span style={{ fontSize: 11, color: '#245fc7', fontWeight: 700 }}>{findings.length}</span>
                    {findings.filter(f => f.severity === 'high' || f.severity === 'critical').length > 0 && <span style={{ fontSize: 10, color: '#d3453b', fontWeight: 600 }}>{findings.filter(f => f.severity === 'high' || f.severity === 'critical').length} High+</span>}
                    <div style={{ flex: 1 }} />
                    <span style={{ fontSize: 11, color: '#5a6b80' }}>{showFindings ? '▲' : '▼'}</span>
                  </button>
                  {showFindings && (
                    <div style={{ maxHeight: '50%', overflowY: 'auto', borderTop: '1px solid #e8edf3', minHeight: 120 }}>
                      <div style={{ display: 'flex', gap: 4, padding: '6px 12px', flexWrap: 'wrap' }}>
                        <select value={filterSeverity} onChange={e => setFilterSeverity(e.target.value)} style={compactSelect} aria-label="严重度筛选">
                          <option value="all">严重度</option><option value="critical">严重</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option>
                        </select>
                        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} style={compactSelect} aria-label="分类筛选">
                          <option value="all">分类</option><option value="bug">缺陷</option><option value="security">安全</option><option value="performance">性能</option><option value="maintainability">可维护性</option><option value="testing">测试</option>
                        </select>
                        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={compactSelect} aria-label="状态筛选">
                          <option value="all">状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="ignored">已忽略</option>
                        </select>
                        {selectedFindings.size > 0 && (
                          <button type="button" onClick={() => setShowBatchConfirm(true)}
                            style={{ padding: '3px 10px', borderRadius: 5, border: 0, background: '#245fc7', color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                            批量发布 ({selectedFindings.size})
                          </button>
                        )}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 12px 8px' }}>
                        {filteredFindings.slice(0, visibleFindingCount).map(finding => (
                          <FindingCard
                            key={finding.id}
                            finding={finding}
                            expanded={expandedFinding === finding.id}
                            selected={selectedFindings.has(finding.id)}
                            onToggleExpand={() => setExpandedFinding(expandedFinding === finding.id ? '' : finding.id)}
                            onToggleSelect={() => {
                              const next = new Set(selectedFindings);
                              if (next.has(finding.id)) next.delete(finding.id); else next.add(finding.id);
                              setSelectedFindings(next);
                            }}
                            onEdit={(edit) => editFinding(finding.id, edit)}
                            onPublish={() => { setPublishFinding(finding); setPublishBody(finding.comment); }}
                            onIgnore={() => { const next = findings.map(f => f.id === finding.id ? { ...f, status: 'ignored' as const } : f); setFindings(next); persistFindings(next); }}
                            onNavigate={() => void highlightFindingOnPage(finding)}
                            onCopy={() => { void navigator.clipboard?.writeText(finding.comment); setToast('评论已复制'); }}
                          />
                        ))}
                        {filteredFindings.length > visibleFindingCount && (
                          <button type="button" onClick={() => setVisibleFindingCount(c => c + 20)}
                            style={{ padding: '6px', borderRadius: 5, border: '1px solid #d4dae3', background: '#fff', color: '#245fc7', fontSize: 11, cursor: 'pointer' }}>
                            加载更多 ({filteredFindings.length - visibleFindingCount})
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Diff info */}
              {findings.length === 0 && (
                <div style={{ padding: '12px', textAlign: 'center', flexShrink: 0 }}>
                  <div style={{ fontSize: 12, color: '#8a9bb0' }}>
                    {files.length > 0 ? `已读取 ${files.length} 个文件的 Diff` : '正在读取 MR Diff…'}
                  </div>
                </div>
              )}

              {/* Chat - fills remaining space */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {attachment && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '6px 12px 0', padding: '5px 8px', borderRadius: 6, background: '#e8f0fe', fontSize: 11, flexShrink: 0 }}>
                    <FileText size={12} style={{ color: '#245fc7', flexShrink: 0 }} />
                    <span style={{ color: '#245fc7', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.filePath}:{attachment.startLine}-{attachment.endLine}</span>
                    <button type="button" onClick={() => setAttachment(undefined)} aria-label="移除代码附件"
                      style={{ border: 0, background: 'transparent', cursor: 'pointer', color: '#8a9bb0', padding: 2 }}><X size={12} /></button>
                  </div>
                )}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <ChatThread
                  draft={draft}
                  onDraftChange={setDraft}
                  messages={messages}
                  onSend={(text) => void sendMessage(text)}
                  responding={responding}
                />
                </div>
              </div>
            </div>
          )}

          {/* Config overlay */}
          {activeTab === 'config' && (
            <div style={{ flex: '1 1 0%', overflowY: 'auto', minHeight: 0 }}>
              <SettingsView
                settings={settings}
                onSettingsChange={setSettings}
                onSave={() => { void saveSettings(settings).then(() => setToast('设置已保存')); }}
                onTestModel={() => void testModelConnection()}
                onClearApiKey={() => { setSettings({ ...settings, apiKey: '' }); void clearSensitiveSettings(); setToast('密钥已清除'); }}
                rulePacks={rulePacks}
                onToggleRulePack={(id, enabled) => {
                  const next = rulePacks.map(p => p.id === id ? { ...p, enabled } : p);
                  setRulePacks(next);
                  void saveRulePacks(next);
                }}
                onDeleteRulePack={(id) => {
                  const next = rulePacks.filter(p => p.id !== id);
                  setRulePacks(next);
                  void removeRulePack(id);
                }}
                onImportRulePack={(json) => {
                  try {
                    const pack = importRulePack(json);
                    const next = [...rulePacks, pack];
                    setRulePacks(next);
                    void saveRulePacks(next);
                    setToast('规则包已导入');
                  } catch (e) {
                    setToast(e instanceof Error ? e.message : '导入失败');
                  }
                }}
                onExportRulePack={(id) => {
                  const pack = rulePacks.find(p => p.id === id);
                  if (pack) {
                    void navigator.clipboard?.writeText(exportRulePack(pack));
                    setToast('规则包 JSON 已复制');
                  }
                }}
                onUpdateRulePack={(id, patch) => {
                  const next = rulePacks.map(p => p.id === id ? { ...p, ...patch } : p);
                  setRulePacks(next);
                  void saveRulePacks(next);
                }}
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
                  const config = exportSiteConfig(page, capabilities ?? { authenticated: false, canReadMergeRequests: false, canCreateDiscussions: false });
                  void navigator.clipboard?.writeText(JSON.stringify(config, null, 2));
                  setToast('站点配置已复制');
                }}
                testing={false}
              />

            </div>
          )}

          {/* Debug overlay - separate from config */}
          {activeTab === 'debug' && (
            <div style={{ flex: '1 1 0%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <DebugPanel
                logs={debugLogs}
                diagnostics={diagnostics}
                toolEvents={toolEvents}
                usageSummary={usageSummary}
                reviewStatus={reviewStatus}
                findingsCount={findings.length}
                filesCount={files.length}
                modelConfigured={runtimeConfigured}
                mcpEnabled={settings.mcp?.enabled ?? false}
                onClearLogs={() => setDebugLogs([])}
              />
            </div>
          )}
        </div>
      </aside>

      {selection && <SelectionToolbar state={selection} onAsk={() => { setAttachment(selection); setActiveTab('chat'); setPanelOpen(true); setShowChat(true); setDraft('请解释这段代码的潜在风险，并给出验证建议。'); setSelection(null); }} onReview={() => { setAttachment(selection); setSelection(null); void startReview('selection'); }} onCopy={() => { void navigator.clipboard?.writeText(selection.text); setToast('选中代码已复制'); setSelection(null); }} onClose={() => setSelection(null)} />}

      {publishFinding && <div className="fixed z-[2147483100] inset-0 grid place-items-center p-[18px] bg-black/55" role="presentation"><section className="w-[min(560px,100%)] max-h-[calc(100vh-36px)] overflow-y-auto rounded-lg border" style={{ background: "#ffffff", borderColor: "#d4dae3" }} role="dialog" aria-modal="true" aria-labelledby="publish-title"><div className="flex items-start justify-between gap-4 px-4 pt-4 pb-3 border-b" style={{ borderColor: "#d4dae3" }}><div><h2 id="publish-title">发布到 GitLab</h2><p>确认项目、MR、代码位置和 diff refs 后创建行级 Discussion。</p></div><button type="button" className="inline-grid h-8 w-8 place-items-center rounded-md bg-transparent border-0 cursor-pointer hover:" style={{ background: "#e8edf3" }} onClick={() => setPublishFinding(undefined)} aria-label="关闭发布确认"><X size={16} /></button></div><div className="grid gap-3 p-4"><div className="flex items-center justify-between gap-3 p-2.5 rounded-md border text-[10px] font-mono" style={{ background: "#f0f3f7", borderColor: "#d4dae3", color: "#4a5568" }}><span>{page.projectPath} · MR !{page.mergeRequestIid}</span><ExternalLink size={13} /></div><div className="flex items-center justify-between gap-3 p-2.5 rounded-md border text-[10px] font-mono" style={{ background: "#f0f3f7", borderColor: "#d4dae3", color: "#4a5568" }}><span>{publishFinding.path}:{publishFinding.line}-{publishFinding.endLine} · {publishFinding.side}</span><span>head {mrContext?.diffRefs.headSha.slice(0, 8)}</span></div><div className="grid gap-1.5"><label htmlFor="publish-body">评论内容</label><textarea id="publish-body" value={publishBody} onChange={(event) => setPublishBody(event.target.value)} /></div></div><div className="flex justify-end gap-2 p-3 border-t" style={{ background: "#f0f3f7", borderColor: "#d4dae3" }}><button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md border cursor-pointer" style={{ background: "#ffffff", borderColor: "#d4dae3", color: "#1a2332" }} onClick={() => setPublishFinding(undefined)}>返回修改</button><button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md -foreground border border-primary cursor-pointer" style={{ color: "#245fc7", background: "#245fc7" }} onClick={() => void confirmPublish()} disabled={publishing || !publishBody.trim()}><MessageSquare size={14} />{publishing ? '发布中…' : '确认发布'}</button></div></section></div>}

      {showBatchConfirm && selectedFindings.size > 0 && (
        <div className="fixed z-[2147483100] inset-0 grid place-items-center p-[18px] bg-black/55" role="presentation">
          <section className="w-[min(560px,100%)] max-h-[calc(100vh-36px)] overflow-y-auto rounded-lg border" style={{ background: "#ffffff", borderColor: "#d4dae3" }} role="dialog" aria-modal="true" aria-labelledby="batch-publish-title">
            <div className="flex items-start justify-between gap-4 px-4 pt-4 pb-3 border-b" style={{ borderColor: "#d4dae3" }}>
              <div>
                <h2 id="batch-publish-title">批量发布到 GitLab</h2>
                <p>将选中的 {selectedFindings.size} 个 Finding 逐条创建行级 Discussion。</p>
              </div>
              <button type="button" className="inline-grid h-8 w-8 place-items-center rounded-md bg-transparent border-0 cursor-pointer hover:" style={{ background: "#e8edf3" }} onClick={() => setShowBatchConfirm(false)} aria-label="关闭批量发布"><X size={16} /></button>
            </div>
            <div className="grid gap-3 p-4">
              <div className="flex items-center justify-between gap-3 p-2.5 rounded-md border text-[10px] font-mono" style={{ background: "#f0f3f7", borderColor: "#d4dae3", color: "#4a5568" }}>
                <span>{page.projectPath} · MR !{page.mergeRequestIid}</span>
                <span>head {mrContext?.diffRefs.headSha.slice(0, 8)}</span>
              </div>
              <div className="grid gap-1.5">
                {findings.filter((f) => selectedFindings.has(f.id)).slice(0, 10).map((f) => (
                  <div key={f.id} className="flex items-center gap-2 p-1.5 rounded border text-[10px]" style={{ background: "#f0f3f7", borderColor: "#d4dae3" }}>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${f.severity === 'high' || f.severity === 'critical' ? 'error' : f.severity === 'medium' ? 'warning' : 'neutral'}`}>{f.severity}</span>
                    <span className="flex-1 min-w-0 truncate">{f.title}</span>
                    <span className="font-mono text-[9px]" style={{ color: "#4a5568" }}>{f.path}:{f.line}</span>
                  </div>
                ))}
                {selectedFindings.size > 10 && <p style={{ fontSize: 10, color: '#6b778b' }}>…还有 {selectedFindings.size - 10} 个</p>}
              </div>
            </div>
            <div className="flex justify-end gap-2 p-3 border-t" style={{ background: "#f0f3f7", borderColor: "#d4dae3" }}>
              <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md border cursor-pointer" style={{ background: "#ffffff", borderColor: "#d4dae3", color: "#1a2332" }} onClick={() => setShowBatchConfirm(false)}>取消</button>
              <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md -foreground border border-primary cursor-pointer" style={{ color: "#245fc7", background: "#245fc7" }} disabled={batchPublishing || !mrContext} onClick={() => void batchConfirmPublish()}>
                <MessageSquare size={14} />{batchPublishing ? '发布中…' : `确认批量发布 ${selectedFindings.size} 条`}
              </button>
            </div>
          </section>
        </div>
      )}
      {toast && <div className="fixed z-[300] right-[18px] bottom-[18px] flex max-w-[360px] items-center gap-2 p-3 rounded-lg text-xs shadow-xl" style={{ background: '#1e2536', color: '#f0f4f8' }} role="status">{toast}</div>}
    </div>
  );
}
