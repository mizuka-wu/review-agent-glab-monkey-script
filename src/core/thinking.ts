/** 把流式思考文本里的大段 JSON / 代码块折叠成占位摘要，保留可读的推理 prose。 */
export function compactThinking(text: string): string {
  const withoutFences = text.replace(/```[\s\S]*?```/g, (block) => `〔代码块 ${block.length} 字已折叠〕`);
  const folded = foldJsonSpans(withoutFences);
  return folded.replace(/\n{3,}/g, '\n\n').trim();
}

function foldJsonSpans(text: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  let spanStart = -1;
  let plainStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') {
      if (stack.length === 0) {
        out.push(text.slice(plainStart, i));
        spanStart = i;
      }
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (stack.length === 0) continue;
      stack.pop();
      if (stack.length === 0) {
        const span = text.slice(spanStart, i + 1);
        out.push(span.length >= 120 ? `〔JSON 草稿 ${span.length} 字已折叠〕` : span);
        plainStart = i + 1;
      }
    }
  }
  out.push(text.slice(plainStart));
  return out.join('');
}

export interface ThinkingSegment {
  kind: 'prose' | 'json' | 'code';
  chars: number;
  preview: string;
}

export interface ThinkingOutline {
  bullets: string[];
  timeline: ThinkingSegment[];
}

const BULLET_HINT = /(?:发现|风险|建议|需要|应该|检查|确认|注意|问题|因为|所以|结论|计划|先|再|最后|可能|存在)/;

function collectProseAndJson(text: string, timeline: ThinkingSegment[]): string[] {
  const prose: string[] = [];
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  let spanStart = -1;
  let plainStart = 0;
  const flushProse = (end: number) => {
    const chunk = text.slice(plainStart, end).trim();
    if (chunk) {
      prose.push(chunk);
      timeline.push({ kind: 'prose', chars: chunk.length, preview: chunk.slice(0, 60).replace(/\s+/g, ' ') });
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') {
      if (stack.length === 0) { flushProse(i); spanStart = i; }
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (stack.length === 0) continue;
      stack.pop();
      if (stack.length === 0) {
        const span = text.slice(spanStart, i + 1);
        if (span.length >= 120) timeline.push({ kind: 'json', chars: span.length, preview: span.slice(0, 60).replace(/\s+/g, ' ') });
        else prose.push(span);
        plainStart = i + 1;
      }
    }
  }
  flushProse(text.length);
  return prose;
}

/** 把思考流结构化为「要点 + 时间轴」：要点取带结论/动作信号的短句，时间轴按 prose/JSON/代码分段。 */
export function extractThinkingOutline(text: string): ThinkingOutline {
  const timeline: ThinkingSegment[] = [];
  const proseParts: string[] = [];
  const fence = /```[\s\S]*?```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    proseParts.push(...collectProseAndJson(text.slice(last, match.index), timeline));
    timeline.push({ kind: 'code', chars: match[0].length, preview: match[0].slice(3, 63).replace(/\s+/g, ' ') });
    last = match.index + match[0].length;
  }
  proseParts.push(...collectProseAndJson(text.slice(last), timeline));

  const bullets: string[] = [];
  for (const part of proseParts) {
    for (const rawLine of part.split(/\n+/)) {
      const line = rawLine.trim();
      if (line.length < 8 || line.length > 160) continue;
      if (!BULLET_HINT.test(line) && !/^(?:\d+[.)]|[-*•])/.test(line)) continue;
      if (bullets.includes(line)) continue;
      bullets.push(line.slice(0, 120));
      if (bullets.length >= 8) break;
    }
    if (bullets.length >= 8) break;
  }
  return { bullets, timeline };
}
