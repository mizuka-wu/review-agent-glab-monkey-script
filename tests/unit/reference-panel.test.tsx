import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReferenceMrPanel, type ReferenceCandidate } from '../../src/components/review/ReferenceMrPanel';
import type { MrLinkParseFailure, ReferenceMr } from '../../src/core/reference-mrs';
import { normalizeFileDiff } from '../../src/core/diff';
import type { FileDiff } from '../../src/core/types';

const companion: ReferenceMr = {
  ref: { origin: 'https://other.test', projectPath: 'platform/sdk', iid: 12 },
  status: 'ready', title: 'feat: companion token endpoint', headSha: 'abcdef1234567890',
  addedAt: '2026-10-09T10:00:00.000Z',
  files: [normalizeFileDiff({ old_path: 'src/companion.ts', new_path: 'src/companion.ts', diff: '@@ -0,0 +1 @@\n+x' })] as FileDiff[],
};

const candidates: ReferenceCandidate[] = [
  { key: 'https://gitlab.test|acme/app|248', label: 'acme/app!248', title: '当前项目上次评审', meta: '10-08 20:11', group: 'history', checked: false },
  { key: 'https://other.test|platform/sdk|12', label: 'platform/sdk!12', title: 'feat: companion token endpoint', meta: '10-09 09:40', group: 'recent', checked: true },
  { key: 'https://gitlab.test|group/web|7', label: 'group/web!7', title: 'fix: 配套前端改动', meta: '10-09 08:02', group: 'recent', checked: false },
];

function setup(overrides: Partial<Parameters<typeof ReferenceMrPanel>[0]> = {}) {
  const props = {
    references: [] as ReferenceMr[],
    input: '',
    onInputChange: vi.fn(),
    onAddLinks: vi.fn(),
    onRemove: vi.fn(),
    busy: false,
    invalid: [] as MrLinkParseFailure[],
    onDismissInvalid: vi.fn(),
    candidates,
    candidatesLoading: false,
    candidatesError: '',
    onLoadCandidates: vi.fn(),
    onToggleCandidate: vi.fn(),
    ...overrides,
  };
  render(<ReferenceMrPanel {...props} />);
  return props;
}

const panel = () => screen.getByRole('region', { name: '参考 MR' });
const expand = () => fireEvent.click(screen.getByRole('button', { name: /^参考 MR/ }));
const linkBox = () => screen.getByRole('textbox', { name: '参考 MR 链接' });

afterEach(cleanup);

