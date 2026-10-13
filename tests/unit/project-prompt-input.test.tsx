import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectPromptInput } from '../../src/components/review/ProjectPromptInput';
import { pushProjectPromptHistory, removeProjectPromptHistory } from '../../src/core/project-prompts';
import type { ProjectPromptHistoryEntry } from '../../src/core/types';

const CURRENT = 'acme/app';
const OTHER = 'acme/other';
const entry = (value: string, projectKey: string): ProjectPromptHistoryEntry => ({ value, projectKey });
const history = [entry('第三版要求', CURRENT), entry('别的项目存过的要求', OTHER), entry('第一版要求', CURRENT)];
const historyButton = () => screen.getByRole('button', { name: '项目补充要求历史' });

function Harness({ initial = '', entries = history, onCommitSpy }: {
  initial?: string; entries?: ProjectPromptHistoryEntry[]; onCommitSpy?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(entries);
  return (
    <ProjectPromptInput
      ariaLabel="项目补充要求"
      value={value}
      history={saved}
      onChange={setValue}
      onCommit={(next) => { onCommitSpy?.(next); setSaved((prev) => pushProjectPromptHistory(prev, next, CURRENT)); }}
      onRemoveEntry={(next) => setSaved((prev) => removeProjectPromptHistory(prev, next))}
      placeholder="可选：本项目评审的额外约束"
    />
  );
}

const box = () => screen.getByRole('textbox', { name: '项目补充要求' }) as HTMLTextAreaElement;
const listOf = () => screen.getByRole('listbox', { name: '项目补充要求历史列表' });
const options = () => within(listOf()).getAllByRole('option');

/** 派发原生按键事件：defaultPrevented 直接说明这一次按键有没有被脚本拦下来。 */
function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  box().dispatchEvent(event);
  return event;
}

afterEach(cleanup);

describe('项目补充要求输入框不劫持键盘', () => {
  it('多行内容里 ↑↓ 只归光标：内容一个字都不改，按键也没有被拦下来', () => {
    render(<Harness initial={'第一行要求\n第二行要求'} />);
    box().setSelectionRange(6, 6);

    expect(press('ArrowUp').defaultPrevented).toBe(false);
    expect(box().value).toBe('第一行要求\n第二行要求');
    expect(box().selectionStart).toBe(6);

    expect(press('ArrowDown').defaultPrevented).toBe(false);
    expect(box().value).toBe('第一行要求\n第二行要求');
    expect(box().selectionStart).toBe(6);
  });

  it('光标已经在首行还连按 ↑，也不会翻出历史条目覆盖人工输入', () => {
    render(<Harness initial="写到一半" />);
    box().setSelectionRange(0, 0);
    press('ArrowUp');
    press('ArrowUp');
    press('ArrowUp');
    expect(box().value).toBe('写到一半');
    press('ArrowDown');
    expect(box().value).toBe('写到一半');
  });

  it('Esc 交还给输入框：不改内容、不拦按键、也不关列表', () => {
    render(<Harness initial="写到一半" />);
    fireEvent.click(historyButton());
    expect(press('Escape').defaultPrevented).toBe(false);
    expect(box().value).toBe('写到一半');
    expect(options()).toHaveLength(3);
  });

  it('Shift / Ctrl / Meta 组合的 ↑↓ 同样不被拦截', () => {
    render(<Harness initial={'第一行要求\n第二行要求'} />);
    for (const init of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(press('ArrowUp', init).defaultPrevented).toBe(false);
      expect(press('ArrowDown', init).defaultPrevented).toBe(false);
    }
    expect(box().value).toBe('第一行要求\n第二行要求');
  });

  it('历史列表开着的时候按 ↑↓ 也只是移动光标，不会切换条目', () => {
    render(<Harness />);
    fireEvent.click(historyButton());
    expect(press('ArrowUp').defaultPrevented).toBe(false);
    expect(box().value).toBe('');
    expect(options()).toHaveLength(3);
  });

  it('没有历史时不渲染历史按钮，↑↓ 也没有副作用', () => {
    render(<Harness entries={[]} />);
    expect(screen.queryByRole('button', { name: '项目补充要求历史' })).not.toBeInTheDocument();
    expect(screen.getByText('失焦后自动存进历史，之后可以点历史按钮挑回之前写过的版本')).toBeInTheDocument();
    expect(press('ArrowUp').defaultPrevented).toBe(false);
    expect(box().value).toBe('');
  });

  it('任何时候都不再冒出「历史 n/n · ↑↓ 切换」这类键盘提示', () => {
    render(<Harness />);
    press('ArrowUp');
    fireEvent.change(box(), { target: { value: '重新写' } });
    press('ArrowDown');
    expect(screen.queryByText(/历史 \d\/\d/)).not.toBeInTheDocument();
    expect(screen.queryByText(/↑↓ 切换/)).not.toBeInTheDocument();
  });
});

