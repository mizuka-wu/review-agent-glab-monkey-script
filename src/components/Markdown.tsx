import { memo } from 'react';

// Lightweight markdown renderer for chat messages.
// Handles: code blocks, inline code, bold, italic, links, lists, headers.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdown(text: string): string {
  return text
    // Inline code first
    .replace(/`([^`]+)`/g, '<code class="ra-md-code">$1</code>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderMarkdown(source: string): string {
  const lines = source.split('\n');
  const output: string[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockLang = '';
  let inList = false;

  const closeList = () => {
    if (inList) {
      output.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    // Code block start/end
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        output.push(
          `<pre class="ra-md-pre"><code class="ra-md-code-block${codeBlockLang ? ` language-${escapeHtml(codeBlockLang)}` : ''}">${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`,
        );
        codeBlockContent = [];
        codeBlockLang = '';
        inCodeBlock = false;
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

    // Headers
    const headerMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      closeList();
      const level = headerMatch[1].length;
      output.push(`<h${level} class="ra-md-h">${inlineMarkdown(escapeHtml(headerMatch[2]))}</h${level}>`);
      continue;
    }

    // Unordered list items
    const listMatch = line.match(/^[-*+]\s+(.+)/);
    if (listMatch) {
      if (!inList) {
        output.push('<ul class="ra-md-list">');
        inList = true;
      }
      output.push(`<li>${inlineMarkdown(escapeHtml(listMatch[1]))}</li>`);
      continue;
    }

    // Ordered list items
    const olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inList) {
        output.push('<ul class="ra-md-list">');
        inList = true;
      }
      output.push(`<li>${inlineMarkdown(escapeHtml(olMatch[1]))}</li>`);
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      closeList();
      continue;
    }

    // Regular paragraph
    closeList();
    output.push(`<p class="ra-md-p">${inlineMarkdown(escapeHtml(line))}</p>`);
  }

  closeList();

  // Unclosed code block
  if (inCodeBlock && codeBlockContent.length > 0) {
    output.push(
      `<pre class="ra-md-pre"><code class="ra-md-code-block">${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`,
    );
  }

  return output.join('\n');
}

interface MarkdownProps {
  content: string;
  className?: string;
}

export const Markdown = memo(function Markdown({ content, className }: MarkdownProps) {
  return (
    <div
      className={`ra-markdown${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
    />
  );
});