describe('ReferenceMrPanel', () => {
  it('stays collapsed with a one-line summary until opened', () => {
    setup({ references: [companion] });
    expect(screen.getByRole('button', { name: /^参考 MR/ })).toHaveTextContent('1 个已就绪');
    expect(screen.queryByRole('textbox', { name: '参考 MR 链接' })).not.toBeInTheDocument();
    expand();
    expect(linkBox()).toBeInTheDocument();
  });

  it('says the reference material never becomes a finding or a publish target', () => {
    setup();
    expand();
    expect(panel()).toHaveTextContent('Finding、行内评论与发布目标始终只针对当前 MR');
  });

  it('parses pasted links on click and on ⌘/Ctrl+Enter', () => {
    const props = setup({ input: 'https://other.test/platform/sdk/-/merge_requests/12' });
    expand();
    fireEvent.click(screen.getByRole('button', { name: '解析并拉取' }));
    expect(props.onAddLinks).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(linkBox(), { key: 'Enter', metaKey: true });
    expect(props.onAddLinks).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(linkBox(), { key: 'Enter' });
    expect(props.onAddLinks).toHaveBeenCalledTimes(2);
  });

  it('disables adding while a fetch is in flight or the box is empty', () => {
    setup({ busy: true, input: 'https://other.test/platform/sdk/-/merge_requests/12' });
    expand();
    expect(screen.getByRole('button', { name: '拉取中' })).toBeDisabled();
    cleanup();
    setup({ input: '   ' });
    expand();
    expect(screen.getByRole('button', { name: '解析并拉取' })).toBeDisabled();
  });

  it('shows every unusable link with its own reason and can be dismissed', () => {
    const props = setup({
      invalid: [
        { input: 'https://gitlab.test/g/p/-/issues/2', reason: '不是 Merge Request 链接' },
        { input: 'https://gitlab.test/acme/app/-/merge_requests/248', reason: '这就是当前正在评审的 MR，不需要当参考' },
      ],
    });
    expand();
    expect(panel()).toHaveTextContent('2 个链接没有加进来');
    expect(panel()).toHaveTextContent('不是 Merge Request 链接');
    expect(panel()).toHaveTextContent('这就是当前正在评审的 MR');
    fireEvent.click(screen.getByRole('button', { name: '忽略链接解析提示' }));
    expect(props.onDismissInvalid).toHaveBeenCalledTimes(1);
  });

  it('shows a ready reference with its file count, head sha and a link back to GitLab', () => {
    setup({ references: [companion] });
    expand();
    const row = within(panel());
    expect(row.getByText('platform/sdk!12')).toBeInTheDocument();
    expect(row.getByText('已就绪')).toBeInTheDocument();
    expect(row.getByText('1 个变更文件 · head abcdef12')).toBeInTheDocument();
    expect(row.getByText('feat: companion token endpoint')).toBeInTheDocument();
    expect(row.getByRole('link', { name: /platform\/sdk!12/ })).toHaveAttribute('href', 'https://other.test/platform/sdk/-/merge_requests/12');
  });

  it('spells out why a reference could not be fetched', () => {
    setup({
      references: [{
        ...companion, status: 'failed', files: [], title: undefined, headSha: undefined,
        error: '找不到 platform/sdk!12（HTTP 404）：MR 不存在、被删除，或 Token 看不到该项目',
      }],
    });
    expand();
    expect(panel()).toHaveTextContent('拉取失败');
    expect(panel()).toHaveTextContent('找不到 platform/sdk!12（HTTP 404）');
    expect(screen.getByRole('button', { name: /^参考 MR/ })).toHaveTextContent('1 个失败');
  });

  it('flags a reference that returned no changed files', () => {
    setup({ references: [{ ...companion, files: [], error: '这个 MR 没有读到任何变更文件（可能是空 MR，或 diff 还没生成）' }] });
    expand();
    expect(panel()).toHaveTextContent('这个 MR 没有读到任何变更文件');
  });

  it('shows a loading reference as still in flight', () => {
    setup({ references: [{ ...companion, status: 'loading', files: [], title: undefined, headSha: undefined }] });
    expand();
    expect(panel()).toHaveTextContent('拉取中');
    expect(screen.getByRole('button', { name: /^参考 MR/ })).toHaveTextContent('1 个拉取中');
  });

  it('removes a reference on demand', () => {
    const props = setup({ references: [companion] });
    expand();
    fireEvent.click(screen.getByRole('button', { name: '移除参考 MR platform/sdk!12' }));
    expect(props.onRemove).toHaveBeenCalledWith('https://other.test|platform/sdk|12');
  });

  it('locks edits while a review is running', () => {
    setup({ references: [companion], disabled: true, input: 'x' });
    expand();
    expect(linkBox()).toBeDisabled();
    expect(screen.getByRole('button', { name: '移除参考 MR platform/sdk!12' })).toBeDisabled();
  });

  it('loads candidates on first open, pinning local review history above GitLab recent activity', () => {
    const props = setup({ references: [companion] });
    expand();
    expect(props.onLoadCandidates).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '从最近活动选择' }));
    expect(props.onLoadCandidates).toHaveBeenCalledTimes(1);

    const historyGroup = within(panel()).getByText('本工具评审过的 MR').parentElement!;
    expect(within(historyGroup).getByText('acme/app!248')).toBeInTheDocument();
    expect(within(historyGroup).queryByText('group/web!7')).not.toBeInTheDocument();
    const recentGroup = within(panel()).getByText('GitLab 最近活动').parentElement!;
    expect(within(recentGroup).getByText('group/web!7')).toBeInTheDocument();
    expect(within(panel()).getByText('GitLab 最近活动')).toBeInTheDocument();
    const checkboxes = within(panel()).getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[1]).toBeChecked();
    expect(checkboxes[0]).not.toBeChecked();
  });

  it('toggles a candidate on and off', () => {
    const props = setup({ references: [companion] });
    expand();
    fireEvent.click(screen.getByRole('button', { name: '从最近活动选择' }));
    const checkboxes = within(panel()).getAllByRole('checkbox');
    fireEvent.click(checkboxes[2]);
    expect(props.onToggleCandidate).toHaveBeenCalledWith('https://gitlab.test|group/web|7');
    fireEvent.click(checkboxes[1]);
    expect(props.onToggleCandidate).toHaveBeenCalledWith('https://other.test|platform/sdk|12');
  });

  it('reports a failing candidate list instead of showing nothing', () => {
    setup({ candidatesError: 'GitLab API 401：unauthorized' });
    expand();
    fireEvent.click(screen.getByRole('button', { name: '从最近活动选择' }));
    expect(panel()).toHaveTextContent('最近活动列表读取失败：GitLab API 401：unauthorized');
    expect(panel()).toHaveTextContent('可以直接把 MR 链接粘到上面的输入框');
  });

  it('says so when there is nothing to pick', () => {
    setup({ candidates: [] });
    expand();
    fireEvent.click(screen.getByRole('button', { name: '从最近活动选择' }));
    expect(panel()).toHaveTextContent('没有可用的候选 MR');
  });

  it('shows the loading state of the candidate list', () => {
    setup({ candidatesLoading: true, candidates: [] });
    expand();
    fireEvent.click(screen.getByRole('button', { name: '从最近活动选择' }));
    expect(panel()).toHaveTextContent('正在读取 GitLab 最近活动 MR');
  });
});