describe('项目补充要求历史按钮', () => {
  it('按钮标出全局池条数，点开展开列表、再点收起', () => {
    render(<Harness />);
    expect(historyButton()).toHaveTextContent('3');
    expect(historyButton()).toHaveAttribute('aria-expanded', 'false');
    expect(historyButton()).toHaveAttribute('title', '最近 3 条保存过的补充要求（所有项目共用一个历史池），点开挑一条填回输入框');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(historyButton());
    expect(historyButton()).toHaveAttribute('aria-expanded', 'true');
    expect(options()).toHaveLength(3);

    fireEvent.click(historyButton());
    expect(historyButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('按钮坐在输入框右上角，textarea 让出右边距不被压字', () => {
    render(<Harness />);
    expect(box().style.paddingRight).toBe('56px');
    expect(screen.getByText(/点输入框右上角的历史按钮挑一条填回，↑↓ 只移动光标/)).toBeInTheDocument();
  });

  it('提示文案说明历史池是全局共用、上限 30 条', () => {
    render(<Harness />);
    expect(screen.getByText('已保存 3 条历史（所有项目共用，最多 30 条）· 点输入框右上角的历史按钮挑一条填回，↑↓ 只移动光标')).toBeInTheDocument();
    expect(screen.queryByText(/每项目最多 10 条/)).not.toBeInTheDocument();
  });

  it('没有历史时不占右边距', () => {
    render(<Harness entries={[]} />);
    expect(box().style.paddingRight).toBe('7px');
  });

  it('当前生效值在列表里标成已选中，一眼看出正在用哪条', () => {
    render(<Harness initial="别的项目存过的要求" />);
    fireEvent.click(historyButton());
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    expect(options()[0]).toHaveAttribute('aria-selected', 'false');
  });
});

describe('项目补充要求历史列表', () => {
  it('点条目填回输入框并收起，焦点交回输入框', () => {
    render(<Harness />);
    fireEvent.click(historyButton());
    fireEvent.click(options()[2]);
    expect(box().value).toBe('第一版要求');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(box()).toHaveFocus();
  });

  it('每条右下角标出来源项目，跨项目存过的也一起列出来', () => {
    render(<Harness />);
    fireEvent.click(historyButton());
    expect(within(options()[0]).getByText('acme/app')).toBeInTheDocument();
    expect(within(options()[1]).getByText('acme/other')).toBeInTheDocument();
    expect(within(options()[2]).getByText('acme/app')).toBeInTheDocument();
    expect(options()[1]).toHaveTextContent('别的项目存过的要求');
  });

  it('点别的项目存过的条目只把 value 填进输入框，不会把当前项目改掉', () => {
    render(<Harness />);
    fireEvent.click(historyButton());
    fireEvent.click(options()[1]);
    expect(box().value).toBe('别的项目存过的要求');
    expect(screen.queryByText('acme/other')).not.toBeInTheDocument();
  });

  it('没有来源项目的旧条目不渲染空标注', () => {
    render(<Harness entries={[{ value: '很老的版本', projectKey: '' }]} />);
    fireEvent.click(historyButton());
    expect(options()[0]).toHaveTextContent('很老的版本');
    expect(options()[0].textContent).toBe('很老的版本');
  });

  it('列表里可以单删一条噪声历史（含别的项目存过的）', () => {
    render(<Harness />);
    fireEvent.click(historyButton());
    fireEvent.click(within(listOf()).getAllByRole('button', { name: '删除这条补充要求' })[1]);
    expect(options()).toHaveLength(2);
    expect(options().map((option) => option.textContent?.split('acme/')[0])).toEqual(['第三版要求', '第一版要求']);
    expect(box().value).toBe('');
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
    fireEvent.click(historyButton());
    expect(options()).toHaveLength(4);
    expect(options()[0]).toHaveTextContent('第四版要求');
  });

  it('从列表挑一条旧版本再失焦，把它提到历史最前而不是复制一份', () => {
    render(<Harness />);
    fireEvent.click(historyButton());
    fireEvent.click(options()[2]);
    expect(box().value).toBe('第一版要求');
    fireEvent.blur(box());

    fireEvent.click(historyButton());
    expect(options()).toHaveLength(3);
    expect(options()[0]).toHaveTextContent('第一版要求');
  });

  it('挑别的项目的条目再失焦，这条的来源项目变成当前项目', () => {
    render(<Harness />);
    fireEvent.click(historyButton());
    fireEvent.click(options()[1]);
    fireEvent.blur(box());

    fireEvent.click(historyButton());
    expect(options()).toHaveLength(3);
    expect(options()[0]).toHaveTextContent('别的项目存过的要求');
    expect(within(options()[0]).getByText(CURRENT)).toBeInTheDocument();
    expect(screen.queryByText(OTHER)).not.toBeInTheDocument();
  });

  it('清空后失焦不会往历史里塞空条目', () => {
    render(<Harness initial="第三版要求" />);
    fireEvent.change(box(), { target: { value: '   ' } });
    fireEvent.blur(box());
    fireEvent.click(historyButton());
    expect(options()).toHaveLength(3);
  });
});

describe('项目补充要求输入框焦点', () => {
  it('列表打开时点条目不会先触发失焦保存把历史搞乱', () => {
    const onCommit = vi.fn();
    render(<Harness initial="第一版要求" onCommitSpy={onCommit} />);
    fireEvent.focus(box());
    fireEvent.click(historyButton());
    fireEvent.mouseDown(options()[0]);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(options()[0]);
    expect(box().value).toBe('第三版要求');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
