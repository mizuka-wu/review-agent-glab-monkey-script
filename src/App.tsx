import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Check, ExternalLink, LoaderCircle, MessageSquare, Play, RefreshCw,
  Send, Settings, Sparkles, Square, X,
} from 'lucide-react';
import { FindingCard } from './components/review/FindingCard';
import { SelectionToolbar } from './components/review/SelectionToolbar';
import { GitLabAdapter, GitLabApiError, mergeRequestRefFromPage } from './core/gitlab-adapter';
import { OpenAIRuntime } from './core/openai-runtime';
import { ReviewEngine } from './core/review-engine';
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
  const [toast, setToast] = useState('');

  const runtime = useMemo(() => new OpenAIRuntime(settings), [settings]);
  const reviewEngine = useMemo(() => new ReviewEngine(runtime, settings), [runtime, settings]);
  const mergeRequestRef = useMemo(() => mergeRequestRefFromPage(page), [page]);
  const runtimeConfigured = runtime.configured;

  useEffect(() => {
    let active = true;
    void loadSettings().then((loaded) => {
      if (active) setSettings(loaded);
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
      adapter.listDiffs(mergeRequestRef),
    ]).then(([context, diffs]) => {
      if (controller.signal.aborted) return;
      setMrContext(context);
      setFiles(diffs);
      setLoading(false);
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
    try {
      const answer = await runtime.chat(history, attachment);
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: 'assistant', content: answer }]);
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
      if (result.warnings.length > 0) setToast(result.warnings[0]);
    } catch (error) {
      if (controller.signal.aborted || (error as Error).name === 'AbortError') return;
      setReviewError(error instanceof Error ? error.message : String(error));
      setReviewStatus('failed');
    }
  };

  const cancelReview = () => {
    reviewAbort.current?.abort();
    setReviewStatus('cancelled');
    setReviewError('运行已取消。未完成结果不会进入发布队列。');
  };

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
      setFindings((current) => current.map((finding) =>
        finding.id === publishFinding.id ? { ...finding, status: 'published' } : finding,
      ));
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
              {responding && <div className="ra-message"><div className="ra-message-label">Review Agent</div><div className="ra-message-body"><LoaderCircle size={14} /> 正在调用模型服务…</div></div>}
            </div>
            <form className="ra-composer" onSubmit={sendChat}>
              {attachment && <div className="ra-context-chip"><span>{attachment.filePath}:L{attachment.startLine}-{attachment.endLine}</span><button type="button" className="ra-icon-btn on-light" onClick={() => setAttachment(undefined)} aria-label="移除代码附件"><X size={13} /></button></div>}
              <div className="ra-composer-box"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="询问当前 MR 或选中代码…" aria-label="提问内容" /><div className="ra-composer-actions"><span className="ra-badge neutral">{runtimeConfigured ? settings.model : '规则模式'}</span><button type="submit" className="ra-btn primary" disabled={!draft.trim() || responding}><Send size={14} />发送</button></div></div>
            </form>
          </div>}

          {activeTab === 'review' && <div className="ra-review-view">
            <h3 className="ra-section-title">Review 范围</h3>
            <p className="ra-section-copy">{files.length > 0 ? `已从 GitLab API 读取 ${files.length} 个文件的真实 Diff。` : '当前页面没有可用的 MR Diff；仍可 Review 已选中的代码。'}</p>
            {(reviewStatus === 'idle' || reviewStatus === 'cancelled' || reviewStatus === 'failed') && <div className="ra-empty-card"><h3>{reviewStatus === 'cancelled' ? '任务已取消' : reviewStatus === 'failed' ? 'Review 失败' : '准备开始'}</h3><p>{reviewError || 'Finding 先进入草稿，逐条确认后才会创建 GitLab Discussion。'}</p><button type="button" className="ra-btn primary" onClick={() => void startReview(attachment ? 'selection' : 'all')} disabled={files.length === 0 && !attachment && !selection}><Play size={14} />开始 Review</button></div>}
            {(reviewStatus === 'preparing' || reviewStatus === 'running' || reviewStatus === 'normalizing') && <div className="ra-progress-card"><div className="ra-progress-head"><strong>{reviewStatus === 'preparing' ? '准备上下文' : reviewStatus === 'running' ? '分析真实 Diff' : '校验与定位'}</strong><span className="ra-badge info">进行中</span></div><div className="ra-progress-track"><div className="ra-progress-fill" style={{ width: reviewStatus === 'running' ? '55%' : reviewStatus === 'normalizing' ? '85%' : '20%' }} /></div><button type="button" className="ra-btn danger" onClick={cancelReview}><Square size={13} />取消</button></div>}
            {reviewStatus === 'completed' && <><div className="ra-result-summary"><div className="ra-summary-item"><strong>{findings.length}</strong><span>Findings</span></div><div className="ra-summary-item"><strong>{findings.filter((item) => item.severity === 'high' || item.severity === 'critical').length}</strong><span>High+</span></div><div className="ra-summary-item"><strong>{findings.filter((item) => item.status === 'published').length}</strong><span>已发布</span></div><div className="ra-summary-item"><strong>{findings.filter((item) => item.status === 'ignored').length}</strong><span>已忽略</span></div></div><div className="ra-finding-list">{findings.map((finding) => <FindingCard key={finding.id} finding={finding} expanded={expandedFinding === finding.id} publishDisabled={!mrContext || publishing || finding.anchor?.publishable === false} onToggle={() => setExpandedFinding((current) => current === finding.id ? '' : finding.id)} onLocate={() => locateFinding(finding)} onCopy={() => { void navigator.clipboard?.writeText(finding.comment); setToast('评论草稿已复制'); }} onPublish={() => { setPublishFinding(finding); setPublishBody(finding.comment); }} onIgnore={() => setFindings((current) => current.map((item) => item.id === finding.id ? { ...item, status: 'ignored' } : item))} />)}</div></>}
          </div>}

          {activeTab === 'settings' && <div className="ra-settings-view">
            <h3 className="ra-section-title">OpenAI-compatible 模型</h3>
            <div className="ra-settings-grid">
              <div className="ra-field"><label htmlFor="model-url">Base URL</label><input id="model-url" value={settings.modelBaseUrl} onChange={(event) => setSettings({ ...settings, modelBaseUrl: event.target.value })} /></div>
              <div className="ra-field"><label htmlFor="model-name">模型</label><input id="model-name" value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} /></div>
              <div className="ra-field"><label htmlFor="api-key">API Key</label><input id="api-key" type="password" value={settings.apiKey} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} autoComplete="off" /></div>
              <div className="ra-field"><label htmlFor="gitlab-token">GitLab PAT（可选）</label><input id="gitlab-token" type="password" value={settings.gitlabToken} onChange={(event) => setSettings({ ...settings, gitlabToken: event.target.value })} autoComplete="off" /></div>
              <div className="ra-field"><label htmlFor="effort">审查强度</label><select id="effort" value={settings.effort} onChange={(event) => setSettings({ ...settings, effort: event.target.value as RuntimeSettings['effort'] })}><option value="fast">fast</option><option value="balanced">balanced</option><option value="thorough">thorough</option></select></div>
              <div className="ra-field"><label htmlFor="language">输出语言</label><select id="language" value={settings.language} onChange={(event) => setSettings({ ...settings, language: event.target.value as RuntimeSettings['language'] })}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></div>
            </div>
            <div className="ra-modal-actions settings-actions"><button type="button" className="ra-btn danger" onClick={() => void clearSensitiveSettings().then(() => setSettings((current) => ({ ...current, apiKey: '', gitlabToken: '' })))}>清除密钥</button><button type="button" className="ra-btn" onClick={() => void runtime.testConnection().then(() => setToast('模型连接正常')).catch((error: unknown) => setToast(`模型连接失败：${String(error)}`))}>测试模型</button><button type="button" className="ra-btn primary" onClick={() => void saveSettings(settings).then(() => setToast('设置已保存'))}><Check size={14} />保存</button></div>
            <div className="ra-connection-list"><div className="ra-connection"><div className="ra-connection-title"><strong>GitLab API</strong><span className={`ra-badge ${mrContext ? 'success' : 'warning'}`}>{mrContext ? '已读取 MR' : '待连接'}</span></div><p>同源 REST API；可选 PAT。发布时携带当前页面 CSRF Token 和最新 diff refs。</p></div></div>
          </div>}
        </div>
      </aside>

      {selection && <SelectionToolbar state={selection} onAsk={() => { setAttachment(selection); setActiveTab('chat'); setPanelOpen(true); setDraft('请解释这段代码的潜在风险，并给出验证建议。'); setSelection(null); }} onReview={() => { setAttachment(selection); setSelection(null); void startReview('selection'); }} onCopy={() => { void navigator.clipboard?.writeText(selection.text); setToast('选中代码已复制'); setSelection(null); }} onClose={() => setSelection(null)} />}

      {publishFinding && <div className="ra-modal-backdrop" role="presentation"><section className="ra-modal" role="dialog" aria-modal="true" aria-labelledby="publish-title"><div className="ra-modal-header"><div><h2 id="publish-title">发布到 GitLab</h2><p>确认项目、MR、代码位置和 diff refs 后创建行级 Discussion。</p></div><button type="button" className="ra-icon-btn on-light" onClick={() => setPublishFinding(undefined)} aria-label="关闭发布确认"><X size={16} /></button></div><div className="ra-modal-body"><div className="ra-publish-target"><span>{page.projectPath} · MR !{page.mergeRequestIid}</span><ExternalLink size={13} /></div><div className="ra-publish-target"><span>{publishFinding.path}:{publishFinding.line}-{publishFinding.endLine} · {publishFinding.side}</span><span>head {mrContext?.diffRefs.headSha.slice(0, 8)}</span></div><div className="ra-field"><label htmlFor="publish-body">评论内容</label><textarea id="publish-body" value={publishBody} onChange={(event) => setPublishBody(event.target.value)} /></div></div><div className="ra-modal-actions"><button type="button" className="ra-btn" onClick={() => setPublishFinding(undefined)}>返回修改</button><button type="button" className="ra-btn primary" onClick={() => void confirmPublish()} disabled={publishing || !publishBody.trim()}><MessageSquare size={14} />{publishing ? '发布中…' : '确认发布'}</button></div></section></div>}
      {toast && <div className="ra-toast" role="status">{toast}</div>}
    </div>
  );
}
