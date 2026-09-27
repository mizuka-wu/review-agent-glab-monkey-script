import { useState } from 'react';
import { Check, X, Eye, EyeOff, ChevronDown, ChevronRight, Cpu, Globe, Package, Puzzle, Shield, TestTube } from 'lucide-react';
import type { RuntimeSettings, RulePack } from '../core/types';
import { defaultSettings } from '../core/settings';
import { BUILT_IN_PACK } from '../core/rule-packs';
import type { UsageSummary } from '../core/usage';
import { formatTokenCount, formatCost } from '../core/usage';

interface SettingsViewProps {
  settings: RuntimeSettings;
  onSettingsChange: (s: RuntimeSettings) => void;
  onSave: () => void;
  onTestModel: () => void;
  onClearApiKey: () => void;
  rulePacks: RulePack[];
  onToggleRulePack: (id: string, enabled: boolean) => void;
  onDeleteRulePack: (id: string) => void;
  onImportRulePack: (json: string) => void;
  onExportRulePack: (id: string) => void;
  onUpdateRulePack: (id: string, patch: Partial<RulePack>) => void;
  importError: string;
  usageSummary: UsageSummary | null;
  onClearUsage: () => void;
  capabilities?: { authenticated: boolean; canReadMergeRequests: boolean; canCreateDiscussions: boolean } | undefined;
  onProbeCapabilities: () => void;
  onExportSiteConfig: () => void;
  testing: boolean;
}

export function SettingsView({
  settings, onSettingsChange, onSave, onTestModel, onClearApiKey,
  rulePacks, onToggleRulePack, onDeleteRulePack, onImportRulePack, onExportRulePack, onUpdateRulePack,
  importError, usageSummary, onClearUsage, capabilities, onProbeCapabilities, onExportSiteConfig, testing,
}: SettingsViewProps) {
  const [showKey, setShowKey] = useState(false);
  const [importText, setImportText] = useState('');
  const [editingPackId, setEditingPackId] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, paddingBottom: 24 }}>
      {/* Model Config */}
      <Section icon={<Cpu size={15} />} title="模型配置" desc="选择提供商后自动填充默认地址和模型">
        <div style={{ display: 'grid', gap: 10 }}>
          <Field label="API Key" required hint="唯一必填项">
            <div style={{ position: 'relative' }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={settings.apiKey}
                onChange={(e) => onSettingsChange({ ...settings, apiKey: e.target.value })}
                autoComplete="off"
                placeholder="sk-..."
                style={inputStyle}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', border: 0, background: 'transparent', cursor: 'pointer', color: '#8a9bb0', padding: 2 }}
              >{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            </div>
          </Field>
          <Field label="Base URL" hint="OpenAI 兼容接口地址">
            <input value={settings.modelBaseUrl} onChange={(e) => onSettingsChange({ ...settings, modelBaseUrl: e.target.value })} placeholder="https://api.openai.com/v1" style={inputStyle} />
          </Field>
          <ModelPicker
            value={settings.model}
            baseUrl={settings.modelBaseUrl}
            apiKey={settings.apiKey}
            onChange={(model) => onSettingsChange({ ...settings, model })}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
            <Btn variant="outline" onClick={onClearApiKey} icon={<X size={13} />}>清除密钥</Btn>
            <Btn variant="outline" onClick={onTestModel} icon={<TestTube size={13} />} disabled={testing}>{testing ? '测试中…' : '测试模型'}</Btn>
            <div style={{ flex: 1 }} />
            <Btn variant="primary" onClick={onSave} icon={<Check size={13} />}>保存</Btn>
          </div>
        </div>
      </Section>

      {/* Review Settings */}
      <Section icon={<Shield size={15} />} title="审查设置">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="审查强度">
            <select value={settings.effort} onChange={(e) => onSettingsChange({ ...settings, effort: e.target.value as RuntimeSettings['effort'] })} style={inputStyle}>
              <option value="fast">快速（仅高置信度）</option>
              <option value="balanced">均衡（推荐）</option>
              <option value="thorough">全面（更多问题）</option>
            </select>
          </Field>
          <Field label="输出语言">
            <select value={settings.language} onChange={(e) => onSettingsChange({ ...settings, language: e.target.value as RuntimeSettings['language'] })} style={inputStyle}>
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </select>
          </Field>
        </div>
      </Section>

      {/* GitLab API */}
      <Section icon={<Globe size={15} />} title="GitLab API" badge={capabilities?.authenticated ? '已连接' : undefined}>
        <Field label="Personal Access Token" hint="同源 REST API 使用浏览器 Cookie，可选 PAT">
          <input type="password" value={settings.gitlabToken} onChange={(e) => onSettingsChange({ ...settings, gitlabToken: e.target.value })} autoComplete="off" placeholder="glpat-...（可选）" style={inputStyle} />
        </Field>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Btn variant="outline" onClick={onProbeCapabilities}>检测权限</Btn>
          {capabilities && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: '#5a6b80' }}>
              <CapBadge ok={capabilities.authenticated} label="认证" />
              <CapBadge ok={capabilities.canReadMergeRequests} label="读 MR" />
              <CapBadge ok={capabilities.canCreateDiscussions} label="发评论" />
            </div>
          )}
        </div>
      </Section>

      {/* Token Usage */}
      {usageSummary && usageSummary.callCount > 0 && (
        <Section icon={<TestTube size={15} />} title="Token 用量">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <Stat label="调用次数" value={String(usageSummary.callCount)} />
            <Stat label="输入 Tokens" value={formatTokenCount(usageSummary.totalInputTokens)} />
            <Stat label="输出 Tokens" value={formatTokenCount(usageSummary.totalOutputTokens)} />
            <Stat label="估算费用" value={formatCost(usageSummary.totalEstimatedCost)} />
          </div>
          {Object.entries(usageSummary.byModel).map(([key, data]) => (
            <div key={key} style={{ fontSize: 10, color: '#5a6b80', marginTop: 6, fontFamily: 'monospace' }}>
              {key}: {formatTokenCount(data.inputTokens)} → {formatTokenCount(data.outputTokens)}
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <Btn variant="outline" onClick={onClearUsage}>清空记录</Btn>
          </div>
        </Section>
      )}

      {/* Rule Packs */}
      <Section icon={<Package size={15} />} title="规则包" desc="未配置模型时使用已启用的规则包">
        {rulePacks.map(pack => (
          <RulePackCard
            key={pack.id}
            pack={pack}
            editing={editingPackId === pack.id}
            onToggleEdit={() => setEditingPackId(editingPackId === pack.id ? null : pack.id)}
            onToggle={(enabled) => onToggleRulePack(pack.id, enabled)}
            onDelete={() => onDeleteRulePack(pack.id)}
            onExport={() => onExportRulePack(pack.id)}
            onUpdate={(patch) => onUpdateRulePack(pack.id, patch)}
          />
        ))}
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          <Field label="导入规则包">
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="粘贴规则包 JSON…"
              rows={3}
              style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }}
            />
          </Field>
          {importError && <div style={{ color: '#d3453b', fontSize: 11 }}>{importError}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="outline" onClick={() => { onImportRulePack(importText); setImportText(''); }}>导入</Btn>
            <Btn variant="outline" onClick={() => { onExportSiteConfig(); }}>导出站点配置</Btn>
          </div>
        </div>
      </Section>

      {/* MCP */}
      <Section icon={<Puzzle size={15} />} title="MCP 扩展工具" desc="HTTP transport（Streamable HTTP / SSE），不支持 stdio" badge={settings.mcp.enabled ? '已启用' : undefined}>
        <Field label="启用 MCP">
          <select value={settings.mcp.enabled ? 'on' : 'off'} onChange={(e) => onSettingsChange({ ...settings, mcp: { ...settings.mcp, enabled: e.target.value === 'on' } })} style={inputStyle}>
            <option value="off">关闭</option>
            <option value="on">开启</option>
          </select>
        </Field>
        {settings.mcp.enabled && (
          <div style={{ marginTop: 8 }}>
            <Field label="MCP Server URL">
              <input value={settings.mcp.serverUrl} onChange={(e) => onSettingsChange({ ...settings, mcp: { ...settings.mcp, serverUrl: e.target.value } })} placeholder="http://localhost:3000/mcp" style={inputStyle} />
            </Field>
          </div>
        )}
      </Section>
    </div>
  );
}

