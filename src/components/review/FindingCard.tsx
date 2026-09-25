import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Crosshair,
  Edit3,
  EyeOff,
  MessageSquarePlus,
  Save,
  X,
} from 'lucide-react';
import { findingEditableFields, type FindingEdit } from '../../core/finding-edit';
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
  onEdit: (edit: FindingEdit) => void;
}

export function FindingCard({
  finding,
  expanded,
  publishDisabled,
  onToggle,
  onLocate,
  onCopy,
  onPublish,
  onIgnore,
  onEdit,
}: FindingCardProps) {
  const [edit, setEdit] = useState<FindingEdit | undefined>();
  const editInvalid = !edit?.title.trim() || !edit?.content.trim() || !edit?.comment.trim();

  const startEdit = () => setEdit(findingEditableFields(finding));
  const saveEdit = () => {
    if (!edit || editInvalid) return;
    onEdit(edit);
    setEdit(undefined);
  };

  return (
    <article className={`ra-finding severity-${finding.severity} status-${finding.status}`}>
      <button type="button" className="ra-finding-summary" onClick={onToggle} aria-expanded={expanded}>
        <div className="ra-finding-meta">
          <span className={`ra-severity ${finding.severity}`}>{severityLabel[finding.severity]}</span>
          <span className="ra-badge neutral">{categoryLabel[finding.category]}</span>
          <span className="ra-confidence">置信度 {finding.confidence === 'high' ? '高' : finding.confidence === 'medium' ? '中' : '低'}</span>
          {finding.edited && <span className="ra-badge info">已编辑</span>}
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
          {edit ? (
            <div className="ra-finding-editor">
              <div className="ra-field"><label htmlFor={`finding-title-${finding.id}`}>标题</label><input id={`finding-title-${finding.id}`} value={edit.title} onChange={(event) => setEdit({ ...edit, title: event.target.value })} /></div>
              <div className="ra-field"><label htmlFor={`finding-content-${finding.id}`}>说明</label><textarea id={`finding-content-${finding.id}`} value={edit.content} onChange={(event) => setEdit({ ...edit, content: event.target.value })} /></div>
              <div className="ra-field"><label htmlFor={`finding-comment-${finding.id}`}>评论草稿</label><textarea id={`finding-comment-${finding.id}`} value={edit.comment} onChange={(event) => setEdit({ ...edit, comment: event.target.value })} /></div>
              <div className="ra-editor-grid">
                <div className="ra-field"><label htmlFor={`finding-category-${finding.id}`}>分类</label><select id={`finding-category-${finding.id}`} value={edit.category} onChange={(event) => setEdit({ ...edit, category: event.target.value as FindingEdit['category'] })}>{Object.entries(categoryLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
                <div className="ra-field"><label htmlFor={`finding-severity-${finding.id}`}>严重度</label><select id={`finding-severity-${finding.id}`} value={edit.severity} onChange={(event) => setEdit({ ...edit, severity: event.target.value as FindingEdit['severity'] })}>{Object.entries(severityLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
                <div className="ra-field"><label htmlFor={`finding-confidence-${finding.id}`}>置信度</label><select id={`finding-confidence-${finding.id}`} value={edit.confidence} onChange={(event) => setEdit({ ...edit, confidence: event.target.value as FindingEdit['confidence'] })}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></div>
              </div>
            </div>
          ) : (
            <p>{finding.content}</p>
          )}
          {!edit && finding.evidence.map((evidence) => (
            <div className="ra-evidence" key={`${evidence.path}-${evidence.lines}-${evidence.quote}`}>
              <strong>{evidence.path} · {evidence.lines}</strong>
              <span>{evidence.quote}</span>
            </div>
          ))}
          {!edit && finding.existingCode && (
            <div className="ra-code-change">
              <pre className="before">- {finding.existingCode}</pre>
              {finding.suggestionCode && <pre className="after">+ {finding.suggestionCode}</pre>}
            </div>
          )}
          <div className="ra-finding-actions">
            {edit ? (
              <>
                <button type="button" className="ra-btn" onClick={() => setEdit(undefined)}><X size={14} />取消</button>
                <button type="button" className="ra-btn primary" onClick={saveEdit} disabled={editInvalid}><Save size={14} />保存修改</button>
              </>
            ) : (
              <>
                <button type="button" className="ra-btn" onClick={startEdit} disabled={finding.status === 'published'}><Edit3 size={14} />编辑</button>
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
              </>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
