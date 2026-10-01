import { describe, expect, it } from 'vitest';
import { escapeHtml, inlineMarkdown, renderMarkdown } from '../../src/components/Markdown';

describe('Markdown rendering', () => {
  it('renders bold text', () => {
    expect(renderMarkdown('**bold text**')).toContain('<strong>bold text</strong>');
  });

  it('renders italic text', () => {
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>');
  });

  it('renders strikethrough', () => {
    expect(renderMarkdown('~~gone~~')).toContain('<del>gone</del>');
  });

  it('renders inline code without interpreting markup inside', () => {
    const result = renderMarkdown('Use `console.log()` for debugging');
    expect(result).toContain('<code class="ra-md-code">console.log()</code>');
    expect(renderMarkdown('`**not bold**`')).toContain('<code class="ra-md-code">**not bold**</code>');
  });

  it('renders code blocks with language', () => {
    const result = renderMarkdown('```typescript\nconst x = 1;\n```');
    expect(result).toContain('<pre class="ra-md-pre">');
    expect(result).toContain('language-typescript');
    expect(result).toContain('const x = 1;');
  });

  it('renders links and blocks unsafe protocols', () => {
    const result = renderMarkdown('[Google](https://google.com)');
    expect(result).toContain('<a href="https://google.com"');
    expect(result).toContain('>Google</a>');
    expect(renderMarkdown('[x](javascript:alert(1))')).toContain('href="#"');
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

  it('renders ordered lists as ordered lists', () => {
    const result = renderMarkdown('1. first\n2. second');
    expect(result).toContain('<ol class="ra-md-list">');
    expect(result).toContain('<li>first</li>');
    expect(result).toContain('</ol>');
  });

  it('renders blockquotes, rules and tables', () => {
    expect(renderMarkdown('> quoted')).toContain('<blockquote class="ra-md-quote">quoted</blockquote>');
    expect(renderMarkdown('---')).toContain('<hr class="ra-md-hr" />');
    const table = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(table).toContain('<table class="ra-md-table">');
    expect(table).toContain('<th>a</th>');
    expect(table).toContain('<td>2</td>');
  });

  it('escapes HTML in content', () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
    // inlineMarkdown 接收已转义文本，调用方负责 escapeHtml
    expect(inlineMarkdown(escapeHtml('<img src=x onerror=alert(1)>'))).not.toContain('<img');
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img');
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
