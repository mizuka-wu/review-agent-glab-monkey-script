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
  selected?: boolean;
  publishDisabled: boolean;
  onToggle: () => void;
  onSelect?: () => void;
  onLocate: () => void;
  onCopy: () => void;
  onPublish: () => void;
  onIgnore: () => void;
  onEdit: (edit: FindingEdit) => void;
}

export function FindingCard({
  finding,
  expanded,
  selected,
  publishDisabled,
  onToggle,
  onSelect,
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
    <article className={`overflow-hidden rounded-md border border-border bg-card border-l-[3px] ${finding.severity === 'critical' || finding.severity === 'high' ? 'border-l-destructive' : finding.severity === 'medium' ? 'border-l-warning' : 'border-l-info'}`}>
      <button type="button" className="w-full p-2.5 bg-transparent border-0 cursor-pointer text-left" onClick={onToggle} aria-expanded={expanded}>
        <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
          {onSelect && (
            <span className="flex items-center mr-1.5" onClick={(e) => { e.stopPropagation(); onSelect(); }}>
              <input type="checkbox" checked={selected ?? false} onChange={() => {}} aria-label="选择此 Finding" />
            </span>
          )}
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${finding.severity}`}>{severityLabel[finding.severity]}</span>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-secondary text-secondary-foreground">{categoryLabel[finding.category]}</span>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-secondary text-secondary-foreground">置信度 {finding.confidence === 'high' ? '高' : finding.confidence === 'medium' ? '中' : '低'}</span>
          {finding.edited && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-info/15 text-info">已编辑</span>}
          {finding.anchor?.relocatedFromPath && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-info/15 text-info">跨文件重定位</span>}
          {finding.anchor?.source === 'full-file' && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-warning/15 text-warning">完整文件锚定</span>}
          {finding.status === 'published' && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-success/15 text-success">已发布</span>}
          {finding.status === 'ignored' && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-secondary text-secondary-foreground">已忽略</span>}
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        <h3>{finding.title}</h3>
        <code className="block mt-1 text-muted-foreground font-mono text-[9px]">{finding.path}:{finding.line}-{finding.endLine} · {finding.source}</code>
      </button>
      {expanded && (
        <div className="px-2.5 pb-2.5 border-t border-border">
          {edit ? (
            <div className="grid gap-2.5 py-2.5">
              <div className="grid gap-1.5"><label htmlFor={`finding-title-${finding.id}`}>标题</label><input id={`finding-title-${finding.id}`} value={edit.title} onChange={(event) => setEdit({ ...edit, title: event.target.value })} /></div>
              <div className="grid gap-1.5"><label htmlFor={`finding-content-${finding.id}`}>说明</label><textarea id={`finding-content-${finding.id}`} value={edit.content} onChange={(event) => setEdit({ ...edit, content: event.target.value })} /></div>
              <div className="grid gap-1.5"><label htmlFor={`finding-comment-${finding.id}`}>评论草稿</label><textarea id={`finding-comment-${finding.id}`} value={edit.comment} onChange={(event) => setEdit({ ...edit, comment: event.target.value })} /></div>
              <div className="grid grid-cols-3 gap-2">
                <div className="grid gap-1.5"><label htmlFor={`finding-category-${finding.id}`}>分类</label><select id={`finding-category-${finding.id}`} value={edit.category} onChange={(event) => setEdit({ ...edit, category: event.target.value as FindingEdit['category'] })}>{Object.entries(categoryLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
                <div className="grid gap-1.5"><label htmlFor={`finding-severity-${finding.id}`}>严重度</label><select id={`finding-severity-${finding.id}`} value={edit.severity} onChange={(event) => setEdit({ ...edit, severity: event.target.value as FindingEdit['severity'] })}>{Object.entries(severityLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
                <div className="grid gap-1.5"><label htmlFor={`finding-confidence-${finding.id}`}>置信度</label><select id={`finding-confidence-${finding.id}`} value={edit.confidence} onChange={(event) => setEdit({ ...edit, confidence: event.target.value as FindingEdit['confidence'] })}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></div>
              </div>
            </div>
          ) : (
            <p>{finding.content}</p>
          )}
          {!edit && finding.evidence.map((evidence) => (
            <div className="my-2.5 p-2 rounded bg-muted" key={`${evidence.path}-${evidence.lines}-${evidence.quote}`}>
              <strong>{evidence.path} · {evidence.lines}</strong>
              <span>{evidence.quote}</span>
            </div>
          ))}
          {!edit && finding.existingCode && (
            <div className="grid gap-1 my-2.5">
              <pre className="before">- {finding.existingCode}</pre>
              {finding.suggestionCode && <pre className="after">+ {finding.suggestionCode}</pre>}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {edit ? (
              <>
                <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-2 py-1 text-xs font-semibold rounded-md bg-card border border-border cursor-pointer text-foreground" onClick={() => setEdit(undefined)}><X size={14} />取消</button>
                <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-2 py-1 text-xs font-semibold rounded-md bg-primary text-primary-foreground border border-primary cursor-pointer" onClick={saveEdit} disabled={editInvalid}><Save size={14} />保存修改</button>
              </>
            ) : (
              <>
                <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-2 py-1 text-xs font-semibold rounded-md bg-card border border-border cursor-pointer text-foreground" onClick={startEdit} disabled={finding.status === 'published'}><Edit3 size={14} />编辑</button>
                <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-2 py-1 text-xs font-semibold rounded-md bg-card border border-border cursor-pointer text-foreground" onClick={onLocate}><Crosshair size={14} />定位</button>
                <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-2 py-1 text-xs font-semibold rounded-md bg-card border border-border cursor-pointer text-foreground" onClick={onCopy}><Copy size={14} />复制评论</button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-2 py-1 text-xs font-semibold rounded-md bg-primary text-primary-foreground border border-primary cursor-pointer"
                  onClick={onPublish}
                  disabled={publishDisabled || finding.status === 'published'}
                  title={finding.anchor?.publishable === false ? '完整文件位置不能发布为 MR 行级 Discussion' : undefined}
                >
                  {finding.status === 'published' ? <Check size={14} /> : <MessageSquarePlus size={14} />}
                  {finding.status === 'published' ? '已发布' : '发布到 GitLab'}
                </button>
                <button type="button" className="inline-flex items-center justify-center gap-1.5 min-h-[30px] px-2 py-1 text-xs font-semibold rounded-md bg-transparent border border-transparent cursor-pointer" onClick={onIgnore} disabled={finding.status !== 'draft'}><EyeOff size={14} />忽略</button>
              </>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
