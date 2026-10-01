import { memo } from 'react';

// Lightweight, dependency-free Markdown renderer for chat messages.
// Supports: fenced code, inline code, bold, italic, strikethrough, links,
// headings, ordered/unordered lists, blockquotes, tables and rules.

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeUrl(url: string): string {
  const trimmed = url.trim();
  return /^(?:https?:|mailto:|#|\/)/i.test(trimmed) ? trimmed : '#';
}

export function inlineMarkdown(text: string): string {
  const placeholders: string[] = [];
  const stash = (html: string) => {
    placeholders.push(html);
    return `\u0000${placeholders.length - 1}\u0000`;
  };

  let result = text
    .replace(/`([^`]+)`/g, (_, code: string) => stash(`<code class="ra-md-code">${escapeHtml(code)}</code>`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label: string, url: string) => stash(
      `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`,
    ))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  result = result.replace(/\u0000(\d+)\u0000/g, (_, index: string) => placeholders[Number(index)]);
  return result;
}

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
}

function isDividerRow(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

export function renderMarkdown(source: string): string {
  const lines = source.split('\n');
  const output: string[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockLang = '';
  let listType: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listType) {
      output.push(`</${listType}>`);
      listType = null;
    }
  };
  const openList = (type: 'ul' | 'ol') => {
    if (listType !== type) {
      closeList();
      output.push(`<${type} class="ra-md-list">`);
      listType = type;
    }
  };
  const flushCodeBlock = () => {
    output.push(
      `<pre class="ra-md-pre"><code class="ra-md-code-block${codeBlockLang ? ` language-${escapeHtml(codeBlockLang)}` : ''}">${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`,
    );
    codeBlockContent = [];
    codeBlockLang = '';
    inCodeBlock = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        flushCodeBlock();
      } else {
        closeList();
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
      }
      continue;
    }
    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      closeList();
      const level = headerMatch[1].length;
      output.push(`<h${level} class="ra-md-h">${inlineMarkdown(escapeHtml(headerMatch[2]))}</h${level}>`);
      continue;
    }

    if (/^\s*(?:[-*_])\s*(?:[-*_]\s*){2,}$/.test(line)) {
      closeList();
      output.push('<hr class="ra-md-hr" />');
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      closeList();
      output.push(`<blockquote class="ra-md-quote">${inlineMarkdown(escapeHtml(quoteMatch[1]))}</blockquote>`);
      continue;
    }

    // Tables: header row followed by a divider row
    if (line.includes('|') && isDividerRow(lines[index + 1] ?? '')) {
      closeList();
      const headers = splitRow(line);
      index += 1;
      const rows: string[][] = [];
      while (index + 1 < lines.length && lines[index + 1].includes('|') && lines[index + 1].trim() !== '') {
        index += 1;
        rows.push(splitRow(lines[index]));
      }
      output.push('<table class="ra-md-table"><thead><tr>');
      for (const header of headers) output.push(`<th>${inlineMarkdown(escapeHtml(header))}</th>`);
      output.push('</tr></thead><tbody>');
      for (const row of rows) {
        output.push('<tr>');
        for (let cell = 0; cell < headers.length; cell += 1) {
          output.push(`<td>${inlineMarkdown(escapeHtml(row[cell] ?? ''))}</td>`);
        }
        output.push('</tr>');
      }
      output.push('</tbody></table>');
      continue;
    }

    const ulMatch = line.match(/^\s*[-*+]\s+(.+)/);
    if (ulMatch) {
      openList('ul');
      output.push(`<li>${inlineMarkdown(escapeHtml(ulMatch[1]))}</li>`);
      continue;
    }

    const olMatch = line.match(/^\s*\d+[.)]\s+(.+)/);
    if (olMatch) {
      openList('ol');
      output.push(`<li>${inlineMarkdown(escapeHtml(olMatch[1]))}</li>`);
      continue;
    }

    if (line.trim() === '') {
      closeList();
      continue;
    }

    closeList();
    output.push(`<p class="ra-md-p">${inlineMarkdown(escapeHtml(line))}</p>`);
  }

  closeList();
  if (inCodeBlock && codeBlockContent.length > 0) flushCodeBlock();

  return output.join('\n');
}

interface MarkdownProps {
  content: string;
  className?: string;
}

export const Markdown = memo(function Markdown({ content, className }: MarkdownProps) {
  return (
    <div
      className={`ra-md${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
    />
  );
});
