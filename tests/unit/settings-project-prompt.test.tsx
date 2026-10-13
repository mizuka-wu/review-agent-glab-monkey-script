import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsView } from '../../src/components/SettingsView';
import { BUILT_IN_PACK } from '../../src/core/rule-packs';
import { defaultSettings } from '../../src/core/settings';
import type { ProjectPromptHistoryEntry, RuntimeSettings } from '../../src/core/types';

const noop = () => undefined;
const entry = (value: string, projectKey: string): ProjectPromptHistoryEntry => ({ value, projectKey });

function Harness({ settings: initial, projectKey = 'acme/app' }: {
  settings?: Partial<RuntimeSettings>; projectKey?: string;
}) {
  const [settings, setSettings] = useState<RuntimeSettings>({ ...defaultSettings, ...initial });
  return (
    <>
      <SettingsView
        settings={settings}
        onSettingsChange={setSettings}
        onSave={noop}
        onTestModel={noop}
        onClearApiKey={noop}
        rulePacks={[BUILT_IN_PACK]}
        onToggleRulePack={noop}
        onDeleteRulePack={noop}
        onImportRulePack={noop}
        onExportRulePack={noop}
        onUpdateRulePack={noop}
        onToggleRule={noop}
        onNewRulePack={noop}
        projectKey={projectKey}
        packScope="public"
        projectLabel={projectKey}
        publicCustomCount={0}
        onPackScopeChange={noop}
        onSettingsCommit={setSettings}
        onOpenDebug={noop}
        importError=""
        usageSummary={null}
        onClearUsage={noop}
        capabilities={undefined}
        onProbeCapabilities={noop}
        onExportSiteConfig={noop}
        testing={false}
      />
      <output data-testid="stored">{JSON.stringify({
        prompts: settings.projectPrompts, history: settings.projectPromptHistory,
      })}</output>
    </>
  );
}

const box = () => screen.getByRole('textbox', { name: '项目补充 System Prompt' }) as HTMLTextAreaElement;

/** ui/modern 的 Select 是按钮式下拉，不是原生 combobox：先点触发器再点选项。 */
function selectProject(key: string) {
  const trigger = screen.getAllByRole('button').find(
    (el) => /^(acme\/[\w-]+)(（当前）)?$/.test((el.textContent ?? '').trim()),
  );
  fireEvent.click(trigger!);
  fireEvent.click(screen.getByRole('button', { name: key === 'acme/app' ? 'acme/app（当前）' : key }));
}
const listOf = () => screen.getByRole('listbox', { name: '项目补充要求历史列表' });
const historyButton = () => screen.getByRole('button', { name: '项目补充要求历史' });
const stored = () => JSON.parse(screen.getByTestId('stored').textContent ?? '{}');
const storedPool = () => stored().history as ProjectPromptHistoryEntry[];
const storedValues = () => storedPool().map((item) => item.value);
const options = () => within(listOf()).getAllByRole('option');

/** 打开历史列表并点第 index 条：↑↓ 已经不是入口，挑历史只能走按钮。 */
function pickEntry(index: number) {
  fireEvent.click(historyButton());
  fireEvent.click(options()[index]);
}

/** 派发原生按键事件：defaultPrevented 直接说明这一次按键有没有被脚本拦下来。 */
function press(key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  box().dispatchEvent(event);
  return event;
}

afterEach(cleanup);

