import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Check, Download, ExternalLink, FileText, LoaderCircle, MessageSquare, Package,
  Play, Plus, RefreshCw, Save, Send, Settings, Sparkles, Square, Trash2, Upload, X,
} from 'lucide-react';
import { FindingCard } from './components/review/FindingCard';
import { SelectionToolbar } from './components/review/SelectionToolbar';
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
  validateRulePack,
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

  const runtime: ModelRuntime = useMemo(() => createModelRuntime(settings), [settings]);
  const reviewEngine = useMemo(() => new ReviewEngine(runtime, settings, rulePacks), [runtime, settings, rulePacks]);
  const mergeRequestRef = useMemo(() => mergeRequestRefFromPage(page), [page]);
  const runtimeConfigured = runtime.configured;

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
      adapter.getMergeRequest(mergeRequestRef),
      adapter.listDiffs(mergeRequestRef, {
        onPage: (loaded, hasMore) => setDiffLoadProgress({ loaded, hasMore }),
      }),
    ]).then(([context, diffs]) => {
      if (controller.signal.aborted) return;
      setDiffLoadProgress(null);
      setMrContext(context);
      setFiles(diffs);
      setLoading(false);
      if (mergeRequestRef) {
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

  // Probe GitLab capabilities once page context is available
  useEffect(() => {
    if (!page.origin) return;
    let active = true;
    void probeCapabilities(page.origin, settings.gitlabToken).then(({ capabilities: caps, diagnostics: diags }) => {
      if (active) {
        setCapabilities(caps);
        setDiagnostics(diags);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [page.origin, settings.gitlabToken]);

  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || responding) return;
    const userMessage: ChatMessage = { id: `user-${Date.now()}`, role: 'user', content, attachment };
    const history = [...messages, userMessage];
    setMessages(history);
    setDraft('');
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
        const gitlabExecutor = new GitLabToolExecutor(adapter, mergeRequestRef, mrContext.diffRefs.headSha);
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
        });
        setMessages((current) => [...current, {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: result.text + (result.toolCalls.length > 0
            ? `\n\n---\n🔧 调用了 ${result.toolCalls.length} 次工具，${result.iterations} 轮推理`
            : ''),
        }]);
      } else {
        const answer = await runtime.chat(history, attachment);
        setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: 'assistant', content: answer }]);
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
      setReviewStatus('normalizing');
      const result = await reviewEngine.run({
        files: scopedFiles,
        selection: selected,
        signal: controller.signal,
        loadFile: (path, ref, signal) => adapter.getFile(path, ref),
        fullFileRef: mrContext?.diffRefs.headSha ?? page.commitSha,
      });
      if (controller.signal.aborted) return;
      setFindings(result.findings);
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
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-line-number], .line_holder'));
    const row = rows.find((candidate) => {
      const lineNumber = Number(candidate.dataset.lineNumber ?? candidate.dataset.line);
      const path = candidate.closest('[data-file-path], .diff-file')?.textContent ?? '';
      return lineNumber === finding.line && path.includes(finding.path);
    }) ?? rows.find((candidate) => Number(candidate.dataset.lineNumber ?? candidate.dataset.line) === finding.line);
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row?.setAttribute('data-ra-highlight', 'true');
    setToast(row ? `已定位到 ${finding.path}:${finding.line}` : '当前页面找不到对应 Diff 行');
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
    <div ref={hostRef} className="ra-host">
      {!panelOpen && <button type="button" className="ra-host-toggle" onClick={() => setPanelOpen(true)} aria-label="打开 Review Agent"><Bot size={20} /></button>}
      <aside className={`ra-agent-panel ra-floating${panelOpen ? '' : ' closed'}`} aria-label="Review Agent">
        <div className="ra-panel-header">
          <div className="ra-panel-title">
            <div>
              <h2><Bot size={17} /> Review Agent</h2>
              <p>{loading ? '正在读取 GitLab API…' : mrContext ? `${mrContext.title.slice(0, 42)} · !${page.mergeRequestIid}` : page.filePath || 'GitLab 页面'}</p>
            </div>
            <button type="button" className="ra-icon-btn" onClick={() => setPanelOpen(false)} aria-label="关闭侧栏"><X size={16} /></button>
          </div>
        </div>

        <div className="ra-panel-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={activeTab === 'chat'} className={`ra-panel-tab${activeTab === 'chat' ? ' active' : ''}`} onClick={() => setActiveTab('chat')}><MessageSquare size={14} />提问</button>
          <button type="button" role="tab" aria-selected={activeTab === 'review'} className={`ra-panel-tab${activeTab === 'review' ? ' active' : ''}`} onClick={() => setActiveTab('review')}><Sparkles size={14} />Review{findings.length > 0 && <span className="ra-count error">{findings.length}</span>}</button>
          <button type="button" role="tab" aria-selected={activeTab === 'settings'} className={`ra-panel-tab${activeTab === 'settings' ? ' active' : ''}`} onClick={() => setActiveTab('settings')}><Settings size={14} />设置</button>
        </div>

        <div className="ra-panel-body">
          {loadError && <div className="ra-alert error" role="alert">{loadError}<button type="button" className="ra-btn" onClick={() => location.reload()}><RefreshCw size={13} />重试</button></div>}
          {activeTab === 'chat' && <div className="ra-chat">
            <div className="ra-messages" aria-live="polite">
              {messages.length === 0 && <div className="ra-empty-card"><h3>询问真实代码</h3><p>在页面中选中 Diff 代码，或直接输入关于当前 MR 的问题。</p><div className="ra-suggestions">{suggestions.map((item) => <button type="button" className="ra-suggestion" key={item} onClick={() => setDraft(item)}>{item}</button>)}</div></div>}
              {messages.map((message) => <div className={`ra-message ${message.role}${message.error ? ' error' : ''}`} key={message.id}><div className="ra-message-label">{message.role === 'user' ? '你' : 'Review Agent'}</div>{message.attachment && <div className="ra-attachment"><strong>{message.attachment.filePath}</strong><span>L{message.attachment.startLine}-{message.attachment.endLine}</span></div>}<div className="ra-message-body">{message.content}</div></div>)}
              {responding && <div className="ra-message"><div className="ra-message-label">Review Agent</div><div className="ra-message-body"><LoaderCircle size={14} /> 正在调用模型服务…{toolEvents.length > 0 && <div className="ra-tool-events">{toolEvents.map((event, idx) => <div key={idx} className={`ra-tool-event ${event.type}`}><span className="ra-tool-event-icon">{event.type === 'tool_call' ? '→' : event.type === 'tool_result' ? '←' : event.type === 'error' ? '✗' : '·'}</span>{event.message}</div>)}</div>}</div></div>}
            </div>
            <form className="ra-composer" onSubmit={sendChat}>
              {attachment && <div className="ra-context-chip"><span>{attachment.filePath}:L{attachment.startLine}-{attachment.endLine}</span><button type="button" className="ra-icon-btn on-light" onClick={() => setAttachment(undefined)} aria-label="移除代码附件"><X size={13} /></button></div>}
              <div className="ra-composer-box"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="询问当前 MR 或选中代码…" aria-label="提问内容" /><div className="ra-composer-actions"><span className="ra-badge neutral">{runtimeConfigured ? settings.model : '规则模式'}</span><button type="submit" className="ra-btn primary" disabled={!draft.trim() || responding}><Send size={14} />发送</button></div></div>
            </form>
          </div>}

          {activeTab === 'review' && <div className="ra-review-view">
            <h3 className="ra-section-title">Review 范围</h3>
            <p className="ra-section-copy">{diffLoadProgress ? `正在加载 Diff… 已读取 ${diffLoadProgress.loaded} 个文件` : files.length > 0 ? `已从 GitLab API 读取 ${files.length} 个文件的真实 Diff。` : '当前页面没有可用的 MR Diff；仍可 Review 已选中的代码。'}</p>
            {(reviewStatus === 'idle' || reviewStatus === 'cancelled' || reviewStatus === 'failed') && (
              <div className="ra-empty-card">
                <h3>{reviewStatus === 'cancelled' ? '任务已取消' : reviewStatus === 'failed' ? 'Review 失败' : '准备开始'}</h3>
                <p>{reviewError || 'Finding 先进入草稿，逐条确认后才会创建 GitLab Discussion。'}</p>
                <div className="ra-empty-actions">
                  <button type="button" className="ra-btn primary" onClick={() => void startReview(attachment ? 'selection' : 'all')} disabled={files.length === 0 && !attachment && !selection}><Play size={14} />开始 Review</button>
                  {savedSession && <button type="button" className="ra-btn" onClick={() => void resumeSession()}><RefreshCw size={14} />恢复上次 Review</button>}
                </div>
                {savedSession && <p className="ra-session-meta">上次会话：{savedSession.findings.length} Findings · {savedSession.status} · {new Date(savedSession.updatedAt).toLocaleString()}</p>}
              </div>
            )}
            {(reviewStatus === 'preparing' || reviewStatus === 'running' || reviewStatus === 'normalizing') && <div className="ra-progress-card"><div className="ra-progress-head"><strong>{reviewStatus === 'preparing' ? '准备上下文' : reviewStatus === 'running' ? '分析真实 Diff' : '校验与定位'}</strong><span className="ra-badge info">进行中</span></div><div className="ra-progress-track"><div className="ra-progress-fill" style={{ width: reviewStatus === 'running' ? '55%' : reviewStatus === 'normalizing' ? '85%' : '20%' }} /></div><button type="button" className="ra-btn danger" onClick={cancelReview}><Square size={13} />取消</button></div>}
            {reviewStatus === 'completed' && <><div className="ra-result-summary"><div className="ra-summary-item"><strong>{findings.length}</strong><span>Findings</span></div><div className="ra-summary-item"><strong>{findings.filter((item) => item.severity === 'high' || item.severity === 'critical').length}</strong><span>High+</span></div><div className="ra-summary-item"><strong>{findings.filter((item) => item.status === 'published').length}</strong><span>已发布</span></div><div className="ra-summary-item"><strong>{findings.filter((item) => item.status === 'ignored').length}</strong><span>已忽略</span></div></div><div className="ra-finding-list">{findings.slice(0, visibleFindingCount).map((finding) => <FindingCard key={finding.id} finding={finding} expanded={expandedFinding === finding.id} publishDisabled={!mrContext || publishing || finding.anchor?.publishable === false} onToggle={() => setExpandedFinding((current) => current === finding.id ? '' : finding.id)} onLocate={() => locateFinding(finding)} onCopy={() => { void navigator.clipboard?.writeText(finding.comment); setToast('评论草稿已复制'); }} onPublish={() => { setPublishFinding(finding); setPublishBody(finding.comment); }} onEdit={(edit) => editFinding(finding.id, edit)} onIgnore={() => ignoreFinding(finding.id)} />)}</div>{findings.length > visibleFindingCount && <button type="button" className="ra-btn" style={{ width: '100%', marginTop: 8 }} onClick={() => setVisibleFindingCount((count) => count + 20)}>显示更多（还有 {findings.length - visibleFindingCount} 个）</button>}</>}
          </div>}

          {activeTab === 'settings' && <div className="ra-settings-view">
            <h3 className="ra-section-title">模型提供商</h3>
            <div className="ra-provider-tabs">
              {(Object.entries(providerPresets) as [string, typeof providerPresets.openai][]).map(([key, preset]) => (
                <button
                  key={key}
                  type="button"
                  className={`ra-provider-tab${settings.provider === key ? ' active' : ''}`}
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
            <div className="ra-settings-grid">
              <div className="ra-field"><label htmlFor="model-url">Base URL</label><input id="model-url" value={settings.modelBaseUrl} onChange={(event) => setSettings({ ...settings, modelBaseUrl: event.target.value })} placeholder={providerPresets[settings.provider].defaultBaseUrl} /></div>
              <div className="ra-field"><label htmlFor="model-name">模型</label><input id="model-name" value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} placeholder={providerPresets[settings.provider].defaultModel} /></div>
              <div className="ra-field"><label htmlFor="api-key">API Key</label><input id="api-key" type="password" value={settings.apiKey} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} autoComplete="off" placeholder={providerPresets[settings.provider].placeholderKey} /></div>
              <div className="ra-field"><label htmlFor="gitlab-token">GitLab PAT（可选）</label><input id="gitlab-token" type="password" value={settings.gitlabToken} onChange={(event) => setSettings({ ...settings, gitlabToken: event.target.value })} autoComplete="off" /></div>
              <div className="ra-field"><label htmlFor="effort">审查强度</label><select id="effort" value={settings.effort} onChange={(event) => setSettings({ ...settings, effort: event.target.value as RuntimeSettings['effort'] })}><option value="fast">fast</option><option value="balanced">balanced</option><option value="thorough">thorough</option></select></div>
              <div className="ra-field"><label htmlFor="language">输出语言</label><select id="language" value={settings.language} onChange={(event) => setSettings({ ...settings, language: event.target.value as RuntimeSettings['language'] })}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></div>
            </div>

            <h4 style={{ margin: '12px 0 6px', fontSize: 11, color: '#4d5b70' }}>认证模式</h4>
            <div className="ra-settings-grid">
              <div className="ra-field">
                <label htmlFor="auth-mode">Auth Mode</label>
                <select id="auth-mode" value={settings.auth?.mode ?? 'bearer'} onChange={(e) => setSettings({ ...settings, auth: { ...settings.auth, mode: e.target.value as RuntimeSettings['auth']['mode'] } })}>
                  <option value="bearer">Bearer Token</option>
                  <option value="api-key-header">API Key Header</option>
                  <option value="query-param">Query Parameter</option>
                  <option value="custom">自定义 Header</option>
                </select>
              </div>
              {(settings.auth?.mode === 'api-key-header' || settings.auth?.mode === 'custom') && (
                <div className="ra-field">
                  <label htmlFor="auth-header-name">Header 名称</label>
                  <input id="auth-header-name" value={settings.auth?.apiKeyHeader ?? ''} onChange={(e) => setSettings({ ...settings, auth: { ...settings.auth, apiKeyHeader: e.target.value } })} placeholder="api-key" />
                </div>
              )}
              {settings.auth?.mode === 'query-param' && (
                <div className="ra-field">
                  <label htmlFor="auth-param-name">Query 参数名</label>
                  <input id="auth-param-name" value={settings.auth?.apiKeyQueryParam ?? ''} onChange={(e) => setSettings({ ...settings, auth: { ...settings.auth, apiKeyQueryParam: e.target.value } })} placeholder="key" />
                </div>
              )}
            </div>
            <div className="ra-modal-actions settings-actions"><button type="button" className="ra-btn danger" onClick={() => void clearSensitiveSettings().then(() => setSettings((current) => ({ ...current, apiKey: '', gitlabToken: '' })))}>清除密钥</button><button type="button" className="ra-btn" onClick={() => void runtime.testConnection().then(() => setToast('模型连接正常')).catch((error: unknown) => setToast(`模型连接失败：${String(error)}`))}>测试模型</button><button type="button" className="ra-btn primary" onClick={() => void saveSettings(settings).then(() => setToast('设置已保存'))}><Check size={14} />保存</button></div>
            <div className="ra-connection-list"><div className="ra-connection"><div className="ra-connection-title"><strong>GitLab API</strong><span className={`ra-badge ${mrContext ? 'success' : 'warning'}`}>{mrContext ? '已读取 MR' : '待连接'}</span></div><p>同源 REST API；可选 PAT。发布时携带当前页面 CSRF Token 和最新 diff refs。</p></div></div>

            <h3 className="ra-section-title" style={{ marginTop: 20 }}>Token 用量统计</h3>
            {usageSummary ? (
              <div className="ra-capability-box">
                <div className="ra-capability-row"><span>总调用次数</span><strong>{usageSummary.callCount}</strong></div>
                <div className="ra-capability-row"><span>输入 Tokens</span><strong>{formatTokenCount(usageSummary.totalInputTokens)}</strong></div>
                <div className="ra-capability-row"><span>输出 Tokens</span><strong>{formatTokenCount(usageSummary.totalOutputTokens)}</strong></div>
                <div className="ra-capability-row"><span>估算费用</span><strong>{formatCost(usageSummary.totalEstimatedCost)}</strong></div>
                {Object.entries(usageSummary.byModel).map(([key, data]) => (
                  <div key={key} className="ra-capability-row" style={{ fontSize: 9, opacity: 0.8 }}>
                    <span>{key}（{data.count} 次）</span>
                    <span>{formatTokenCount(data.inputTokens + data.outputTokens)} tok · {formatCost(data.estimatedCost)}</span>
                  </div>
                ))}
                <button type="button" className="ra-btn" style={{ marginTop: 6 }} onClick={() => { void clearUsage().then(() => { setUsageSummary(null); setToast('用量记录已清空'); }); }}>清空记录</button>
              </div>
            ) : (
              <p className="ra-section-copy">暂无用量记录。模型调用后会自动统计。</p>
            )}

            <h3 className="ra-section-title" style={{ marginTop: 20 }}><Package size={15} /> 规则包管理</h3>
            <p className="ra-section-copy">配置确定性规则检查包。未配置模型时，Review 将使用已启用的规则包。</p>

            <div className="ra-rule-pack-list">
              {rulePacks.map((pack) => (
                <div key={pack.id} className={`ra-rule-pack-item${pack.enabled ? '' : ' disabled'}`}>
                  <div className="ra-rule-pack-header">
                    <div className="ra-rule-pack-info">
                      <strong>{pack.name}</strong>
                      <span className="ra-badge neutral">v{pack.version}</span>
                      <span className="ra-badge neutral">{pack.rules.length} 条规则</span>
                      {pack.builtIn && <span className="ra-badge info">内置</span>}
                    </div>
                    <div className="ra-rule-pack-actions">
                      <button type="button" className="ra-icon-btn" title={pack.enabled ? '禁用' : '启用'} onClick={() => void toggleRulePack(pack.id)}>
                        {pack.enabled ? '✓' : '✗'}
                      </button>
                      <button type="button" className="ra-icon-btn" title="编辑" onClick={() => setEditingPackId(editingPackId === pack.id ? null : pack.id)}>
                        <FileText size={13} />
                      </button>
                      {!pack.builtIn && <>
                        <button type="button" className="ra-icon-btn" title="导出" onClick={() => handleExportPack(pack)}>
                          <Download size={13} />
                        </button>
                        <button type="button" className="ra-icon-btn" title="删除" onClick={() => void deleteRulePack(pack.id)}>
                          <Trash2 size={13} />
                        </button>
                      </>}
                    </div>
                  </div>
                  {pack.description && <p className="ra-rule-pack-desc">{pack.description}</p>}

                  {editingPackId === pack.id && (
                    <div className="ra-rule-pack-detail">
                      {!pack.builtIn && (
                        <div className="ra-settings-grid" style={{ marginBottom: 8 }}>
                          <div className="ra-field">
                            <label>名称</label>
                            <input value={pack.name} onChange={(e) => void updatePack({ ...pack, name: e.target.value })} />
                          </div>
                          <div className="ra-field">
                            <label>版本</label>
                            <input value={pack.version} onChange={(e) => void updatePack({ ...pack, version: e.target.value })} />
                          </div>
                          <div className="ra-field" style={{ gridColumn: '1 / -1' }}>
                            <label>描述</label>
                            <input value={pack.description ?? ''} onChange={(e) => void updatePack({ ...pack, description: e.target.value })} placeholder="可选描述" />
                          </div>
                        </div>
                      )}
                      {pack.rules.map((rule) => (
                        <div key={rule.id} className={`ra-rule-item${rule.enabled ? '' : ' disabled'}`}>
                          <div className="ra-rule-header">
                            <label className="ra-rule-toggle">
                              <input type="checkbox" checked={rule.enabled} onChange={() => void toggleRule(pack.id, rule.id)} />
                              <span className="ra-rule-title">{rule.title}</span>
                            </label>
                            <div className="ra-rule-badges">
                              <span className={`ra-badge ${rule.severity === 'high' || rule.severity === 'critical' ? 'error' : rule.severity === 'medium' ? 'warning' : 'neutral'}`}>{rule.severity}</span>
                              <span className="ra-badge neutral">{rule.category}</span>
                            </div>
                            {!pack.builtIn && (
                              <button type="button" className="ra-icon-btn" title="删除规则" onClick={() => void removeRuleFromPack(pack.id, rule.id)}>
                                <X size={12} />
                              </button>
                            )}
                          </div>
                          {rule.matchPatterns.length > 0 && (
                            <div className="ra-rule-patterns">
                              {rule.matchPatterns.map((pattern, idx) => (
                                <code key={idx} className="ra-rule-pattern">{pattern.pattern}</code>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                      {!pack.builtIn && (
                        <button type="button" className="ra-btn" style={{ marginTop: 6 }} onClick={() => void addRuleToPack(pack.id)}>
                          <Plus size={13} /> 添加规则
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="ra-rule-pack-footer">
              <button type="button" className="ra-btn" onClick={() => void createNewPack()}>
                <Plus size={13} /> 新建规则包
              </button>
              <div className="ra-import-section">
                <textarea
                  className="ra-import-textarea"
                  value={importText}
                  onChange={(e) => { setImportText(e.target.value); setImportError(''); }}
                  placeholder='粘贴规则包 JSON…'
                  rows={3}
                />
                {importError && <p className="ra-import-error">{importError}</p>}
                <button type="button" className="ra-btn" disabled={!importText.trim()} onClick={() => void handleImportPack()}>
                  <Upload size={13} /> 导入规则包
                </button>
              </div>
            </div>

            <h3 className="ra-section-title" style={{ marginTop: 20 }}><Package size={15} /> MCP 扩展工具</h3>
            <p className="ra-section-copy">连接本地 MCP server（Streamable HTTP），扩展 Agent 工具能力。仅支持 HTTP 传输，不支持 stdio。</p>
            <div className="ra-settings-grid">
              <div className="ra-field">
                <label htmlFor="mcp-enabled">启用 MCP</label>
                <select id="mcp-enabled" value={settings.mcp?.enabled ? 'on' : 'off'} onChange={(e) => setSettings({ ...settings, mcp: { ...settings.mcp, enabled: e.target.value === 'on' } })}>
                  <option value="off">关闭</option>
                  <option value="on">开启</option>
                </select>
              </div>
              <div className="ra-field">
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
            <div className="ra-connection-list" style={{ marginTop: 10 }}>
              <div className="ra-connection">
                <div className="ra-connection-title">
                  <strong>MCP 传输类型</strong>
                  <span className="ra-badge info">Streamable HTTP</span>
                </div>
                <p>浏览器油猴脚本仅支持 HTTP 传输（POST JSON-RPC）。不支持 stdio 本地进程。URL 以 /sse 结尾时自动使用 SSE 模式。</p>
              </div>
            </div>

            <h3 className="ra-section-title" style={{ marginTop: 20 }}>兼容性诊断</h3>
            {capabilities && <div className="ra-connection-list">
              <div className="ra-connection">
                <div className="ra-connection-title">
                  <strong>GitLab 实例状态</strong>
                  <span className={`ra-badge ${capabilities.authenticated ? 'success' : 'warning'}`}>{capabilities.gitlabVersion ?? '未知版本'}</span>
                </div>
                <div className="ra-capability-box">
                  <div className="ra-capability-row"><span>认证</span><span className={`ra-badge ${capabilities.authenticated ? 'success' : 'warning'}`}>{capabilities.authMode}</span></div>
                  <div className="ra-capability-row"><span>API 读取</span><span className={`ra-badge ${capabilities.canReadMergeRequests ? 'success' : 'error'}`}>{capabilities.canReadMergeRequests ? '可用' : '不可用'}</span></div>
                  <div className="ra-capability-row"><span>代码搜索</span><span className={`ra-badge ${capabilities.canSearchCode ? 'success' : 'neutral'}`}>{capabilities.canSearchCode ? '可用' : '不可用'}</span></div>
                  <div className="ra-capability-row"><span>评论发布</span><span className={`ra-badge ${capabilities.canCreateDiscussions ? 'success' : 'error'}`}>{capabilities.canCreateDiscussions ? '可用' : '不可用'}</span></div>
                  <div className="ra-capability-row"><span>CSRF Token</span><span className={`ra-badge ${capabilities.csrfAvailable ? 'success' : 'warning'}`}>{capabilities.csrfAvailable ? '存在' : '缺失'}</span></div>
                </div>
              </div>
            </div>}
            {capabilities?.warnings && capabilities.warnings.length > 0 && (
              <div className="ra-alert" role="alert" style={{ margin: '8px 0 0' }}>
                {capabilities.warnings.join(' ')}
              </div>
            )}
            {diagnostics.length > 0 && (
              <div className="ra-capability-box" style={{ marginTop: 8 }}>
                {diagnostics.map((diag, idx) => (
                  <div key={idx} className="ra-tool-event" style={{ fontSize: 9, opacity: 0.85 }}>
                    <span className="ra-tool-event-icon">{diag.level === 'error' ? '✗' : diag.level === 'warn' ? '⚠' : '·'}</span>
                    <span>[{diag.source}] {diag.message}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="ra-empty-actions" style={{ marginTop: 8 }}>
              <button type="button" className="ra-btn" onClick={() => {
                const config = exportSiteConfig(page, capabilities ?? {
                  authenticated: false, canReadMergeRequests: false, canCreateDiscussions: false,
                  canSearchCode: false, canReadRepository: true, canPaginateDiffs: true,
                  maxDiffPageSize: 100, authMode: 'none', domAvailable: true, csrfAvailable: true, warnings: [],
                }, settings as unknown as Record<string, unknown>);
                void navigator.clipboard?.writeText(config);
                setToast('站点配置已复制到剪贴板');
              }}><Download size={13} /> 导出配置</button>
            </div>
          </div>}
        </div>
      </aside>

      {selection && <SelectionToolbar state={selection} onAsk={() => { setAttachment(selection); setActiveTab('chat'); setPanelOpen(true); setDraft('请解释这段代码的潜在风险，并给出验证建议。'); setSelection(null); }} onReview={() => { setAttachment(selection); setSelection(null); void startReview('selection'); }} onCopy={() => { void navigator.clipboard?.writeText(selection.text); setToast('选中代码已复制'); setSelection(null); }} onClose={() => setSelection(null)} />}

      {publishFinding && <div className="ra-modal-backdrop" role="presentation"><section className="ra-modal" role="dialog" aria-modal="true" aria-labelledby="publish-title"><div className="ra-modal-header"><div><h2 id="publish-title">发布到 GitLab</h2><p>确认项目、MR、代码位置和 diff refs 后创建行级 Discussion。</p></div><button type="button" className="ra-icon-btn on-light" onClick={() => setPublishFinding(undefined)} aria-label="关闭发布确认"><X size={16} /></button></div><div className="ra-modal-body"><div className="ra-publish-target"><span>{page.projectPath} · MR !{page.mergeRequestIid}</span><ExternalLink size={13} /></div><div className="ra-publish-target"><span>{publishFinding.path}:{publishFinding.line}-{publishFinding.endLine} · {publishFinding.side}</span><span>head {mrContext?.diffRefs.headSha.slice(0, 8)}</span></div><div className="ra-field"><label htmlFor="publish-body">评论内容</label><textarea id="publish-body" value={publishBody} onChange={(event) => setPublishBody(event.target.value)} /></div></div><div className="ra-modal-actions"><button type="button" className="ra-btn" onClick={() => setPublishFinding(undefined)}>返回修改</button><button type="button" className="ra-btn primary" onClick={() => void confirmPublish()} disabled={publishing || !publishBody.trim()}><MessageSquare size={14} />{publishing ? '发布中…' : '确认发布'}</button></div></section></div>}
      {toast && <div className="ra-toast" role="status">{toast}</div>}
    </div>
  );
}