// --- Sub-components ---

function Section({ icon, title, desc, badge, children }: {
  icon: React.ReactNode; title: string; desc?: string; badge?: string; children: React.ReactNode;
}) {
  return (
    <div style={{ border: '1px solid #d4dae3', borderRadius: 10, overflow: 'hidden', background: '#ffffff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: '#f4f6f9', borderBottom: '1px solid #e8edf3' }}>
        <span style={{ color: '#245fc7', display: 'flex' }}>{icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#1a2332' }}>{title}</div>
          {desc && <div style={{ fontSize: 10, color: '#8a9bb0', marginTop: 1 }}>{desc}</div>}
        </div>
        {badge && <span style={{ fontSize: 10, fontWeight: 600, color: '#1a7a42', background: '#e6f4ec', padding: '2px 8px', borderRadius: 10 }}>{badge}</span>}
      </div>
      <div style={{ padding: 12 }}>{children}</div>
    </div>
  );
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: '#1a2332' }}>{label}</label>
        {required && <span style={{ fontSize: 10, color: '#d3453b', fontWeight: 600 }}>必填</span>}
        {hint && <span style={{ fontSize: 10, color: '#8a9bb0' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function ModelPicker({ value, baseUrl, apiKey, onChange }: { value: string; baseUrl: string; apiKey: string; onChange: (model: string) => void }) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [manual, setManual] = useState(false);

  const fetchModels = async () => {
    if (!baseUrl) return;
    setLoading(true);
    setError('');
    try {
      const url = baseUrl.replace(/\/$/, '') + '/models';
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { data?: Array<{ id: string }> };
      setModels((data.data ?? []).map(m => m.id).sort());
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取模型列表失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Field label="模型" hint={models.length > 0 ? `${models.length} 个可用模型` : '点击刷新获取模型列表'}>
      <div style={{ display: 'flex', gap: 6 }}>
        {manual ? (
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="gpt-4o-mini"
            style={{ ...inputStyle, flex: 1 }}
          />
        ) : (
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          >
            <option value="">{loading ? '加载中…' : models.length === 0 ? '— 点击刷新获取 —' : '选择模型'}</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
            {value && !models.includes(value) && <option value={value}>{value}</option>}
          </select>
        )}
        <Btn variant="outline" onClick={() => { if (manual) { setManual(false); } else { void fetchModels(); } }} disabled={loading && !manual}>
          {manual ? '列表' : loading ? '…' : '刷新'}
        </Btn>
        <Btn variant="outline" onClick={() => setManual(!manual)}>
          {manual ? '下拉' : '手动'}
        </Btn>
      </div>
      {error && <div style={{ color: '#d3453b', fontSize: 11, marginTop: 4 }}>{error}</div>}
    </Field>
  );
}

function RulePackCard({ pack, editing, onToggleEdit, onToggle, onDelete, onExport, onUpdate }: {
  pack: RulePack; editing: boolean;
  onToggleEdit: () => void; onToggle: (enabled: boolean) => void; onDelete: () => void; onExport: () => void;
  onUpdate: (patch: Partial<RulePack>) => void;
}) {
  const isBuiltin = pack.id === BUILT_IN_PACK.id;
  return (
    <div style={{ border: '1px solid #e8edf3', borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: pack.enabled ? '#f0f8f4' : '#f8f9fa' }}>
        <input type="checkbox" checked={pack.enabled} onChange={(e) => onToggle(e.target.checked)} style={{ accentColor: '#245fc7' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#1a2332' }}>{pack.name}</span>
            <span style={{ fontSize: 9, color: '#5a6b80', background: '#e8edf3', padding: '1px 5px', borderRadius: 4 }}>{pack.version}</span>
            <span style={{ fontSize: 9, color: '#5a6b80', background: '#e8edf3', padding: '1px 5px', borderRadius: 4 }}>{pack.rules.length} 条</span>
            {isBuiltin && <span style={{ fontSize: 9, color: '#245fc7', background: '#e8f0fe', padding: '1px 5px', borderRadius: 4 }}>内置</span>}
          </div>
          {pack.description && <div style={{ fontSize: 10, color: '#8a9bb0', marginTop: 2 }}>{pack.description}</div>}
        </div>
        <button type="button" onClick={onToggleEdit} style={{ ...iconBtn, color: '#5a6b80' }}>
          {editing ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {!isBuiltin && (
          <>
            <button type="button" onClick={onExport} style={{ ...iconBtn, color: '#5a6b80' }} title="导出">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            </button>
            <button type="button" onClick={onDelete} style={{ ...iconBtn, color: '#d3453b' }} title="删除">
              <X size={13} />
            </button>
          </>
        )}
      </div>
      {editing && (
        <div style={{ padding: 10, borderTop: '1px solid #e8edf3', display: 'grid', gap: 6 }}>
          <Field label="名称">
            <input value={pack.name} onChange={(e) => onUpdate({ name: e.target.value })} style={inputStyle} />
          </Field>
          <Field label="描述">
            <input value={pack.description ?? ''} onChange={(e) => onUpdate({ description: e.target.value })} style={inputStyle} />
          </Field>
          <div>
            <div style={{ fontSize: 11, fontWeight: 500, color: '#5a6b80', marginBottom: 4 }}>规则列表</div>
            {pack.rules.map((rule, i) => (
              <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 11, borderTop: '1px solid #f0f3f7' }}>
                <span style={{ color: '#245fc7', fontWeight: 600 }}>{rule.category}</span>
                <span style={{ color: '#5a6b80' }}>{rule.severity}</span>
                <span style={{ color: '#1a2332', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rule.title}</span>
                <span style={{ color: '#8a9bb0', fontSize: 10 }}>{rule.patterns.length} patterns</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CapBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span style={{
      fontSize: 10, padding: '1px 6px', borderRadius: 4, fontWeight: 500,
      color: ok ? '#1a7a42' : '#8a9bb0',
      background: ok ? '#e6f4ec' : '#f0f3f7',
    }}>{ok ? '✓' : '✗'} {label}</span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#f4f6f9', borderRadius: 6, padding: '6px 8px' }}>
      <div style={{ fontSize: 10, color: '#8a9bb0' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#1a2332', fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

function Btn({ variant, onClick, icon, disabled, children }: {
  variant?: 'primary' | 'outline'; onClick: () => void; icon?: React.ReactNode; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500,
        border: variant === 'primary' ? '1px solid #245fc7' : '1px solid #d4dae3',
        background: variant === 'primary' ? '#245fc7' : '#ffffff',
        color: variant === 'primary' ? '#ffffff' : '#2d3748',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >{icon}{children}</button>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 6,
  border: '1px solid #d4dae3', fontSize: 12, color: '#1a2332',
  background: '#ffffff', outline: 'none', boxSizing: 'border-box',
};

const iconBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 26, height: 26, borderRadius: 5, border: 0, background: 'transparent',
  cursor: 'pointer', padding: 0,
};
