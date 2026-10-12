import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsView } from '../../src/components/SettingsView';
import { BUILT_IN_PACK } from '../../src/core/rule-packs';
import { defaultSettings } from '../../src/core/settings';
import type { RuntimeSettings } from '../../src/core/types';

const noop = () => undefined;

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
const stored = () => JSON.parse(screen.getByTestId('stored').textContent ?? '{}');

afterEach(cleanup);

describe('设置页项目补充 System Prompt 历史', () => {
  it('提示文案能看出历史条数与每项目上限', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第二版', 'acme/other': '别的项目' },
      projectPromptHistory: { 'acme/app': ['第二版', '第一版'], 'acme/other': ['别的项目'] },
    }} />);
    expect(screen.getByText('已缓存 2 个项目的补充提示，共 3 条历史（每项目最多 10 条）；起始页「开始一次混合评审」里也能直接编辑当前项目。')).toBeInTheDocument();
    expect(screen.getByText('注入 acme/app 的混合评审 user 消息；按项目保留最近 10 条历史，输入框里 ↑↓ 翻看')).toBeInTheDocument();
  });

  it('↑↓ 在设置页输入框里同样翻该项目的历史', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第二版' },
      projectPromptHistory: { 'acme/app': ['第二版', '第一版', '第零版'] },
    }} />);
    expect(box()).toHaveValue('第二版');

    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box()).toHaveValue('第一版');
    expect(stored().prompts['acme/app']).toBe('第一版');

    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box()).toHaveValue('第二版');
  });

  it('失焦保存把当前值追加进该项目历史', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第一版' },
      projectPromptHistory: { 'acme/app': ['第一版'] },
    }} />);
    fireEvent.change(box(), { target: { value: '第二版' } });
    expect(stored().history['acme/app']).toEqual(['第一版']);

    fireEvent.blur(box());
    expect(stored().history['acme/app']).toEqual(['第二版', '第一版']);
    expect(stored().prompts['acme/app']).toBe('第二版');
  });

  it('切换到别的项目时输入框和历史一起换', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '当前项目', 'acme/other': '别的项目' },
      projectPromptHistory: { 'acme/app': ['当前项目'], 'acme/other': ['别的项目', '别的项目旧版'] },
    }} />);
    selectProject('acme/other');
    expect(box()).toHaveValue('别的项目');
    expect(screen.getByRole('button', { name: '项目补充要求历史' })).toHaveTextContent('2');

    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box()).toHaveValue('别的项目旧版');
  });

  it('列表里单删一条历史，当前生效值不动', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第二版' },
      projectPromptHistory: { 'acme/app': ['第二版', '写错的一条'] },
    }} />);
    fireEvent.click(screen.getByRole('button', { name: '项目补充要求历史' }));
    fireEvent.click(within(listOf()).getAllByRole('button', { name: '删除这条补充要求' })[1]);
    expect(stored().history['acme/app']).toEqual(['第二版']);
    expect(stored().prompts['acme/app']).toBe('第二版');
  });

  it('删除按钮连当前值和历史一起清掉，历史只剩别的项目时也能继续选', () => {
    render(<Harness settings={{
      projectPrompts: { 'acme/app': '第二版' },
      projectPromptHistory: { 'acme/app': ['第二版', '第一版'] },
    }} />);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(stored().prompts).toEqual({});
    expect(stored().history).toEqual({});
    expect(box()).toHaveValue('');
    expect(screen.queryByRole('button', { name: '项目补充要求历史' })).not.toBeInTheDocument();
  });

  it('只有历史、当前值为空的项目也会出现在下拉里', () => {
    render(<Harness settings={{ projectPromptHistory: { 'acme/legacy': ['很久以前的要求'] } }} />);
    selectProject('acme/legacy');
    expect(box()).toHaveValue('');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box()).toHaveValue('很久以前的要求');
  });
});
