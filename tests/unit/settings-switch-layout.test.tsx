import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../../src/components/SettingsView';
import { Toggle } from '../../src/components/ui/modern';
import { BUILT_IN_PACK } from '../../src/core/rule-packs';
import { defaultSettings } from '../../src/core/settings';
import type { RuntimeSettings } from '../../src/core/types';

const noop = () => undefined;

const settings: RuntimeSettings = {
  ...defaultSettings,
  repoIndex: { ...defaultSettings.repoIndex, enabled: true },
  mcp: { enabled: true, servers: [{ id: 'mcp-1', name: 'fs', url: 'http://127.0.0.1:3000/mcp', enabled: true }] },
};

function settingsView() {
  return render(
    <SettingsView
      settings={settings}
      onSettingsChange={noop}
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
      projectKey="acme/app"
      packScope="public"
      projectLabel="acme/app"
      publicCustomCount={0}
      onPackScopeChange={noop}
      onSettingsCommit={noop}
      onOpenDebug={noop}
      importError=""
      usageSummary={null}
      onClearUsage={noop}
      capabilities={undefined}
      onProbeCapabilities={noop}
      onExportSiteConfig={noop}
      testing={false}
    />,
  );
}

describe('Toggle 开关', () => {
  it('固定 40x22 且不允许被 flex 压缩', () => {
    const { container } = render(<Toggle checked onChange={noop} />);
    const sw = container.querySelector('[role="switch"]') as HTMLElement;
    expect(sw.style.flexShrink).toBe('0');
    expect(sw.style.width).toBe('40px');
    expect(sw.style.height).toBe('22px');
  });
});

describe('SettingsView 开关行与栅格', () => {
  it('每个开关都保持固定尺寸，不被同行文案挤压', () => {
    const { container } = settingsView();
    const switches = [...container.querySelectorAll('[role="switch"]')] as HTMLElement[];
    expect(switches.length).toBeGreaterThanOrEqual(6);
    for (const sw of switches) {
      expect(sw.style.flexShrink, sw.getAttribute('aria-label') ?? '').toBe('0');
      expect(sw.style.width).toBe('40px');
    }
  });

  it('开关行文案容器可收缩，长 token 允许断行', () => {
    const { container } = settingsView();
    const title = [...container.querySelectorAll('div')].find(
      (el) => el.children.length === 0 && el.textContent === '关闭思考输出',
    );
    expect(title).toBeTruthy();
    const wrap = title!.parentElement as HTMLElement;
    expect(wrap.style.minWidth).toBe('0px');
    const desc = title!.nextElementSibling as HTMLElement;
    expect(desc.style.overflowWrap).toBe('anywhere');
  });

  it('两列栅格使用 minmax(0, 1fr)，输入框固有宽度不撑破容器', () => {
    const { container } = settingsView();
    const grids = [...container.querySelectorAll('div')].filter((el) => (el as HTMLElement).style.display === 'grid');
    expect(grids.length).toBeGreaterThanOrEqual(3);
    for (const grid of grids) {
      expect((grid as HTMLElement).style.gridTemplateColumns, grid.textContent?.slice(0, 24)).toContain('minmax(0, 1fr)');
    }
  });
});
