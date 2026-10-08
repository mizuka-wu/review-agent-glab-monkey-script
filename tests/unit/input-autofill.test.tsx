import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FindingCard } from '../../src/components/review/FindingCard';
import { Input } from '../../src/components/ui/modern';
import type { Finding } from '../../src/core/types';

const srcDir = resolve('src');
const controlTag = /<(input|textarea|select)\b/g;

function tsxFiles(dir = srcDir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? tsxFiles(full) : entry.name.endsWith('.tsx') ? [full] : [];
  });
}

/** 取 JSX 开标签的属性区域：跳过引号与花括号，避免把 `=>` 或字符串里的 `>` 当成标签结束。 */
function attributes(source: string, from: number): string {
  let depth = 0;
  let quote = '';
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    } else if (ch === '>' && depth === 0) {
      return source.slice(from, i);
    }
  }
  return source.slice(from);
}

describe('Input autofill', () => {
  it('disables autofill on plain text fields', () => {
    render(<Input value="" onChange={() => undefined} placeholder="https://api.openai.com/v1" />);
    expect(screen.getByPlaceholderText('https://api.openai.com/v1')).toHaveAttribute('autocomplete', 'off');
  });

  it('uses new-password for secret fields, which browsers honor unlike off', () => {
    render(<Input type="password" value="" onChange={() => undefined} placeholder="glpat-..." />);
    expect(screen.getByPlaceholderText('glpat-...')).toHaveAttribute('autocomplete', 'new-password');
  });

  it('keeps an explicit override when a secret field is revealed as text', () => {
    render(<Input type="text" value="" onChange={() => undefined} placeholder="sk-..." autoComplete="new-password" />);
    expect(screen.getByPlaceholderText('sk-...')).toHaveAttribute('autocomplete', 'new-password');
  });
});

describe('form control autofill', () => {
  const finding: Finding = {
    id: 'finding-1', fingerprint: 'ra-fingerprint', path: 'src/a.ts', line: 4, endLine: 4, side: 'new',
    category: 'bug', severity: 'medium', confidence: 'medium', title: 'Original', content: 'Original content',
    evidence: [], existingCode: '', suggestionCode: '', comment: 'Original comment', source: 'model', status: 'draft',
  };

  it('disables autofill on every finding edit control', () => {
    const { container } = render(<FindingCard
      finding={finding}
      expanded
      publishDisabled={false}
      onToggle={() => undefined}
      onLocate={() => undefined}
      onCopy={() => undefined}
      onPublish={() => undefined}
      onIgnore={() => undefined}
      onEdit={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    const controls = container.querySelectorAll('input, textarea, select');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control).toHaveAttribute('autocomplete', 'off');
  });

  it('leaves no input control in src/ without autoComplete', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(controlTag)) {
        if (!attributes(source, match.index ?? 0).includes('autoComplete')) {
          offenders.push(`${relative(srcDir, file)} <${match[1]}>`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