describe('设置页项目补充 System Prompt 历史', () => {
  it('提示文案说明历史池全局共用：条数、上限、来源项目数', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第二版', 'acme/other': '别的项目' },
      projectPromptHistory: [entry('第二版', 'acme/app'), entry('第一版', 'acme/app'), entry('别的项目', 'acme/other')],
    }} />);
    expect(screen.getByText('历史池全局共用：共 3 条历史（上限 30 条），来自 2 个项目；已缓存 2 个项目的当前补充提示。起始页「开始一次混合评审」里也能直接编辑当前项目。')).toBeInTheDocument();
    expect(screen.getByText('注入 acme/app 的混合评审 user 消息；历史所有项目共用一个池子（最近 30 条），点输入框右上角的历史按钮翻看')).toBeInTheDocument();
    expect(screen.queryByText(/每项目最多 10 条/)).not.toBeInTheDocument();
    expect(screen.queryByText(/输入框里 ↑↓ 翻看/)).not.toBeInTheDocument();
  });

  it('设置页输入框同样不劫持 ↑↓ / Esc：内容不变、按键不被拦截', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第一行\n第二行' },
      projectPromptHistory: [entry('第一行\n第二行', 'acme/app'), entry('第一版', 'acme/app'), entry('第零版', 'acme/app')],
    }} />);
    box().setSelectionRange(4, 4);

    expect(press('ArrowUp').defaultPrevented).toBe(false);
    expect(press('ArrowDown').defaultPrevented).toBe(false);
    expect(box()).toHaveValue('第一行\n第二行');
    expect(box().selectionStart).toBe(4);
    expect(stored().prompts['acme/app']).toBe('第一行\n第二行');

    expect(press('Escape').defaultPrevented).toBe(false);
    expect(box()).toHaveValue('第一行\n第二行');
  });

  it('历史按钮坐在输入框右上角，点开挑一条填回', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第二版' },
      projectPromptHistory: [entry('第二版', 'acme/app'), entry('第一版', 'acme/app'), entry('第零版', 'acme/app')],
    }} />);
    expect(historyButton()).toHaveTextContent('3');
    expect(box().style.paddingRight).toBe('56px');

    pickEntry(1);
    expect(box()).toHaveValue('第一版');
    expect(stored().prompts['acme/app']).toBe('第一版');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('失焦保存把当前值追加进全局池最前', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第一版' },
      projectPromptHistory: [entry('第一版', 'acme/app')],
    }} />);
    fireEvent.change(box(), { target: { value: '第二版' } });
    expect(storedValues()).toEqual(['第一版']);

    fireEvent.blur(box());
    expect(storedValues()).toEqual(['第二版', '第一版']);
    expect(storedPool()[0]).toEqual(entry('第二版', 'acme/app'));
    expect(stored().prompts['acme/app']).toBe('第二版');
  });

  it('切换到别的项目时只换当前值，全局池的条目一条不变', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '当前项目', 'acme/other': '别的项目' },
      projectPromptHistory: [entry('别的项目', 'acme/other'), entry('别的项目旧版', 'acme/other'), entry('当前项目', 'acme/app')],
    }} />);
    expect(historyButton()).toHaveTextContent('3');

    selectProject('acme/other');
    expect(box()).toHaveValue('别的项目');
    expect(historyButton()).toHaveTextContent('3');

    fireEvent.click(historyButton());
    expect(options().map((option) => option.textContent)).toEqual([
      '别的项目acme/other', '别的项目旧版acme/other', '当前项目acme/app',
    ]);
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(options()[1]);
    expect(box()).toHaveValue('别的项目旧版');
    expect(stored().prompts['acme/other']).toBe('别的项目旧版');
    expect(stored().prompts['acme/app']).toBe('当前项目');
  });

  it('跨项目挑一条填回：当前值归到正在管理的项目，池子里这条的来源项目跟着更新', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '当前项目', 'acme/other': '别的项目' },
      projectPromptHistory: [entry('别的项目', 'acme/other'), entry('当前项目', 'acme/app')],
    }} />);
    selectProject('acme/other');
    fireEvent.click(historyButton());
    fireEvent.click(options()[1]);
    expect(box()).toHaveValue('当前项目');
    expect(stored().prompts['acme/other']).toBe('当前项目');

    fireEvent.blur(box());
    expect(storedValues()).toEqual(['当前项目', '别的项目']);
    expect(storedPool()[0]).toEqual(entry('当前项目', 'acme/other'));
  });

  it('列表里单删一条历史，当前生效值不动', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第二版' },
      projectPromptHistory: [entry('第二版', 'acme/app'), entry('写错的一条', 'acme/app')],
    }} />);
    fireEvent.click(historyButton());
    fireEvent.click(within(listOf()).getAllByRole('button', { name: '删除这条补充要求' })[1]);
    expect(storedValues()).toEqual(['第二版']);
    expect(stored().prompts['acme/app']).toBe('第二版');
  });

  it('删掉别的项目存过的条目，当前项目的当前值和条目都不受影响', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第二版' },
      projectPromptHistory: [entry('第二版', 'acme/app'), entry('别的项目的噪声', 'acme/other')],
    }} />);
    fireEvent.click(historyButton());
    fireEvent.click(within(listOf()).getAllByRole('button', { name: '删除这条补充要求' })[1]);
    expect(storedPool()).toEqual([entry('第二版', 'acme/app')]);
    expect(stored().prompts['acme/app']).toBe('第二版');
    expect(box()).toHaveValue('第二版');
  });

  it('删除按钮清掉当前值和该项目在池子里的条目，别的项目的条目还能继续选', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第二版' },
      projectPromptHistory: [entry('第二版', 'acme/app'), entry('第一版', 'acme/app'), entry('别的项目', 'acme/other')],
    }} />);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(stored().prompts).toEqual({});
    expect(storedPool()).toEqual([entry('别的项目', 'acme/other')]);
    expect(box()).toHaveValue('');
    expect(historyButton()).toHaveTextContent('1');

    pickEntry(0);
    expect(box()).toHaveValue('别的项目');
    expect(stored().prompts['acme/app']).toBe('别的项目');
  });

  it('池子里只剩当前项目的条目时，删除后历史按钮消失、提示回到空态', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第二版' },
      projectPromptHistory: [entry('第二版', 'acme/app'), entry('第一版', 'acme/app')],
    }} />);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(stored().prompts).toEqual({});
    expect(storedPool()).toEqual([]);
    expect(box()).toHaveValue('');
    expect(screen.queryByRole('button', { name: '项目补充要求历史' })).not.toBeInTheDocument();
    expect(screen.getByText('失焦后自动存进历史，之后可以点历史按钮挑回之前写过的版本')).toBeInTheDocument();
  });

  it('只有历史、当前值为空的项目也会出现在下拉里', () => {
    render(<Harness settings={{ projectPromptHistory: [entry('很久以前的要求', 'acme/legacy')] }} />);
    selectProject('acme/legacy');
    expect(box()).toHaveValue('');
    press('ArrowUp');
    expect(box()).toHaveValue('');
    fireEvent.click(historyButton());
    expect(within(options()[0]).getByText('acme/legacy')).toBeInTheDocument();
    fireEvent.click(options()[0]);
    expect(box()).toHaveValue('很久以前的要求');
  });

  it('旧的按项目分桶历史在设置页合并成全局列表，每条标出来源项目', () => {
    render(<Harness settings={{
      projectPromptHistory: { 'acme/a': ['a2', 'a1'], 'acme/b': ['b1'] } as unknown as ProjectPromptHistoryEntry[],
    }} />);
    expect(historyButton()).toHaveTextContent('3');
    fireEvent.click(historyButton());
    expect(options().map((option) => option.textContent)).toEqual(['a2acme/a', 'a1acme/a', 'b1acme/b']);

    // 合并结果在下一次保存点落盘成全局池数组
    fireEvent.blur(box());
    expect(storedPool()).toEqual([entry('a2', 'acme/a'), entry('a1', 'acme/a'), entry('b1', 'acme/b')]);
  });

  it('下拉里列出池子里出现过的所有来源项目，跨项目直接管理', () => {
    render(<Harness settings={{
      projectPromptHistory: [entry('a1', 'acme/a'), entry('b1', 'acme/b')],
    }} />);
    selectProject('acme/b');
    expect(box()).toHaveValue('');
    fireEvent.change(box(), { target: { value: 'b 的新要求' } });
    fireEvent.blur(box());
    expect(storedValues()).toEqual(['b 的新要求', 'a1', 'b1']);
    expect(storedPool()[0]).toEqual(entry('b 的新要求', 'acme/b'));
    expect(stored().prompts).toEqual({ 'acme/b': 'b 的新要求' });
  });
});
