import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Check, Download, ExternalLink, FileText, LoaderCircle, MessageSquare, Package,
  Play, Plus, RefreshCw, Send, Settings, Sparkles, Square, Trash2, Upload, X,
} from 'lucide-react';
import { Button } from './components/ui/button';
import { FindingCard } from './components/review/FindingCard';
import { SelectionToolbar } from './components/review/SelectionToolbar';
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
  const [activeTab, setActiveTab] = useState<'chat' | 'review' | 'settings'>('chat');
  const [panelOpen, setPanelOpen] = useState(true);
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

  // Panel drag state
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
        setActiveTab((current) => current === 'chat' ? 'review' : current === 'review' ? 'settings' : 'chat');
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
      setActiveTab('settings');
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
    reviewAbort.current?.abort();
    const controller = new AbortController();
    reviewAbort.current = controller;
    setActiveTab('review');
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
        source: runtimeConfigured ? 'model' : 'rule',
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

  return (
    <div ref={hostRef} className="relative z-[2147483000]">
      {!panelOpen && (
        <button type="button" onClick={() => setPanelOpen(true)} aria-label="打开 Review Agent"
          className="fixed bottom-[18px] right-[18px] z-[2147483000] grid h-11 w-11 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg cursor-pointer border-0">
          <Bot size={20} />
        </button>
      )}
      <aside ref={panelRef} aria-label="Review Agent"
        className={`fixed z-[2147483000] top-[72px] right-4 bottom-4 w-[min(430px,calc(100vw-32px))] rounded-lg border border-border bg-card shadow-2xl overflow-hidden flex flex-col ${panelOpen ? '' : 'hidden'}`}
        style={{ resize: 'horizontal', minWidth: 320 }}>
        {/* Header */}
        <div onMouseDown={handleDragStart} className="flex items-center justify-between px-4 pt-4 pb-3 bg-panel-header text-panel-header-foreground cursor-grab active:cursor-grabbing select-none">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold m-0"><Bot size={17} /> Review Agent</h2>
            <p className="text-xs opacity-70 mt-1 truncate">{loading ? '正在读取 GitLab API…' : mrContext ? `${mrContext.title.slice(0, 42)} · !${page.mergeRequestIid}` : page.filePath || 'GitLab 页面'}</p>
          </div>
          <button type="button" onClick={() => { clearHighlights(); setPanelOpen(false); }} aria-label="关闭侧栏"
            className="grid h-8 w-8 place-items-center rounded-md hover:bg-white/10 border-0 bg-transparent cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div role="tablist" className="grid grid-cols-3 bg-panel-header border-t border-white/10">
          {([
            { id: 'chat' as const, label: '提问', icon: MessageSquare },
            { id: 'review' as const, label: 'Review', icon: Sparkles, badge: findings.length },
            { id: 'settings' as const, label: '设置', icon: Settings },
          ]).map(({ id, label, icon: Icon, badge }) => (
            <button key={id} type="button" role="tab" aria-selected={activeTab === id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center justify-center gap-1.5 min-h-[42px] text-xs border-0 border-b-2 cursor-pointer transition-colors ${
                activeTab === id
                  ? 'text-white border-blue-400 bg-white/5 font-semibold'
                  : 'text-white/60 border-transparent hover:text-white/80'
              } bg-transparent`}>
              <Icon size={14} />{label}
              {badge ? <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold">{badge}</span> : null}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto bg-card">
          {loadError && (
            <div className="flex items-center justify-between gap-2 m-4 p-2.5 rounded-md text-destructive bg-destructive/10 border border-destructive/20 text-xs" role="alert">
              {loadError}
              <Button variant="outline" size="xs" onClick={() => location.reload()}><RefreshCw size={13} />重试</Button>
            </div>
          )}
          {!isOnline && (
            <div className="m-4 p-2.5 rounded-md text-destructive bg-destructive/10 border border-destructive/20 text-xs" role="alert">
              网络已断开，部分功能可能不可用。
            </div>
          )}
          {activeTab === 'chat' && (
            <div className="flex flex-col h-full">
              <div className="flex-1 overflow-y-auto p-4" aria-live="polite">
                {messages.length === 0 && (
                  <div className="p-3 rounded-lg bg-muted border border-border">
                    <h3 className="text-sm font-semibold m-0 mb-1">询问真实代码</h3>
                    <p className="text-xs text-muted-foreground m-0">在页面中选中 Diff 代码，或直接输入关于当前 MR 的问题。</p>
                    <div className="grid gap-1.5 mt-3">
                      {suggestions.map((item) => (
                        <button key={item} type="button" onClick={() => setDraft(item)}
                          className="p-2 text-left text-xs rounded-md bg-card border border-border hover:bg-accent cursor-pointer">
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {messages.map((message) => (
                  <div key={message.id} className="mb-3.5">
                    <div className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">{message.role === 'user' ? '你' : 'Review Agent'}</div>
                    {message.attachment && (
                      <div className="grid gap-1 mb-1.5 p-2 rounded bg-info/10 border-l-[3px] border-info text-info text-[10px]">
                        <strong>{message.attachment.filePath}</strong>
                        <span>L{message.attachment.startLine}-{message.attachment.endLine}</span>
                      </div>
                    )}
                    <div className={`p-2.5 rounded-lg text-xs leading-relaxed ${
                      message.error
                        ? 'bg-destructive/10 text-destructive border border-destructive/20'
                        : message.role === 'user'
                          ? 'bg-info/10 border border-info/20'
                          : 'bg-muted border border-border'
                    }`}>
                      {message.role === 'assistant' && !message.error ? <Markdown content={message.content} /> : message.content}
                    </div>
                  </div>
                ))}
                {responding && (
                  <div className="mb-3.5">
                    <div className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">Review Agent</div>
                    <div className="p-2.5 rounded-lg bg-muted border border-border text-xs">
                      <LoaderCircle size={14} className="inline animate-spin" /> 正在调用模型服务…
                      {toolEvents.length > 0 && (
                        <div className="grid gap-1 mt-2 pt-2 border-t border-border">
                          {toolEvents.map((event, idx) => (
                            <div key={idx} className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[10px] ${
                              event.type === 'tool_call' ? 'bg-info/10 text-info' :
                              event.type === 'tool_result' ? 'bg-success/10 text-success' :
                              event.type === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
                            }`}>
                              <span className="w-3.5 text-center font-bold">{event.type === 'tool_call' ? '→' : event.type === 'tool_result' ? '←' : event.type === 'error' ? '✗' : '·'}</span>
                              {event.message}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <form className="p-3 pt-0 bg-card border-t border-border" onSubmit={sendChat}>
                {attachment && (
                  <div className="flex items-center justify-between gap-2 mb-2 p-1.5 rounded bg-info/10 border border-info/20 text-[10px] text-info">
                    <span className="truncate">{attachment.filePath}:L{attachment.startLine}-{attachment.endLine}</span>
                    <button type="button" onClick={() => setAttachment(undefined)} aria-label="移除代码附件" className="shrink-0 border-0 bg-transparent cursor-pointer"><X size={13} /></button>
                  </div>
                )}
                <div className="rounded-lg border border-border overflow-hidden bg-card">
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="询问当前 MR 或选中代码…" aria-label="提问内容"
                    className="w-full min-h-[82px] p-2.5 text-xs leading-relaxed bg-transparent border-0 outline-none resize-y text-foreground" />
                  <div className="flex items-center justify-between gap-2 p-1.5 bg-muted border-t border-border">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-secondary text-secondary-foreground">
                      {runtimeConfigured ? settings.model : '规则模式'}
                    </span>
                    <Button type="submit" size="sm" disabled={!draft.trim() || responding}><Send size={14} />发送</Button>
                  </div>
                </div>
              </form>
            </div>
          )}

          {activeTab === 'review' && (
            <div className="p-4">
              <h3 className="text-sm font-semibold text-foreground m-0 mb-1">Review 范围</h3>
              <p className="text-xs text-muted-foreground m-0 mb-3">
                {diffLoadProgress ? `正在加载 Diff… 已读取 ${diffLoadProgress.loaded} 个文件` : files.length > 0 ? `已从 GitLab API 读取 ${files.length} 个文件的真实 Diff。` : '当前页面没有可用的 MR Diff；仍可 Review 已选中的代码。'}
              </p>
              {(reviewStatus === 'idle' || reviewStatus === 'cancelled' || reviewStatus === 'failed') && (
                <div className="p-3 rounded-lg bg-muted border border-border">
                  <h3 className="text-sm font-semibold m-0 mb-1">{reviewStatus === 'cancelled' ? '任务已取消' : reviewStatus === 'failed' ? 'Review 失败' : '准备开始'}</h3>
                  <p className="text-xs text-muted-foreground m-0">{reviewError || 'Finding 先进入草稿，逐条确认后才会创建 GitLab Discussion。'}</p>
                  <div className="flex flex-wrap gap-2 mt-2.5">
                    <Button size="sm" onClick={() => void startReview(attachment ? 'selection' : 'all')} disabled={files.length === 0 && !attachment && !selection}><Play size={14} />开始 Review</Button>
                    {savedSession && <Button variant="outline" size="sm" onClick={() => void resumeSession()}><RefreshCw size={14} />恢复上次 Review</Button>}
                  </div>
                  {savedSession && <p className="text-[10px] text-muted-foreground mt-2">上次会话：{savedSession.findings.length} Findings · {savedSession.status} · {new Date(savedSession.updatedAt).toLocaleString()}</p>}
                </div>
              )}
              {(reviewStatus === 'preparing' || reviewStatus === 'running' || reviewStatus === 'normalizing') && (
                <div className="p-3 rounded-lg bg-muted border border-border">
                  <div className="flex items-center justify-between mb-2.5">
                    <strong className="text-xs">{reviewStatus === 'preparing' ? '准备上下文' : reviewStatus === 'running' ? '分析真实 Diff' : '校验与定位'}</strong>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-info/10 text-info">进行中</span>
                  </div>
                  <div className="w-full h-[7px] rounded-full bg-border overflow-hidden">
                    <div className="h-full bg-primary rounded-full transition-all" style={{ width: reviewStatus === 'running' ? '55%' : reviewStatus === 'normalizing' ? '85%' : '20%' }} />
                  </div>
                  <Button variant="destructive" size="xs" className="mt-2.5" onClick={cancelReview}><Square size={13} />取消</Button>
                </div>
              )}
            {reviewStatus === 'completed' && <>
              <div className="grid grid-cols-4 gap-1.5 mb-3">
                {([
                  [findings.length, 'Findings'],
                  [findings.filter((f) => f.severity === 'high' || f.severity === 'critical').length, 'High+'],
                  [findings.filter((f) => f.status === 'published').length, '已发布'],
                  [findings.filter((f) => f.status === 'ignored').length, '已忽略'],
                ]).map(([val, label]) => (
                  <div key={label as string} className="p-2 text-center rounded bg-muted border border-border">
                    <strong className="block text-base text-foreground">{val}</strong>
                    <span className="text-[9px] text-muted-foreground">{label}</span>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-4 gap-1 mb-2.5">
                <select value={filterSeverity} onChange={(e) => setFilterSeverity(e.target.value)} aria-label="按严重度筛选"
                  className="p-1.5 text-[10px] rounded border border-border bg-muted text-foreground">
                  <option value="all">全部严重度</option><option value="critical">严重</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option>
                </select>
                <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} aria-label="按分类筛选"
                  className="p-1.5 text-[10px] rounded border border-border bg-muted text-foreground">
                  <option value="all">全部分类</option><option value="bug">缺陷</option><option value="security">安全</option><option value="performance">性能</option><option value="maintainability">可维护性</option><option value="test">测试</option>
                </select>
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} aria-label="按状态筛选"
                  className="p-1.5 text-[10px] rounded border border-border bg-muted text-foreground">
                  <option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="ignored">已忽略</option>
                </select>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} aria-label="排序方式"
                  className="p-1.5 text-[10px] rounded border border-border bg-muted text-foreground">
                  <option value="severity">按严重度</option><option value="line">按行号</option><option value="path">按文件</option>
                </select>
              </div>
              {filteredFindings.length !== findings.length && (
                <p className="text-xs text-muted-foreground m-0 mb-2">显示 {filteredFindings.length}/{findings.length} 个 Finding</p>
              )}

              <div className="flex items-center gap-2 mb-2.5 p-2 rounded-md bg-muted border border-border text-xs">
                {selectedFindings.size > 0 ? (
                  <>
                    <span className="font-semibold text-foreground">已选 {selectedFindings.size} 个</span>
                    <Button size="xs" disabled={!mrContext || batchPublishing} onClick={() => setShowBatchConfirm(true)}>
                      <MessageSquare size={13} />{batchPublishing ? '发布中…' : `批量发布 ${selectedFindings.size} 条`}
                    </Button>
                    <Button variant="outline" size="xs" onClick={clearSelection}>取消选择</Button>
                  </>
                ) : (
                  <Button variant="outline" size="xs" onClick={selectAllPublishable}>全选可发布</Button>
                )}
              </div>
              <div className="grid gap-2">{filteredFindings.slice(0, visibleFindingCount).map((finding) => <FindingCard key={finding.id} finding={finding} expanded={expandedFinding === finding.id} selected={selectedFindings.has(finding.id)} publishDisabled={!mrContext || publishing || finding.anchor?.publishable === false} onToggle={() => setExpandedFinding((current) => current === finding.id ? '' : finding.id)} onSelect={() => toggleFindingSelection(finding.id)} onLocate={() => locateFinding(finding)} onCopy={() => { void navigator.clipboard?.writeText(finding.comment); setToast('评论草稿已复制'); }} onPublish={() => { setPublishFinding(finding); setPublishBody(finding.comment); }} onEdit={(edit) => editFinding(finding.id, edit)} onIgnore={() => ignoreFinding(finding.id)} />)}</div>
              {filteredFindings.length > visibleFindingCount && (
                <Button variant="outline" className="w-full mt-2" onClick={() => setVisibleFindingCount((c) => c + 20)}>
                  显示更多（还有 {filteredFindings.length - visibleFindingCount} 个）
                </Button>
              )}
            </>}
            </div>
          )}

          {activeTab === 'settings' && <div className="p-4">
            <h3 className="text-sm font-semibold text-foreground m-0 mb-1">模型配置</h3>
            <p className="text-xs text-muted-foreground m-0 mb-3">选择提供商后自动填充默认地址和模型，只需填 API Key。</p>
            <div className="grid grid-cols-3 gap-[3px] mb-3 p-[3px] bg-muted rounded-md">
              {(Object.entries(providerPresets) as [string, typeof providerPresets.openai][]).map(([key, preset]) => (
                <button
                  key={key}
                  type="button"
                  className={`min-h-8 px-2 py-1 text-[11px] font-semibold rounded border-0 cursor-pointer transition-colors ${settings.provider === key ? 'bg-card text-primary shadow-sm' : 'bg-transparent text-muted-foreground hover:text-foreground'}`}
                  onClick={() => {
                    const provider = key as RuntimeSettings['provider'];
                    setSettings({
                      ...settings,
                      provider,
                      modelBaseUrl: preset.defaultBaseUrl,
                      model: preset.defaultModel,
                    });
                  }}
                >{preset.label}</button>
              ))}
            </div>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <label htmlFor="api-key">API Key <span style={{ color: '#a52a22', fontWeight: 400 }}>唯一必填</span></label>
                <input id="api-key" type="password" value={settings.apiKey} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} autoComplete="off" placeholder={providerPresets[settings.provider].placeholderKey} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="model-url">Base URL</label>
                <input id="model-url" value={settings.modelBaseUrl} onChange={(event) => setSettings({ ...settings, modelBaseUrl: event.target.value })} placeholder={providerPresets[settings.provider].defaultBaseUrl} />
                <span className="text-[9px] text-muted-foreground opacity-70">自部署/企业网关才需要改</span>
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="model-name">模型名称</label>
                <input id="model-name" value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} placeholder={providerPresets[settings.provider].defaultModel} />
                <span className="text-[9px] text-muted-foreground opacity-70">留空使用默认模型</span>
              </div>
            </div>

            <h3 className="text-sm font-semibold text-foreground m-0 mb-1" style={{ marginTop: 20 }}>输出设置</h3>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <label htmlFor="effort">审查强度</label>
                <select id="effort" value={settings.effort} onChange={(event) => setSettings({ ...settings, effort: event.target.value as RuntimeSettings['effort'] })}>
                  <option value="fast">快速（仅高置信度）</option>
                  <option value="balanced">均衡（推荐）</option>
                  <option value="thorough">全面（更多问题）</option>
                </select>
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="language">输出语言</label>
                <select id="language" value={settings.language} onChange={(event) => setSettings({ ...settings, language: event.target.value as RuntimeSettings['language'] })}>
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                </select>
              </div>
            </div>

            <details className="mt-4 border border-border rounded-md overflow-hidden">
              <summary>高级设置（一般不需要改）</summary>
              <div className="grid gap-3" style={{ marginTop: 10 }}>
                <div className="grid gap-1.5">
                  <label htmlFor="gitlab-token">GitLab PAT</label>
                  <input id="gitlab-token" type="password" value={settings.gitlabToken} onChange={(event) => setSettings({ ...settings, gitlabToken: event.target.value })} autoComplete="off" placeholder="留空使用 Cookie 认证" />
                  <span className="text-[9px] text-muted-foreground opacity-70">留空即可，脚本自动使用页面 Cookie + CSRF</span>
                </div>
                <div className="grid gap-1.5">
                  <label htmlFor="auth-mode">API 认证方式</label>
                  <select id="auth-mode" value={settings.auth?.mode ?? 'bearer'} onChange={(e) => setSettings({ ...settings, auth: { ...settings.auth, mode: e.target.value as RuntimeSettings['auth']['mode'] } })}>
                    <option value="bearer">Bearer Token（默认）</option>
                    <option value="api-key-header">API Key Header</option>
                    <option value="query-param">Query Parameter</option>
                    <option value="custom">自定义 Header</option>
                  </select>
                  <span className="text-[9px] text-muted-foreground opacity-70">企业网关才需要改</span>
                </div>
                {(settings.auth?.mode === 'api-key-header' || settings.auth?.mode === 'custom') && (
                  <div className="grid gap-1.5">
                    <label htmlFor="auth-header-name">Header 名称</label>
                    <input id="auth-header-name" value={settings.auth?.apiKeyHeader ?? ''} onChange={(e) => setSettings({ ...settings, auth: { ...settings.auth, apiKeyHeader: e.target.value } })} placeholder="api-key" />
                  </div>
                )}
                {settings.auth?.mode === 'query-param' && (
                  <div className="grid gap-1.5">
                    <label htmlFor="auth-param-name">Query 参数名</label>
                    <input id="auth-param-name" value={settings.auth?.apiKeyQueryParam ?? ''} onChange={(e) => setSettings({ ...settings, auth: { ...settings.auth, apiKeyQueryParam: e.target.value } })} placeholder="key" />
                  </div>
                )}
              </div>
            </details>

            <div className="flex justify-end gap-2 p-3 bg-muted border-t border-border">
              <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md text-destructive border border-destructive bg-transparent cursor-pointer" onClick={() => void clearSensitiveSettings().then(() => setSettings((current) => ({ ...current, apiKey: '', gitlabToken: '' })))}>清除密钥</button>
              <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md bg-card border border-border cursor-pointer text-foreground" onClick={() => void runtime.testConnection().then(() => setToast('模型连接正常')).catch((error: unknown) => setToast(`模型连接失败：${String(error)}`))}>测试模型</button>
              <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md bg-primary text-primary-foreground border border-primary cursor-pointer" onClick={() => void saveSettings(settings).then(() => setToast('设置已保存'))}><Check size={14} />保存</button>
            </div>
            <div className="grid gap-2"><div className="grid gap-2 p-3 rounded-lg bg-muted border border-border"><div className="flex items-center justify-between gap-2.5"><strong>GitLab API</strong><span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${mrContext ? 'success' : 'warning'}`}>{mrContext ? '已读取 MR' : '待连接'}</span></div><p>同源 REST API；可选 PAT。发布时携带当前页面 CSRF Token 和最新 diff refs。</p></div></div>

            <h3 className="text-sm font-semibold text-foreground m-0 mb-1" style={{ marginTop: 20 }}>Token 用量统计</h3>
            {usageSummary ? (
              <div className="p-3 rounded-lg bg-muted border border-border mt-3">
                <div className="flex items-center justify-between py-1.5 border-t border-border first:border-t-0 text-[10px]"><span>总调用次数</span><strong>{usageSummary.callCount}</strong></div>
                <div className="flex items-center justify-between py-1.5 border-t border-border first:border-t-0 text-[10px]"><span>输入 Tokens</span><strong>{formatTokenCount(usageSummary.totalInputTokens)}</strong></div>
                <div className="flex items-center justify-between py-1.5 border-t border-border first:border-t-0 text-[10px]"><span>输出 Tokens</span><strong>{formatTokenCount(usageSummary.totalOutputTokens)}</strong></div>
                <div className="flex items-center justify-between py-1.5 border-t border-border first:border-t-0 text-[10px]"><span>估算费用</span><strong>{formatCost(usageSummary.totalEstimatedCost)}</strong></div>
                {Object.entries(usageSummary.byModel).map(([key, data]) => (
                  <div key={key} className="flex items-center justify-between py-1.5 border-t border-border first:border-t-0 text-[10px]" style={{ fontSize: 9, opacity: 0.8 }}>
                    <span>{key}（{data.count} 次）</span>
                    <span>{formatTokenCount(data.inputTokens + data.outputTokens)} tok · {formatCost(data.estimatedCost)}</span>
                  </div>
                ))}
                <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md bg-card border border-border cursor-pointer text-foreground" style={{ marginTop: 6 }} onClick={() => { void clearUsage().then(() => { setUsageSummary(null); setToast('用量记录已清空'); }); }}>清空记录</button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground m-0 mb-3">暂无用量记录。模型调用后会自动统计。</p>
            )}

            <h3 className="text-sm font-semibold text-foreground m-0 mb-1" style={{ marginTop: 20 }}><Package size={15} /> 规则包管理</h3>
            <p className="text-xs text-muted-foreground m-0 mb-3">配置确定性规则检查包。未配置模型时，Review 将使用已启用的规则包。</p>

            <div className="grid gap-2 mb-3">
              {rulePacks.map((pack) => (
                <div key={pack.id} className={`rounded-md border border-border bg-card overflow-hidden${pack.enabled ? '' : ' opacity-60'}`}>
                  <div className="flex items-center justify-between gap-2.5 p-2.5">
                    <div className="flex items-center gap-1.5 min-w-0 text-xs">
                      <strong>{pack.name}</strong>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-secondary text-secondary-foreground">v{pack.version}</span>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-secondary text-secondary-foreground">{pack.rules.length} 条规则</span>
                      {pack.builtIn && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-info/15 text-info">内置</span>}
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button type="button" className="inline-grid h-8 w-8 place-items-center rounded-md bg-transparent border-0 cursor-pointer hover:bg-white/10" title={pack.enabled ? '禁用' : '启用'} onClick={() => void toggleRulePack(pack.id)}>
                        {pack.enabled ? '✓' : '✗'}
                      </button>
                      <button type="button" className="inline-grid h-8 w-8 place-items-center rounded-md bg-transparent border-0 cursor-pointer hover:bg-white/10" title="编辑" onClick={() => setEditingPackId(editingPackId === pack.id ? null : pack.id)}>
                        <FileText size={13} />
                      </button>
                      {!pack.builtIn && <>
                        <button type="button" className="inline-grid h-8 w-8 place-items-center rounded-md bg-transparent border-0 cursor-pointer hover:bg-white/10" title="导出" onClick={() => handleExportPack(pack)}>
                          <Download size={13} />
                        </button>
                        <button type="button" className="inline-grid h-8 w-8 place-items-center rounded-md bg-transparent border-0 cursor-pointer hover:bg-white/10" title="删除" onClick={() => void deleteRulePack(pack.id)}>
                          <Trash2 size={13} />
                        </button>
                      </>}
                    </div>
                  </div>
                  {pack.description && <p className="text-muted-foreground text-[10px] leading-relaxed">{pack.description}</p>}

                  {editingPackId === pack.id && (
                    <div className="p-2.5 border-t border-border bg-muted">
                      {!pack.builtIn && (
                        <div className="grid gap-3" style={{ marginBottom: 8 }}>
                          <div className="grid gap-1.5">
                            <label>名称</label>
                            <input value={pack.name} onChange={(e) => void updatePack({ ...pack, name: e.target.value })} />
                          </div>
                          <div className="grid gap-1.5">
                            <label>版本</label>
                            <input value={pack.version} onChange={(e) => void updatePack({ ...pack, version: e.target.value })} />
                          </div>
                          <div className="grid gap-1.5" style={{ gridColumn: '1 / -1' }}>
                            <label>描述</label>
                            <input value={pack.description ?? ''} onChange={(e) => void updatePack({ ...pack, description: e.target.value })} placeholder="可选描述" />
                          </div>
                        </div>
                      )}
                      {pack.rules.map((rule) => (
                        <div key={rule.id} className={`p-2 rounded-md border border-border bg-card mb-1.5${rule.enabled ? '' : ' opacity-55'}`}>
                          <div className="flex items-center gap-2">
                            <label className="flex items-center gap-1.5 min-w-0 cursor-pointer text-[11px]">
                              <input type="checkbox" checked={rule.enabled} onChange={() => void toggleRule(pack.id, rule.id)} />
                              <span className="truncate font-semibold text-foreground">{rule.title}</span>
                            </label>
                            <div className="flex gap-1 ml-auto shrink-0">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${rule.severity === 'high' || rule.severity === 'critical' ? 'error' : rule.severity === 'medium' ? 'warning' : 'neutral'}`}>{rule.severity}</span>
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-secondary text-secondary-foreground">{rule.category}</span>
                            </div>
                            {!pack.builtIn && (
                              <button type="button" className="inline-grid h-8 w-8 place-items-center rounded-md bg-transparent border-0 cursor-pointer hover:bg-white/10" title="删除规则" onClick={() => void removeRuleFromPack(pack.id, rule.id)}>
                                <X size={12} />
                              </button>
                            )}
                          </div>
                          {rule.matchPatterns.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {rule.matchPatterns.map((pattern, idx) => (
                                <code key={idx} className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-muted text-foreground break-all">{pattern.pattern}</code>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                      {!pack.builtIn && (
                        <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md bg-card border border-border cursor-pointer text-foreground" style={{ marginTop: 6 }} onClick={() => void addRuleToPack(pack.id)}>
                          <Plus size={13} /> 添加规则
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="grid gap-2.5 pt-2.5 border-t border-border">
              <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md bg-card border border-border cursor-pointer text-foreground" onClick={() => void createNewPack()}>
                <Plus size={13} /> 新建规则包
              </button>
              <div className="grid gap-1.5">
                <textarea
                  className="w-full min-h-[60px] p-2 text-[10px] font-mono rounded-md border border-border bg-card text-foreground resize-y"
                  value={importText}
                  onChange={(e) => { setImportText(e.target.value); setImportError(''); }}
                  placeholder='粘贴规则包 JSON…'
                  rows={3}
                />
                {importError && <p className="text-destructive text-[10px] m-0">{importError}</p>}
                <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md bg-card border border-border cursor-pointer text-foreground" disabled={!importText.trim()} onClick={() => void handleImportPack()}>
                  <Upload size={13} /> 导入规则包
                </button>
              </div>
            </div>

            <h3 className="text-sm font-semibold text-foreground m-0 mb-1" style={{ marginTop: 20 }}><Package size={15} /> MCP 扩展工具</h3>
            <p className="text-xs text-muted-foreground m-0 mb-3">连接本地 MCP server（Streamable HTTP），扩展 Agent 工具能力。仅支持 HTTP 传输，不支持 stdio。</p>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <label htmlFor="mcp-enabled">启用 MCP</label>
                <select id="mcp-enabled" value={settings.mcp?.enabled ? 'on' : 'off'} onChange={(e) => setSettings({ ...settings, mcp: { ...settings.mcp, enabled: e.target.value === 'on' } })}>
                  <option value="off">关闭</option>
                  <option value="on">开启</option>
                </select>
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="mcp-url">MCP Server URL</label>
                <input
                  id="mcp-url"
                  value={settings.mcp?.serverUrl ?? ''}
                  onChange={(e) => setSettings({ ...settings, mcp: { ...settings.mcp, serverUrl: e.target.value } })}
                  placeholder="http://127.0.0.1:3000/mcp"
                  disabled={!settings.mcp?.enabled}
                />
              </div>
            </div>
            <div className="grid gap-2" style={{ marginTop: 10 }}>
              <div className="grid gap-2 p-3 rounded-lg bg-muted border border-border">
                <div className="flex items-center justify-between gap-2.5">
                  <strong>MCP 传输类型</strong>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-info/15 text-info">Streamable HTTP</span>
                </div>
                <p>浏览器油猴脚本仅支持 HTTP 传输（POST JSON-RPC）。不支持 stdio 本地进程。URL 以 /sse 结尾时自动使用 SSE 模式。</p>
              </div>
            </div>

            <h3 className="text-sm font-semibold text-foreground m-0 mb-1" style={{ marginTop: 20 }}>兼容性诊断</h3>
            {capabilities && <div className="grid gap-2">
              <div className="grid gap-2 p-3 rounded-lg bg-muted border border-border">
                <div className="flex items-center justify-between gap-2.5">
                  <strong>GitLab 实例状态</strong>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${capabilities.authenticated ? 'success' : 'warning'}`}>{capabilities.gitlabVersion ?? '未知版本'}</span>
                </div>
                <div className="p-3 rounded-lg bg-muted border border-border mt-3">
                  <div className="flex items-center justify-between py-1.5 border-t border-border first:border-t-0 text-[10px]"><span>认证</span><span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${capabilities.authenticated ? 'success' : 'warning'}`}>{capabilities.authMode}</span></div>
                  <div className="flex items-center justify-between py-1.5 border-t border-border first:border-t-0 text-[10px]"><span>API 读取</span><span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${capabilities.canReadMergeRequests ? 'success' : 'error'}`}>{capabilities.canReadMergeRequests ? '可用' : '不可用'}</span></div>
                  <div className="flex items-center justify-between py-1.5 border-t border-border first:border-t-0 text-[10px]"><span>代码搜索</span><span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${capabilities.canSearchCode ? 'success' : 'neutral'}`}>{capabilities.canSearchCode ? '可用' : '不可用'}</span></div>
                  <div className="flex items-center justify-between py-1.5 border-t border-border first:border-t-0 text-[10px]"><span>评论发布</span><span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${capabilities.canCreateDiscussions ? 'success' : 'error'}`}>{capabilities.canCreateDiscussions ? '可用' : '不可用'}</span></div>
                  <div className="flex items-center justify-between py-1.5 border-t border-border first:border-t-0 text-[10px]"><span>CSRF Token</span><span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${capabilities.csrfAvailable ? 'success' : 'warning'}`}>{capabilities.csrfAvailable ? '存在' : '缺失'}</span></div>
                </div>
              </div>
            </div>}
            {capabilities?.warnings && capabilities.warnings.length > 0 && (
              <div className="flex items-center justify-between gap-2.5 m-4 p-2.5 rounded-md text-destructive bg-destructive/10 border border-destructive/20 text-xs" role="alert" style={{ margin: '8px 0 0' }}>
                {capabilities.warnings.join(' ')}
              </div>
            )}
            {diagnostics.length > 0 && (
              <div className="p-3 rounded-lg bg-muted border border-border mt-3" style={{ marginTop: 8 }}>
                {diagnostics.map((diag, idx) => (
                  <div key={idx} className="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[9px] opacity-85">
                    <span className="w-3.5 text-center font-bold shrink-0">{diag.level === 'error' ? '✗' : diag.level === 'warn' ? '⚠' : '·'}</span>
                    <span>[{diag.source}] {diag.message}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2 mt-2.5" style={{ marginTop: 8 }}>
              <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md bg-card border border-border cursor-pointer text-foreground" onClick={() => {
                const config = exportSiteConfig(page, capabilities ?? {
                  authenticated: false, canReadMergeRequests: false, canCreateDiscussions: false,
                  canSearchCode: false, canReadRepository: true, canPaginateDiffs: true,
                  maxDiffPageSize: 100, authMode: 'none', domAvailable: true, csrfAvailable: true, warnings: [],
                }, settings as unknown as Record<string, unknown>);
                void navigator.clipboard?.writeText(config);
                setToast('站点配置已复制到剪贴板');
              }}><Download size={13} /> 导出配置</button>
            </div>

            {sessionHistory.length > 0 && <>
              <h3 className="text-sm font-semibold text-foreground m-0 mb-1" style={{ marginTop: 20 }}>Review 会话历史</h3>
              <div className="grid gap-2">
                {sessionHistory.map((session) => (
                  <div key={session.id} className="grid gap-2 p-3 rounded-lg bg-muted border border-border">
                    <div className="flex items-center justify-between gap-2.5">
                      <strong>{session.projectPath} !{session.mergeRequestIid}</strong>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${session.status === 'completed' ? 'success' : session.status === 'failed' ? 'error' : session.status === 'cancelled' ? 'warning' : 'info'}`}>{session.status}</span>
                    </div>
                    <p style={{ fontSize: 9 }}>{session.findings.length} Findings · {session.source} · {new Date(session.updatedAt).toLocaleString()}</p>
                  </div>
                ))}
              </div>
            </>}
          </div>}
        </div>
      </aside>

      {selection && <SelectionToolbar state={selection} onAsk={() => { setAttachment(selection); setActiveTab('chat'); setPanelOpen(true); setDraft('请解释这段代码的潜在风险，并给出验证建议。'); setSelection(null); }} onReview={() => { setAttachment(selection); setSelection(null); void startReview('selection'); }} onCopy={() => { void navigator.clipboard?.writeText(selection.text); setToast('选中代码已复制'); setSelection(null); }} onClose={() => setSelection(null)} />}

      {publishFinding && <div className="fixed z-[200] inset-0 grid place-items-center p-[18px] bg-black/55" role="presentation"><section className="w-[min(560px,100%)] max-h-[calc(100vh-36px)] overflow-y-auto rounded-lg border border-border bg-popover" role="dialog" aria-modal="true" aria-labelledby="publish-title"><div className="flex items-start justify-between gap-4 px-4 pt-4 pb-3 border-b border-border"><div><h2 id="publish-title">发布到 GitLab</h2><p>确认项目、MR、代码位置和 diff refs 后创建行级 Discussion。</p></div><button type="button" className="inline-grid h-8 w-8 place-items-center rounded-md bg-transparent border-0 cursor-pointer hover:bg-accent" onClick={() => setPublishFinding(undefined)} aria-label="关闭发布确认"><X size={16} /></button></div><div className="grid gap-3 p-4"><div className="flex items-center justify-between gap-3 p-2.5 rounded-md bg-muted border border-border text-[10px] font-mono text-muted-foreground"><span>{page.projectPath} · MR !{page.mergeRequestIid}</span><ExternalLink size={13} /></div><div className="flex items-center justify-between gap-3 p-2.5 rounded-md bg-muted border border-border text-[10px] font-mono text-muted-foreground"><span>{publishFinding.path}:{publishFinding.line}-{publishFinding.endLine} · {publishFinding.side}</span><span>head {mrContext?.diffRefs.headSha.slice(0, 8)}</span></div><div className="grid gap-1.5"><label htmlFor="publish-body">评论内容</label><textarea id="publish-body" value={publishBody} onChange={(event) => setPublishBody(event.target.value)} /></div></div><div className="flex justify-end gap-2 p-3 bg-muted border-t border-border"><button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md bg-card border border-border cursor-pointer text-foreground" onClick={() => setPublishFinding(undefined)}>返回修改</button><button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md bg-primary text-primary-foreground border border-primary cursor-pointer" onClick={() => void confirmPublish()} disabled={publishing || !publishBody.trim()}><MessageSquare size={14} />{publishing ? '发布中…' : '确认发布'}</button></div></section></div>}

      {showBatchConfirm && selectedFindings.size > 0 && (
        <div className="fixed z-[200] inset-0 grid place-items-center p-[18px] bg-black/55" role="presentation">
          <section className="w-[min(560px,100%)] max-h-[calc(100vh-36px)] overflow-y-auto rounded-lg border border-border bg-popover" role="dialog" aria-modal="true" aria-labelledby="batch-publish-title">
            <div className="flex items-start justify-between gap-4 px-4 pt-4 pb-3 border-b border-border">
              <div>
                <h2 id="batch-publish-title">批量发布到 GitLab</h2>
                <p>将选中的 {selectedFindings.size} 个 Finding 逐条创建行级 Discussion。</p>
              </div>
              <button type="button" className="inline-grid h-8 w-8 place-items-center rounded-md bg-transparent border-0 cursor-pointer hover:bg-accent" onClick={() => setShowBatchConfirm(false)} aria-label="关闭批量发布"><X size={16} /></button>
            </div>
            <div className="grid gap-3 p-4">
              <div className="flex items-center justify-between gap-3 p-2.5 rounded-md bg-muted border border-border text-[10px] font-mono text-muted-foreground">
                <span>{page.projectPath} · MR !{page.mergeRequestIid}</span>
                <span>head {mrContext?.diffRefs.headSha.slice(0, 8)}</span>
              </div>
              <div className="grid gap-1.5">
                {findings.filter((f) => selectedFindings.has(f.id)).slice(0, 10).map((f) => (
                  <div key={f.id} className="flex items-center gap-2 p-1.5 rounded bg-muted border border-border text-[10px]">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${f.severity === 'high' || f.severity === 'critical' ? 'error' : f.severity === 'medium' ? 'warning' : 'neutral'}`}>{f.severity}</span>
                    <span className="flex-1 min-w-0 truncate">{f.title}</span>
                    <span className="text-muted-foreground font-mono text-[9px]">{f.path}:{f.line}</span>
                  </div>
                ))}
                {selectedFindings.size > 10 && <p style={{ fontSize: 10, color: '#6b778b' }}>…还有 {selectedFindings.size - 10} 个</p>}
              </div>
            </div>
            <div className="flex justify-end gap-2 p-3 bg-muted border-t border-border">
              <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md bg-card border border-border cursor-pointer text-foreground" onClick={() => setShowBatchConfirm(false)}>取消</button>
              <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 py-1.5 text-xs font-semibold rounded-md bg-primary text-primary-foreground border border-primary cursor-pointer" disabled={batchPublishing || !mrContext} onClick={() => void batchConfirmPublish()}>
                <MessageSquare size={14} />{batchPublishing ? '发布中…' : `确认批量发布 ${selectedFindings.size} 条`}
              </button>
            </div>
          </section>
        </div>
      )}
      {toast && <div className="fixed z-[300] right-[18px] bottom-[18px] flex max-w-[360px] items-center gap-2 p-3 rounded-lg text-xs bg-panel-header text-panel-header-foreground shadow-xl" role="status">{toast}</div>}
    </div>
  );
}
