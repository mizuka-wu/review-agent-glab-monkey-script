import { Check, ChevronDown, ChevronRight, Copy, Crosshair, EyeOff, MessageSquarePlus } from 'lucide-react';
import type { Finding } from '../../core/types';

const severityLabel = { critical: '严重', high: '高', medium: '中', low: '低' };
const categoryLabel = { bug: '缺陷', security: '安全', performance: '性能', maintainability: '可维护性', test: '测试' };

interface FindingCardProps {
  finding: Finding;
  expanded: boolean;
  publishDisabled: boolean;
  onToggle: () => void;
  onLocate: () => void;
  onCopy: () => void;
  onPublish: () => void;
  onIgnore: () => void;
}

export function FindingCard({ finding, expanded, publishDisabled, onToggle, onLocate, onCopy, onPublish, onIgnore }: FindingCardProps) {
  return (
    <article className={`ra-finding severity-${finding.severity} status-${finding.status}`}>
      <button type="button" className="ra-finding-summary" onClick={onToggle} aria-expanded={expanded}>
        <div className="ra-finding-meta">
          <span className={`ra-severity ${finding.severity}`}>{severityLabel[finding.severity]}</span>
          <span className="ra-badge neutral">{categoryLabel[finding.category]}</span>
          <span className="ra-confidence">置信度 {finding.confidence === 'high' ? '高' : finding.confidence === 'medium' ? '中' : '低'}</span>
          {finding.anchor?.relocatedFromPath && <span className="ra-badge info">跨文件重定位</span>}
          {finding.anchor?.source === 'full-file' && <span className="ra-badge warning">完整文件锚定</span>}
          {finding.status === 'published' && <span className="ra-badge success">已发布</span>}
          {finding.status === 'ignored' && <span className="ra-badge neutral">已忽略</span>}
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        <h3>{finding.title}</h3>
        <code className="ra-finding-path">{finding.path}:{finding.line}-{finding.endLine} · {finding.source}</code>
      </button>
      {expanded && (
        <div className="ra-finding-detail">
          <p>{finding.content}</p>
          {finding.evidence.map((evidence) => (
            <div className="ra-evidence" key={`${evidence.path}-${evidence.lines}-${evidence.quote}`}>
              <strong>{evidence.path} · {evidence.lines}</strong>
              <span>{evidence.quote}</span>
            </div>
          ))}
          {finding.existingCode && (
            <div className="ra-code-change">
              <pre className="before">- {finding.existingCode}</pre>
              {finding.suggestionCode && <pre className="after">+ {finding.suggestionCode}</pre>}
            </div>
          )}
          <div className="ra-finding-actions">
            <button type="button" className="ra-btn" onClick={onLocate}><Crosshair size={14} />定位</button>
            <button type="button" className="ra-btn" onClick={onCopy}><Copy size={14} />复制评论</button>
            <button
              type="button"
              className="ra-btn primary"
              onClick={onPublish}
              disabled={publishDisabled || finding.status === 'published'}
              title={finding.anchor?.publishable === false ? '完整文件位置不能发布为 MR 行级 Discussion' : undefined}
            >
              {finding.status === 'published' ? <Check size={14} /> : <MessageSquarePlus size={14} />}
              {finding.status === 'published' ? '已发布' : '发布到 GitLab'}
            </button>
            <button type="button" className="ra-btn ghost" onClick={onIgnore} disabled={finding.status !== 'draft'}><EyeOff size={14} />忽略</button>
          </div>
        </div>
      )}
    </article>
  );
}
