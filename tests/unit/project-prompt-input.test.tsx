import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectPromptInput } from '../../src/components/review/ProjectPromptInput';
import { pushProjectPromptHistory, removeProjectPromptHistory } from '../../src/core/project-prompts';

const history = ['第三版要求', '第二版要求', '第一版要求'];

function Harness({ initial = '', entries = history, onCommitSpy }: {
  initial?: string; entries?: string[]; onCommitSpy?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(entries);
  return (
    <ProjectPromptInput
      ariaLabel="项目补充要求"
      value={value}
      history={saved}
      onChange={setValue}
      onCommit={(next) => { onCommitSpy?.(next); setSaved((prev) => pushProjectPromptHistory(prev, next)); }}
      onRemoveEntry={(entry) => setSaved((prev) => removeProjectPromptHistory(prev, entry))}
      placeholder="可选：本项目评审的额外约束"
    />
  );
}

const box = () => screen.getByRole('textbox', { name: '项目补充要求' }) as HTMLTextAreaElement;
const listOf = () => screen.getByRole('listbox', { name: '项目补充要求历史列表' });

afterEach(cleanup);

describe('项目补充要求输入框 ↑↓ 翻历史', () => {
  it('↑ 从最新一条往回翻，翻到底停在最旧那条', () => {
    render(<Harness />);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第三版要求');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第二版要求');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第一版要求');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第一版要求');
    expect(screen.getByText('历史 3/3 · ↑↓ 切换 · Esc 回到编辑中的内容')).toBeInTheDocument();
  });

  it('↓ 一路回到更新的一条，走完把编辑中的草稿还回去', () => {
    render(<Harness initial="写到一半" />);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第二版要求');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('第三版要求');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('写到一半');
    expect(screen.queryByText(/历史 \d\/\d/)).not.toBeInTheDocument();
  });

  it('Esc 取消翻历史，恢复进入历史前的内容', () => {
    render(<Harness initial="写到一半" />);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第三版要求');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box().value).toBe('写到一半');
  });

  it('多行内容里 ↑↓ 先移动光标，光标到了首行/末行才翻历史', () => {
    render(<Harness initial={'第一行\n第二行'} />);
    box().setSelectionRange(6, 6);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第一行\n第二行');

    box().setSelectionRange(2, 2);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第三版要求');

    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第二版要求');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('第一行\n第二行');
  });

  it('Shift+↑↓ 交还给浏览器，不翻历史', () => {
    render(<Harness />);
    fireEvent.keyDown(box(), { key: 'ArrowUp', shiftKey: true });
    expect(box().value).toBe('');
  });

  it('没有历史时 ↑ 什么都不做，也不渲染历史入口', () => {
    render(<Harness entries={[]} />);
    expect(screen.queryByRole('button', { name: '项目补充要求历史' })).not.toBeInTheDocument();
    expect(screen.getByText('失焦后自动存进历史，↑ 可以翻回之前写过的版本')).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('');
  });

  it('打字即退出翻历史状态，不会把光标停在旧条目上', () => {
    render(<Harness />);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(screen.getByText(/历史 1\/3/)).toBeInTheDocument();
    fireEvent.change(box(), { target: { value: '重新写' } });
    expect(screen.queryByText(/历史 1\/3/)).not.toBeInTheDocument();
  });
});

describe('项目补充要求输入框保存点', () => {
  it('失焦即保存：当前值写进历史，老版本自动保留', () => {
    const onCommit = vi.fn();
    render(<Harness initial="第一版要求" onCommitSpy={onCommit} />);
    fireEvent.change(box(), { target: { value: '第四版要求' } });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.blur(box());
    expect(onCommit).toHaveBeenCalledWith('第四版要求');
    fireEvent.click(screen.getByRole('button', { name: '项目补充要求历史' }));
    expect(within(listOf()).getAllByRole('option')).toHaveLength(4);
    expect(within(listOf()).getAllByRole('option')[0]).toHaveTextContent('第四版要求');
  });

  it('翻出旧条目再失焦，把它提到历史最前而不是复制一份', () => {
    render(<Harness />);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第二版要求');
    fireEvent.blur(box());
    expect(box().value).toBe('第二版要求');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第二版要求');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第三版要求');
  });

  it('清空后失焦不会往历史里塞空条目', () => {
    render(<Harness initial="第三版要求" />);
    fireEvent.change(box(), { target: { value: '   ' } });
    fireEvent.blur(box());
    fireEvent.click(screen.getByRole('button', { name: '项目补充要求历史' }));
    expect(within(listOf()).getAllByRole('option')).toHaveLength(3);
  });
});

describe('项目补充要求历史列表', () => {
  it('点历史按钮展开列表，点条目填回输入框并收起', () => {
    render(<Harness />);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '项目补充要求历史' }));
    expect(within(listOf()).getAllByRole('option')).toHaveLength(3);

    fireEvent.click(within(listOf()).getAllByRole('option')[1]);
    expect(box().value).toBe('第二版要求');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(box()).toHaveFocus();
  });

  it('列表里可以单删一条噪声历史', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '项目补充要求历史' }));
    fireEvent.click(within(listOf()).getAllByRole('button', { name: '删除这条补充要求' })[2]);
    expect(within(listOf()).getAllByRole('option')).toHaveLength(2);
    expect(box().value).toBe('');
  });

  it('按钮上直接标出历史条数，标题说明也能看到', () => {
    render(<Harness />);
    const button = screen.getByRole('button', { name: '项目补充要求历史' });
    expect(button).toHaveTextContent('3');
    expect(button).toHaveAttribute('title', '最近 3 条保存过的补充要求（也可以在输入框里按 ↑）');
    expect(screen.getByText('已保存 3 条历史（每项目最多 10 条）· ↑ 翻上一条')).toBeInTheDocument();
  });
});

describe('项目补充要求输入框焦点', () => {
  it('列表打开时点条目不会先触发失焦保存把历史搞乱', () => {
    const onCommit = vi.fn();
    render(<Harness initial="第一版要求" onCommitSpy={onCommit} />);
    fireEvent.focus(box());
    fireEvent.click(screen.getByRole('button', { name: '项目补充要求历史' }));
    fireEvent.mouseDown(within(listOf()).getAllByRole('option')[0]);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(within(listOf()).getAllByRole('option')[0]);
    expect(box().value).toBe('第三版要求');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
