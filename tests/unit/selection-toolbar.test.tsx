import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectionToolbar } from '../../src/components/review/SelectionToolbar';
import type { CodeSelection } from '../../src/core/types';

const codeSelection: CodeSelection = {
  filePath: 'src/payment.ts', side: 'new', startLine: 10, endLine: 12, text: 'const a = 1;', top: 40, left: 200,
};
const plainSelection: CodeSelection = { text: '讨论区里的普通文本', top: 40, left: 200 };

afterEach(cleanup);

function handlers() {
  return { onAsk: vi.fn(), onReview: vi.fn(), onCopy: vi.fn(), onClose: vi.fn() };
}

describe('SelectionToolbar', () => {
  it('diff 选区给出标签与三个动作', () => {
    render(<SelectionToolbar state={codeSelection} {...handlers()} />);

    expect(screen.getByRole('toolbar', { name: '代码选区操作' })).toBeVisible();
    expect(screen.getByText('payment.ts:10-12')).toBeVisible();
    expect(screen.getByRole('button', { name: '问一下' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Review 这段' })).toBeVisible();
    expect(screen.getByRole('button', { name: '复制选中代码' })).toBeVisible();
  });

  it('tooltip 说明动作效果，不是按钮自名', () => {
    render(<SelectionToolbar state={codeSelection} {...handlers()} />);

    expect(screen.getByRole('button', { name: '问一下' }))
      .toHaveAttribute('title', '向 AI 提问选中内容（附带文件与行号）');
    expect(screen.getByRole('button', { name: 'Review 这段' }))
      .toHaveAttribute('title', '只针对这段选区执行 Review（附带文件与行号）');
    expect(screen.getByRole('button', { name: '复制选中代码' }))
      .toHaveAttribute('title', '复制选中的原文到剪贴板');
    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('title')).not.toBe(button.textContent);
    }
  });

  it('非 diff 选区只保留问一下 / 复制，Review 这段不出现', () => {
    render(<SelectionToolbar state={plainSelection} {...handlers()} />);

    expect(screen.getByText('页面文本选区')).toBeVisible();
    expect(screen.getByRole('button', { name: '问一下' }))
      .toHaveAttribute('title', '向 AI 提问选中内容（页面文本，不附带文件与行号）');
    expect(screen.getByRole('button', { name: '复制选中内容' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Review 这段' })).toBeNull();
  });

  it('按钮各自触发对应回调', () => {
    const props = handlers();
    render(<SelectionToolbar state={codeSelection} {...props} />);

    fireEvent.click(screen.getByRole('button', { name: '问一下' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review 这段' }));
    fireEvent.click(screen.getByRole('button', { name: '复制选中代码' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭工具栏' }));

    expect(props.onAsk).toHaveBeenCalledTimes(1);
    expect(props.onReview).toHaveBeenCalledTimes(1);
    expect(props.onCopy).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('非 diff 选区只会触发问一下 / 复制 / 关闭', () => {
    const props = handlers();
    render(<SelectionToolbar state={plainSelection} {...props} />);

    fireEvent.click(screen.getByRole('button', { name: '问一下' }));
    fireEvent.click(screen.getByRole('button', { name: '复制选中内容' }));

    expect(props.onAsk).toHaveBeenCalledTimes(1);
    expect(props.onCopy).toHaveBeenCalledTimes(1);
    expect(props.onReview).not.toHaveBeenCalled();
  });
});
