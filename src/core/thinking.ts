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
