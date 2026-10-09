import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatThread } from '../../src/components/ChatThread';
import { PROMPT_HISTORY_KEY } from '../../src/core/prompt-history';

const history = ['第三次提问', '第二次提问', '第一次提问'];

function Harness({ prompts = history, onSend = vi.fn(), onRemovePrompt }: {
  prompts?: string[]; onSend?: (text: string) => void; onRemovePrompt?: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  return (
    <ChatThread
      messages={[]} sessions={[]} activeSessionId="" onNewSession={() => undefined}
      onSwitchSession={() => undefined} onDeleteSession={() => undefined}
      responding={false} draft={draft} onDraftChange={setDraft}
      onSend={(text) => { onSend(text); setDraft(''); }}
      promptHistory={prompts}
      {...(onRemovePrompt ? { onRemovePrompt } : {})}
      modelReady
      onOpenSettings={() => undefined}
    />
  );
}

const box = () => screen.getByRole('textbox', { name: '消息输入框' }) as HTMLTextAreaElement;
const listOf = () => screen.getByRole('listbox', { name: '历史 prompt 列表' });

afterEach(cleanup);

describe('chat composer prompt history', () => {
  it('recalls the last submitted prompt with ↑ and walks back on repeated ↑', () => {
    render(<Harness />);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第三次提问');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第二次提问');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第一次提问');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第一次提问');
    expect(screen.getByText('历史 prompt 3/3')).toBeInTheDocument();
  });

  it('returns to the unsent draft with ↓ and with Esc', () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '写到一半' } });
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第三次提问');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第二次提问');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('第三次提问');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('写到一半');
    expect(screen.queryByText(/历史 prompt \d/)).not.toBeInTheDocument();

    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第三次提问');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box().value).toBe('写到一半');
  });

  it('resubmits a recalled prompt as a new round on Enter', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('第二次提问');
    expect(box().value).toBe('');
  });

  it('leaves ↑↓ to the caret inside a multi-line draft until it reaches the first line', () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '第一行\n第二行' } });
    box().setSelectionRange(6, 6);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第一行\n第二行');

    box().setSelectionRange(2, 2);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第三次提问');

    // 翻历史时整段归历史管：多行内容也能继续 ↑
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('第二次提问');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('第一行\n第二行');
  });

  it('does not hijack Shift+Enter, which still inserts a newline', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('opens a history list, fills the composer on click and submits directly from the row', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '历史 prompt' }));
    const list = listOf();
    expect(within(list).getAllByRole('option')).toHaveLength(3);
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent('第三次提问');

    fireEvent.click(within(list).getAllByRole('option')[1]);
    expect(box().value).toBe('第二次提问');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '历史 prompt' }));
    fireEvent.click(within(listOf()).getAllByRole('button', { name: '直接发送这条 prompt' })[0]);
    expect(onSend).toHaveBeenCalledWith('第三次提问');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('lets a noisy entry be deleted from the list', () => {
    const onRemovePrompt = vi.fn();
    render(<Harness onRemovePrompt={onRemovePrompt} />);
    fireEvent.click(screen.getByRole('button', { name: '历史 prompt' }));
    fireEvent.click(within(listOf()).getAllByRole('button', { name: '删除这条 prompt' })[2]);
    expect(onRemovePrompt).toHaveBeenCalledWith('第一次提问');
  });

  it('keeps the history key separate from the chat session store', () => {
    render(<Harness />);
    expect(PROMPT_HISTORY_KEY).toBe('review-agent-prompt-history-v1');
    expect(screen.getByRole('button', { name: '会话历史' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '历史 prompt' })).toBeInTheDocument();
  });

  it('hides the history affordances when nothing was submitted yet', () => {
    render(<Harness prompts={[]} />);
    expect(screen.queryByRole('button', { name: '历史 prompt' })).not.toBeInTheDocument();
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('');
  });
});
