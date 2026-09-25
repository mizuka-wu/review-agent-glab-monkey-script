import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Copy,
  ExternalLink,
  FileCode2,
  Filter,
  GitCommitHorizontal,
  GitMerge,
  Info,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  MousePointer2,
  PanelRight,
  Paperclip,
  Play,
  RefreshCw,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Wifi,
  X,
} from 'lucide-react';
import { FindingCard } from './prototype/components/FindingCard';
import { SelectionToolbar } from './prototype/components/SelectionToolbar';
import {
  chatSuggestions,
  fileDiff,
  findings as initialFindings,
  initialMessages,
  reviewStages,
  toolTrace,
} from './prototype/data';
import type {
  ChatMessage,
  Finding,
  PanelTab,
  ReviewStatus,
  RuntimeMode,
  SelectionContext,
  ToolbarState,
} from './prototype/types';

const filePath = 'src/checkout.ts';
const initialDraft = '请解释这段代码的潜在风险，并给出验证建议。';

export default function App() {
  const codeRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<number[]>([]);
  const [activeTab, setActiveTab] = useState<PanelTab>('chat');
  const [panelOpen, setPanelOpen] = useState(true);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [attachment, setAttachment] = useState<SelectionContext | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [responding, setResponding] = useState(false);
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>('idle');
  const [reviewScope, setReviewScope] = useState<'all' | 'selection'>('all');
  const [progress, setProgress] = useState(0);
  const [findingState, setFindingState] = useState<Finding[]>(initialFindings);
  const [expandedFinding, setExpandedFinding] = useState(initialFindings[0].id);
  const [publishFinding, setPublishFinding] = useState<Finding | null>(null);
  const [publishBody, setPublishBody] = useState('');
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>('browser');
  const [highlightLine, setHighlightLine] = useState<number | null>(null);
  const [toast, setToast] = useState('');

  const schedule = (callback: () => void, delay: number) => {
    timersRef.current.push(window.setTimeout(callback, delay));
  };

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const publishedCount = useMemo(
    () => findingState.filter((finding) => finding.status === 'published').length,
    [findingState],
  );

  const ignoredCount = useMemo(
    () => findingState.filter((finding) => finding.status === 'ignored').length,
    [findingState],
  );

  const openToolbarFromRange = (range: Range) => {
    const text = range.toString().trim();
    if (!text) {
      setToolbar(null);
      return;
    }

    const startElement = range.startContainer.parentElement?.closest<HTMLElement>('.ra-diff-row');
    const endElement = range.endContainer.parentElement?.closest<HTMLElement>('.ra-diff-row');
    const startLine = Number(startElement?.dataset.line ?? 28);
    const endLine = Number(endElement?.dataset.line ?? startLine);
    const rect = range.getBoundingClientRect();
    const top = rect.top > 88 ? rect.top - 50 : rect.bottom + 10;
    const left = Math.min(Math.max(rect.left + rect.width / 2, 190), window.innerWidth - 190);

    setToolbar({
      top,
      left,
      filePath,
      startLine,
      endLine,
      text: text.slice(0, 3000),
    });
  };

  const handleSelection = () => {
    window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!codeRef.current?.contains(range.commonAncestorContainer)) return;
      openToolbarFromRange(range);
    }, 0);
  };

  const selectDemoRange = () => {
    const first = codeRef.current?.querySelector<HTMLElement>('[data-line="28"] .ra-line-code');
    const last = codeRef.current?.querySelector<HTMLElement>('[data-line="29"] .ra-line-code');
    if (!first?.firstChild || !last?.firstChild) return;

    const range = document.createRange();
    range.setStart(first.firstChild, 0);
    range.setEnd(last.firstChild, last.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    openToolbarFromRange(range);
  };

  const startChatFromSelection = () => {
    if (!toolbar) return;
    setAttachment(toolbar);
    setActiveTab('chat');
    setPanelOpen(true);
    setDraft(initialDraft);
    setToolbar(null);
  };

  const startReview = (scope: 'all' | 'selection') => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
    setReviewScope(scope);
    setActiveTab('review');
    setPanelOpen(true);
    setReviewStatus('preparing');
    setProgress(16);

    schedule(() => {
      setReviewStatus('running');
      setProgress(48);
    }, 650);
    schedule(() => {
      setReviewStatus('normalizing');
      setProgress(82);
    }, 1550);
    schedule(() => {
      setReviewStatus('completed');
      setProgress(100);
    }, 2350);
  };

  const startReviewFromSelection = () => {
    if (!toolbar) return;
    setAttachment(toolbar);
    setToolbar(null);
    startReview('selection');
  };

  const copySelection = () => {
    if (!toolbar) return;
    void navigator.clipboard?.writeText(toolbar.text).catch(() => undefined);
    setToast('选中代码已复制');
    setToolbar(null);
  };

  const sendChat = (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || responding) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      attachment: attachment ?? undefined,
    };
    setMessages((current) => [...current, userMessage]);
    setDraft('');
    setResponding(true);

    schedule(() => {
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content:
            '这段变更的主要风险是库存状态和支付状态没有形成原子边界。建议先验证 reservation.hold() 的幂等性，再用“支付失败 / 重复回调 / 并发下单”三组测试确认补偿路径。当前原型只使用选中片段和 MR 摘要，连接本地 Agent 后可以继续读取 inventory 服务和调用点。',
        },
      ]);
      setResponding(false);
    }, 720);
  };

  const cancelReview = () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
    setReviewStatus('cancelled');
    setProgress(0);
    setToast('Review 已取消，未生成可发布草稿');
  };

  const copyComment = (finding: Finding) => {
    void navigator.clipboard?.writeText(finding.comment).catch(() => undefined);
    setToast('评论草稿已复制');
  };

  const locateFinding = (finding: Finding) => {
    setHighlightLine(finding.line);
    codeRef.current
      ?.querySelector(`[data-line="${finding.line}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setToast(`已定位到 ${finding.path}:${finding.line}`);
  };

  const openPublish = (finding: Finding) => {
    setPublishFinding(finding);
    setPublishBody(finding.comment);
  };

  const confirmPublish = () => {
    if (!publishFinding) return;
    setFindingState((current) =>
      current.map((finding) =>
        finding.id === publishFinding.id ? { ...finding, status: 'published' } : finding,
      ),
    );
    setPublishFinding(null);
    setToast('评论已发布到 MR !248');
  };

  const ignoreFinding = (finding: Finding) => {
    setFindingState((current) =>
      current.map((item) => (item.id === finding.id ? { ...item, status: 'ignored' } : item)),
    );
    setToast('Finding 已忽略');
  };

  const statusBadge = (status: ReviewStatus) => {
    if (status === 'completed') return <span className="ra-badge success">已完成</span>;
    if (status === 'cancelled') return <span className="ra-badge warning">已取消</span>;
    if (status === 'idle') return <span className="ra-badge neutral">待开始</span>;
    return <span className="ra-badge info">进行中</span>;
  };

  return (
    <div className="ra-prototype" onKeyUp={(event) => event.key === 'Escape' && setToolbar(null)}>
      <header className="ra-topbar">
        <div className="ra-brand">
          <span className="ra-brand-mark">
            <GitMerge size={17} aria-hidden="true" />
          </span>
          <span className="ra-brand-copy">
            <strong>GitLab</strong>
            <span>Review workspace</span>
          </span>
        </div>
        <div className="ra-top-context">acme / commerce / checkout-service / Merge Requests / !248</div>
        <div className="ra-top-actions">
          <span className="ra-demo-banner ra-hide-mobile">
            <Info size={13} aria-hidden="true" />
            交互原型 · 不发送真实请求
          </span>
          <button
            type="button"
            className="ra-icon-btn"
            onClick={() => setPanelOpen((current) => !current)}
            title="打开或关闭 Review Agent"
            aria-label="打开或关闭 Review Agent"
          >
            <PanelRight size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="ra-shell">
        <aside className="ra-sidebar" aria-label="GitLab 导航">
          <div className="ra-nav-group">
            <p className="ra-nav-label">Project</p>
            <button type="button" className="ra-nav-item">
              <Info size={16} aria-hidden="true" />
              <span>项目概览</span>
            </button>
            <button type="button" className="ra-nav-item active">
              <GitMerge size={16} aria-hidden="true" />
              <span>Merge Requests</span>
              <span className="ra-count info">8</span>
            </button>
            <button type="button" className="ra-nav-item">
              <GitCommitHorizontal size={16} aria-hidden="true" />
              <span>Commits</span>
            </button>
            <button type="button" className="ra-nav-item">
              <FileCode2 size={16} aria-hidden="true" />
              <span>Repository</span>
            </button>
          </div>
          <div className="ra-nav-group">
            <p className="ra-nav-label">Review Agent</p>
            <button type="button" className="ra-nav-item" onClick={() => startReview('all')}>
              <Sparkles size={16} aria-hidden="true" />
              <span>Review MR</span>
            </button>
            <button
              type="button"
              className="ra-nav-item"
              onClick={() => {
                setActiveTab('settings');
                setPanelOpen(true);
              }}
            >
              <Settings size={16} aria-hidden="true" />
              <span>连接与能力</span>
            </button>
          </div>
        </aside>

        <main className="ra-main">
          <div className="ra-breadcrumb">
            <span>acme</span>
            <ChevronRight size={11} aria-hidden="true" />
            <span>commerce</span>
            <ChevronRight size={11} aria-hidden="true" />
            <strong>checkout-service</strong>
            <ChevronRight size={11} aria-hidden="true" />
            <span>Merge Requests</span>
            <ChevronRight size={11} aria-hidden="true" />
            <strong>!248</strong>
          </div>

          <div className="ra-title-row">
            <div className="ra-title-copy">
              <h1>Refactor checkout inventory reservation</h1>
              <p>将库存预留改为显式 hold / confirm 生命周期，并补齐支付失败补偿路径。</p>
            </div>
            <div className="ra-actions">
              <button type="button" className="ra-btn" onClick={selectDemoRange} title="选中示例代码">
                <MousePointer2 size={14} aria-hidden="true" />
                选中示例
              </button>
              <button type="button" className="ra-btn primary" onClick={() => startReview('all')}>
                <Sparkles size={14} aria-hidden="true" />
                开始 Review
              </button>
            </div>
          </div>

          <div className="ra-meta-strip">
            <span>
              <GitMerge size={13} aria-hidden="true" /> feature/checkout-reservation
            </span>
            <span>into main</span>
            <span>
              <ShieldCheck size={13} aria-hidden="true" /> No conflicts
            </span>
            <span>14 files changed</span>
          </div>

          <div className="ra-tabs" role="tablist" aria-label="Merge request views">
            <button type="button" className="ra-tab active" role="tab" aria-selected="true">
              <FileCode2 size={14} aria-hidden="true" /> Changes <span className="ra-count neutral">14</span>
            </button>
            <button type="button" className="ra-tab" role="tab" aria-selected="false">
              <GitCommitHorizontal size={14} aria-hidden="true" /> Commits <span className="ra-count neutral">3</span>
            </button>
            <button type="button" className="ra-tab" role="tab" aria-selected="false">
              <ListChecks size={14} aria-hidden="true" /> Checks <span className="ra-count success">6</span>
            </button>
          </div>

          <section className="ra-file-card" aria-label="Diff for src/checkout.ts">
            <div className="ra-file-header">
              <div className="ra-file-path">
                <FileCode2 size={15} aria-hidden="true" />
                <span>src/checkout.ts</span>
              </div>
              <div className="ra-file-stats">
                <span className="plus">+7</span>
                <span className="minus">-1</span>
                <button type="button" className="ra-icon-btn on-light" title="文件操作" aria-label="文件操作">
                  <Filter size={14} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="ra-diff" ref={codeRef} onMouseUp={handleSelection} onKeyUp={handleSelection}>
              {fileDiff.map((line) => {
                const lineNo = line.newLine ?? line.oldLine ?? 0;
                const isHighlighted = highlightLine === lineNo;
                return (
                  <div
                    className={`ra-diff-row ${line.kind}`}
                    data-line={lineNo}
                    key={`${line.oldLine ?? 'x'}-${line.newLine ?? 'x'}-${line.text}`}
                    style={isHighlighted ? { boxShadow: 'inset 4px 0 0 #2f6fed' } : undefined}
                  >
                    <span className="ra-line-number">{line.oldLine ?? ''}</span>
                    <span className="ra-line-number">{line.newLine ?? ''}</span>
                    <span className="ra-line-sign">
                      {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
                    </span>
                    <code className="ra-line-code">{line.text || ' '}</code>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="ra-review-note">
            <Info size={16} aria-hidden="true" />
            <span>
              当前原型只展示一个代表性文件。生产实现会从 GitLab API 分页读取 MR Diff，并通过 Diff Refs 校验评论位置。
            </span>
          </div>
        </main>

        <aside className={`ra-agent-panel${panelOpen ? '' : ' closed'}`} aria-label="Review Agent">
          <div className="ra-panel-header">
            <div className="ra-panel-title">
              <div>
                <h2>
                  <Bot size={17} aria-hidden="true" /> Review Agent
                </h2>
                <p>{runtimeMode === 'browser' ? '浏览器直连模式 · 浅层上下文' : '本地 Agent · 仓库级上下文'}</p>
              </div>
              <button
                type="button"
                className="ra-icon-btn"
                onClick={() => setPanelOpen(false)}
                title="关闭侧栏"
                aria-label="关闭侧栏"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="ra-panel-tabs" role="tablist" aria-label="Review Agent views">
            <button
              type="button"
              className={`ra-panel-tab${activeTab === 'chat' ? ' active' : ''}`}
              onClick={() => setActiveTab('chat')}
              role="tab"
              aria-selected={activeTab === 'chat'}
            >
              <MessageSquare size={14} aria-hidden="true" /> 提问
            </button>
            <button
              type="button"
              className={`ra-panel-tab${activeTab === 'review' ? ' active' : ''}`}
              onClick={() => setActiveTab('review')}
              role="tab"
              aria-selected={activeTab === 'review'}
            >
              <Sparkles size={14} aria-hidden="true" /> Review
              {reviewStatus === 'completed' && <span className="ra-count error">3</span>}
            </button>
            <button
              type="button"
              className={`ra-panel-tab${activeTab === 'settings' ? ' active' : ''}`}
              onClick={() => setActiveTab('settings')}
              role="tab"
              aria-selected={activeTab === 'settings'}
            >
              <Settings size={14} aria-hidden="true" /> 设置
            </button>
          </div>

          <div className="ra-panel-body">
            {activeTab === 'chat' && (
              <div className="ra-chat">
                <div className="ra-messages" aria-live="polite">
                  {messages.map((message) => (
                    <div className={`ra-message ${message.role}`} key={message.id}>
                      <div className="ra-message-label">
                        {message.role === 'user' ? '你' : 'Review Agent'}
                      </div>
                      {message.attachment && (
                        <div className="ra-attachment">
                          <strong>{message.attachment.filePath}</strong>
                          <span>
                            L{message.attachment.startLine}-{message.attachment.endLine} · selection
                          </span>
                        </div>
                      )}
                      <div className="ra-message-body">{message.content}</div>
                    </div>
                  ))}

                  {responding && (
                    <div className="ra-message">
                      <div className="ra-message-label">Review Agent</div>
                      <div className="ra-message-body">
                        <LoaderCircle size={14} aria-hidden="true" /> 正在结合选中片段和 MR 上下文分析…
                      </div>
                    </div>
                  )}

                  {messages.length <= 1 && !responding && (
                    <div className="ra-suggestions" aria-label="推荐问题">
                      {chatSuggestions.map((suggestion) => (
                        <button
                          type="button"
                          className="ra-suggestion"
                          key={suggestion}
                          onClick={() => setDraft(suggestion)}
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <form className="ra-composer" onSubmit={sendChat}>
                  {attachment && (
                    <div className="ra-context-chip">
                      <span>
                        <Paperclip size={11} aria-hidden="true" /> {attachment.filePath}:L{attachment.startLine}-
                        {attachment.endLine}
                      </span>
                      <button
                        type="button"
                        className="ra-icon-btn on-light"
                        onClick={() => setAttachment(null)}
                        title="移除代码附件"
                        aria-label="移除代码附件"
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                  <div className="ra-composer-box">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder="询问选中代码或当前 MR…"
                      aria-label="提问内容"
                    />
                    <div className="ra-composer-actions">
                      <span className="ra-badge neutral">
                        {runtimeMode === 'browser' ? '浏览器上下文' : 'Agent 工具可用'}
                      </span>
                      <button type="submit" className="ra-btn primary" disabled={!draft.trim() || responding}>
                        <Send size={14} aria-hidden="true" /> 发送
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            )}

            {activeTab === 'review' && (
              <div className="ra-review-view">
                <h3 className="ra-section-title">Review 范围</h3>
                <p className="ra-section-copy">
                  确定性上下文构建负责筛选和预算，Agent 只处理分析与结构化输出。
                </p>

                <div className="ra-segmented" aria-label="Review 范围">
                  <button
                    type="button"
                    className={reviewScope === 'all' ? 'active' : ''}
                    onClick={() => setReviewScope('all')}
                  >
                    全部变更 · 14 文件
                  </button>
                  <button
                    type="button"
                    className={reviewScope === 'selection' ? 'active' : ''}
                    onClick={() => setReviewScope('selection')}
                  >
                    选中代码
                  </button>
                </div>

                {reviewStatus === 'idle' && (
                  <div className="ra-empty-card">
                    <h3 className="ra-section-title">准备开始</h3>
                    <p className="ra-section-copy">
                      将读取 MR 元数据、Diff Refs 和变更文件。生成的评论只进入草稿，不会自动发布。
                    </p>
                    <button type="button" className="ra-btn primary" onClick={() => startReview(reviewScope)}>
                      <Play size={14} aria-hidden="true" /> 开始 Review
                    </button>
                  </div>
                )}

                {reviewStatus === 'cancelled' && (
                  <div className="ra-empty-card">
                    <h3 className="ra-section-title">任务已取消</h3>
                    <p className="ra-section-copy">已完成的临时结果不会进入发布队列。</p>
                    <button type="button" className="ra-btn" onClick={() => startReview(reviewScope)}>
                      <RefreshCw size={14} aria-hidden="true" /> 重新运行
                    </button>
                  </div>
                )}

                {(reviewStatus === 'preparing' ||
                  reviewStatus === 'running' ||
                  reviewStatus === 'normalizing') && (
                  <div className="ra-progress-card">
                    <div className="ra-progress-head">
                      <strong>
                        {reviewStatus === 'preparing'
                          ? '准备上下文'
                          : reviewStatus === 'running'
                            ? '分析变更'
                            : '校验与定位'}
                      </strong>
                      {statusBadge(reviewStatus)}
                    </div>
                    <div className="ra-progress-track" aria-label={`Review 进度 ${progress}%`}>
                      <div className="ra-progress-fill" style={{ width: `${progress}%` }} />
                    </div>

                    <div className="ra-stage-list">
                      {reviewStages.map((stage, index) => {
                        const currentIndex = reviewStages.findIndex((item) => item.key === reviewStatus);
                        const stateClass = index < currentIndex ? 'done' : index === currentIndex ? 'current' : '';
                        return (
                          <div className={`ra-stage-row ${stateClass}`} key={stage.key}>
                            {index < currentIndex ? (
                              <CheckCircle2 size={13} aria-hidden="true" />
                            ) : index === currentIndex ? (
                              <LoaderCircle size={13} aria-hidden="true" />
                            ) : (
                              <Circle size={13} aria-hidden="true" />
                            )}
                            <span>{stage.label}</span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="ra-tool-trace">
                      {toolTrace.slice(0, reviewStatus === 'preparing' ? 1 : 3).map((item) => (
                        <div className="ra-tool-row" key={item.tool + item.detail}>
                          <span>
                            {item.tool} · {item.detail}
                          </span>
                          <span>{item.time}</span>
                        </div>
                      ))}
                    </div>

                    <button type="button" className="ra-btn danger" onClick={cancelReview}>
                      <Square size={13} aria-hidden="true" /> 取消
                    </button>
                  </div>
                )}

                {reviewStatus === 'completed' && (
                  <>
                    <div className="ra-result-summary" aria-label="Review 结果摘要">
                      <div className="ra-summary-item">
                        <strong>{findingState.length}</strong>
                        <span>Findings</span>
                      </div>
                      <div className="ra-summary-item">
                        <strong>{findingState.filter((item) => item.severity === 'high').length}</strong>
                        <span>High</span>
                      </div>
                      <div className="ra-summary-item">
                        <strong>{publishedCount}</strong>
                        <span>已发布</span>
                      </div>
                      <div className="ra-summary-item">
                        <strong>{ignoredCount}</strong>
                        <span>已忽略</span>
                      </div>
                    </div>

                    <div className="ra-finding-list">
                      {findingState.map((finding) => (
                        <FindingCard
                          key={finding.id}
                          finding={finding}
                          expanded={expandedFinding === finding.id}
                          onToggle={() =>
                            setExpandedFinding((current) => (current === finding.id ? '' : finding.id))
                          }
                          onLocate={() => locateFinding(finding)}
                          onCopy={() => copyComment(finding)}
                          onPublish={() => openPublish(finding)}
                          onIgnore={() => ignoreFinding(finding)}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {activeTab === 'settings' && (
              <div className="ra-settings-view">
                <h3 className="ra-section-title">运行模式</h3>
                <p className="ra-section-copy">模式决定模型密钥、仓库工具和长任务由谁负责。</p>
                <div className="ra-segmented" aria-label="运行模式">
                  <button
                    type="button"
                    className={runtimeMode === 'browser' ? 'active' : ''}
                    onClick={() => setRuntimeMode('browser')}
                  >
                    浏览器直连
                  </button>
                  <button
                    type="button"
                    className={runtimeMode === 'gateway' ? 'active' : ''}
                    onClick={() => setRuntimeMode('gateway')}
                  >
                    本地 Agent
                  </button>
                </div>

                <div className="ra-connection-list">
                  <div className="ra-connection">
                    <div className="ra-connection-title">
                      <strong>浏览器运行时</strong>
                      <span className="ra-badge success">
                        <Wifi size={11} aria-hidden="true" /> 可用
                      </span>
                    </div>
                    <p>页面注入、划词、UI 状态和本地草稿均可直接工作。</p>
                  </div>

                  <div className="ra-connection">
                    <div className="ra-connection-title">
                      <strong>GitLab API</strong>
                      <span className="ra-badge success">full</span>
                    </div>
                    <p>可读取 MR / Diff / File，并支持确认后创建 Discussion。</p>
                  </div>

                  <div className="ra-connection">
                    <div className="ra-connection-title">
                      <strong>{runtimeMode === 'gateway' ? '本地 Agent Gateway' : '模型连接'}</strong>
                      <span className={`ra-badge ${runtimeMode === 'gateway' ? 'success' : 'info'}`}>
                        <Server size={11} aria-hidden="true" />{' '}
                        {runtimeMode === 'gateway' ? '已连接' : 'OpenAI-compatible'}
                      </span>
                    </div>
                    <p>
                      {runtimeMode === 'gateway'
                        ? '127.0.0.1:4317 · 项目映射可用 · 命令执行已关闭'
                        : '适合划词问答和浅层 Review；密钥与仓库工具建议交给本地 Gateway。'}
                    </p>
                  </div>
                </div>

                <div className="ra-capability-box">
                  <h3 className="ra-section-title">当前能力</h3>
                  {[
                    ['划词问答', '支持', true],
                    ['当前 MR Diff Review', '支持', true],
                    ['跨文件符号搜索', runtimeMode === 'gateway' ? '支持' : '受限', runtimeMode === 'gateway'],
                    ['读取本地仓库历史', runtimeMode === 'gateway' ? '支持' : '需要本地', runtimeMode === 'gateway'],
                    ['运行测试 / lint', runtimeMode === 'gateway' ? '可配置' : '不支持', runtimeMode === 'gateway'],
                    ['发布 GitLab 评论', '需确认', true],
                  ].map(([label, value, enabled]) => (
                    <div className="ra-capability-row" key={String(label)}>
                      <span>{label}</span>
                      <span className={`ra-badge ${enabled ? 'success' : 'warning'}`}>{value}</span>
                    </div>
                  ))}
                </div>

                <button type="button" className="ra-btn" onClick={() => setToast('连接诊断正常')}>
                  <RefreshCw size={14} aria-hidden="true" /> 运行连接诊断
                </button>
              </div>
            )}
          </div>
        </aside>
      </div>

      {toolbar && (
        <SelectionToolbar
          state={toolbar}
          onAsk={startChatFromSelection}
          onReview={startReviewFromSelection}
          onCopy={copySelection}
          onClose={() => setToolbar(null)}
        />
      )}

      {publishFinding && (
        <div className="ra-modal-backdrop" role="presentation" onMouseDown={() => setPublishFinding(null)}>
          <section
            className="ra-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="publish-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="ra-modal-header">
              <div>
                <h2 id="publish-title">发布评论到 GitLab</h2>
                <p>请确认目标项目、MR 和代码位置。发布后会创建行级 Discussion。</p>
              </div>
              <button
                type="button"
                className="ra-icon-btn on-light"
                onClick={() => setPublishFinding(null)}
                title="关闭"
                aria-label="关闭发布确认"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="ra-modal-body">
              <div className="ra-publish-target">
                <span>acme/commerce/checkout-service · MR !248</span>
                <ExternalLink size={13} aria-hidden="true" />
              </div>
              <div className="ra-publish-target">
                <span>
                  {publishFinding.path}:{publishFinding.line}-{publishFinding.endLine}
                </span>
                <span>head_sha 8f2c1a</span>
              </div>
              <div className="ra-field">
                <label htmlFor="publish-body">评论内容</label>
                <textarea
                  id="publish-body"
                  value={publishBody}
                  onChange={(event) => setPublishBody(event.target.value)}
                />
              </div>
            </div>
            <div className="ra-modal-actions">
              <button type="button" className="ra-btn" onClick={() => setPublishFinding(null)}>
                返回修改
              </button>
              <button type="button" className="ra-btn primary" onClick={confirmPublish}>
                <MessageSquarePlus size={14} aria-hidden="true" /> 确认发布
              </button>
            </div>
          </section>
        </div>
      )}

      {toast && (
        <div className="ra-toast" role="status">
          <Check size={15} aria-hidden="true" /> {toast}
        </div>
      )}
    </div>
  );
}
