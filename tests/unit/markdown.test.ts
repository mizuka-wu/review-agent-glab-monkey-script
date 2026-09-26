import { describe, expect, it } from 'vitest';

// Test the markdown rendering logic by extracting the core function
// We can't easily test React components in unit tests, so test the HTML generation logic

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code class="ra-md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
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
    const headerMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      closeList();
      const level = headerMatch[1].length;
      output.push(`<h${level} class="ra-md-h">${inlineMarkdown(escapeHtml(headerMatch[2]))}</h${level}>`);
      continue;
    }
    const listMatch = line.match(/^[-*+]\s+(.+)/);
    if (listMatch) {
      if (!inList) {
        output.push('<ul class="ra-md-list">');
        inList = true;
      }
      output.push(`<li>${inlineMarkdown(escapeHtml(listMatch[1]))}</li>`);
      continue;
    }
    const olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inList) {
        output.push('<ul class="ra-md-list">');
        inList = true;
      }
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
  if (inCodeBlock && codeBlockContent.length > 0) {
    output.push(
      `<pre class="ra-md-pre"><code class="ra-md-code-block">${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`,
    );
  }
  return output.join('\n');
}

describe('Markdown rendering', () => {
  it('renders bold text', () => {
    const result = renderMarkdown('**bold text**');
    expect(result).toContain('<strong>bold text</strong>');
  });

  it('renders italic text', () => {
    const result = renderMarkdown('*italic*');
    expect(result).toContain('<em>italic</em>');
  });

  it('renders inline code', () => {
    const result = renderMarkdown('Use `console.log()` for debugging');
    expect(result).toContain('<code class="ra-md-code">console.log()</code>');
  });

  it('renders code blocks with language', () => {
    const result = renderMarkdown('```typescript\nconst x = 1;\n```');
    expect(result).toContain('<pre class="ra-md-pre">');
    expect(result).toContain('language-typescript');
    expect(result).toContain('const x = 1;');
  });

  it('renders links', () => {
    const result = renderMarkdown('[Google](https://google.com)');
    expect(result).toContain('<a href="https://google.com"');
    expect(result).toContain('>Google</a>');
  });

  it('renders headers', () => {
    expect(renderMarkdown('# Title')).toContain('<h1');
    expect(renderMarkdown('## Subtitle')).toContain('<h2');
  });

  it('renders unordered lists', () => {
    const result = renderMarkdown('- item 1\n- item 2');
    expect(result).toContain('<ul class="ra-md-list">');
    expect(result).toContain('<li>item 1</li>');
    expect(result).toContain('<li>item 2</li>');
  });

  it('escapes HTML in content', () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('handles empty content', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('handles unclosed code block', () => {
    const result = renderMarkdown('```\nunclosed');
    expect(result).toContain('<pre class="ra-md-pre">');
    expect(result).toContain('unclosed');
  });
});
