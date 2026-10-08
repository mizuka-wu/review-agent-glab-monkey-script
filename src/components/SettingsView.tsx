import { useEffect, useState } from 'react';
import {
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  Download,
  Eye,
  EyeOff,
  Globe,
  HelpCircle,
  Package,
  Plus,
  Puzzle,
  RefreshCw,
  Save,
  Shield,
  ShieldCheck,
  TestTube,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { McpServerEntry, RuntimeSettings } from '../core/types';
import type { UsageSummary } from '../core/usage';
import { formatTokenCount, formatCost } from '../core/usage';
import { BUILT_IN_PACK, countEnabledRules, type RulePack } from '../core/rule-packs';
import { modelConfigurationIssues } from '../core/settings';
import {
  Card, CardHeader, CardBody, Btn, Input, Select, Segmented, Toggle,
  Field, Badge, Banner, Divider, Spinner, tokens as C,
} from './ui/modern';

/** 常见本地 OpenAI 兼容服务端默认地址，均带 /v1 后缀。 */
const LOCAL_MODEL_ENDPOINTS = [
  { label: 'omlx', url: 'http://localhost:8000/v1' },
  { label: 'Ollama', url: 'http://localhost:11434/v1' },
  { label: 'LM Studio', url: 'http://localhost:1234/v1' },
];

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
  onToggleRule: (packId: string, ruleId: string) => void;
  onNewRulePack: () => void;
  projectKey: string;
  packScope: 'public' | 'project';
  projectLabel: string;
  publicCustomCount: number;
  onPackScopeChange: (kind: 'public' | 'project') => void;
  onSettingsCommit: (s: RuntimeSettings) => void;
  onOpenDebug: () => void;
  importError: string;
  usageSummary: UsageSummary | null;
  onClearUsage: () => void;
  capabilities?: { authenticated: boolean; canReadMergeRequests: boolean; canCreateDiscussions: boolean } | undefined;
  onProbeCapabilities: () => void;
  onExportSiteConfig: () => void;
  testing: boolean;
}

export function SettingsView(props: SettingsViewProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, paddingBottom: 32 }}>
      <StatusSection {...props} />
      <ModelSection {...props} />
      <ReviewSection {...props} />
      <RepoIndexSection {...props} />
      <GitLabSection {...props} />
      {props.usageSummary && props.usageSummary.callCount > 0 && <UsageSection {...props} />}
      <RulePackSection {...props} />
      <McpSection {...props} />
      <DebugSection {...props} />
    </div>
  );
}

// ─── Readiness overview ───
function StatusSection({ settings, rulePacks }: SettingsViewProps) {
  const issues = modelConfigurationIssues(settings);
  const modelReady = issues.length === 0;
  const ruleCount = countEnabledRules(rulePacks);

  return (
    <Card>
      <CardHeader
        icon={modelReady ? <ShieldCheck size={16} /> : <Shield size={16} />}
        title="当前能力"
        badge={modelReady ? { text: '规则 + AI', color: 'success' } : { text: '仅规则', color: 'warning' }}
      />
      <CardBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Capability
            ok
            name="确定性规则检查"
            detail={`${ruleCount} 条规则已启用 · 浏览器本地执行，不联网、不消耗 token`}
          />
          <Capability
            ok={Boolean(settings.gitlabToken) || true}
            name="读取 MR / Diff"
            detail={settings.gitlabToken ? '使用 Personal Access Token 调用 REST API' : '使用当前 GitLab 登录态（同源 Cookie）调用 REST API'}
          />
          <Capability
            ok={modelReady}
            name="AI 深度评审与对话"
            detail={modelReady
              ? `${settings.model} · ${settings.modelBaseUrl}`
              : issues.length > 0 ? `缺少：${issues.map((issue) => issue.label).join('、')}` : '未配置'}
          />
          {!modelReady && (
            <Banner tone="warning" title="未配置模型也能用">
              规则检查、划词定位、Finding 编辑、复制评论草稿都不依赖模型。填写 API Key 后即可叠加 AI 评审与对话。
            </Banner>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function Capability({ ok, name, detail }: { ok: boolean; name: string; detail: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <span style={{
        display: 'grid', placeItems: 'center', width: 16, height: 16, borderRadius: 8, marginTop: 1, flexShrink: 0,
        background: ok ? C.successBg : C.warningBg, color: ok ? C.success : C.warning,
      }}>
        {ok ? <Check size={11} /> : <X size={11} />}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: ok ? C.text : C.textSecondary }}>{name}</div>
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1, wordBreak: 'break-all' }}>{detail}</div>
      </div>
    </div>
  );
}

// ─── Model Config ───
function ModelSection({ settings, onSettingsChange, onSettingsCommit, onSave, onTestModel, onClearApiKey, testing }: SettingsViewProps) {
  const [showKey, setShowKey] = useState(false);
  const [showLocalHint, setShowLocalHint] = useState(false);

  return (
    <Card>
      <CardHeader icon={<Cpu size={16} />} title="模型配置" desc="OpenAI 兼容接口；不配置也能使用规则检查" />
      <CardBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="API Key" required hint="唯一必填项">
            <Input
              type={showKey ? 'text' : 'password'}
              value={settings.apiKey}
              onChange={v => onSettingsChange({ ...settings, apiKey: v })}
              placeholder="sk-..."
              autoComplete="new-password"
              rightIcon={
                <button type="button" onClick={() => setShowKey(!showKey)}
                  style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.textMuted, display: 'flex', padding: 0 }}>
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              }
            />
          </Field>

          <Field label="Base URL" hint="自部署 / 企业网关需要修改">
            <Input
              value={settings.modelBaseUrl}
              onChange={v => onSettingsChange({ ...settings, modelBaseUrl: v })}
              placeholder="https://api.openai.com/v1"
              mono
            />
          </Field>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[
              { label: '官方 OpenAI', url: 'https://api.openai.com/v1' },
            ].map(preset => (
              <button
                key={preset.url} type="button"
                onClick={() => onSettingsCommit({ ...settings, modelBaseUrl: preset.url })}
                style={{
                  padding: '3px 9px', borderRadius: 20, fontSize: 11, cursor: 'pointer',
                  border: `1px solid ${settings.modelBaseUrl === preset.url ? C.primary : C.border}`,
                  background: settings.modelBaseUrl === preset.url ? C.primaryLight : C.bg,
                  color: settings.modelBaseUrl === preset.url ? C.primary : C.textSecondary,
                  fontWeight: settings.modelBaseUrl === preset.url ? 700 : 500,
                }}
              >{preset.label}</button>
            ))}
          </div>

          <div>
            <button type="button" onClick={() => setShowLocalHint(!showLocalHint)}
              style={{ display: 'flex', alignItems: 'center', gap: 5, border: 0, background: 'transparent', cursor: 'pointer', color: C.textSecondary, fontSize: 11, padding: 0 }}>
              <HelpCircle size={13} /> 本地模型默认地址？
            </button>
            {showLocalHint && (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4, padding: 8, borderRadius: C.radiusSm, border: `1px solid ${C.border}`, background: C.bgMuted }}>
                {LOCAL_MODEL_ENDPOINTS.map(ep => (
                  <button key={ep.url} type="button"
                    onClick={() => onSettingsCommit({ ...settings, modelBaseUrl: ep.url })}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 8, border: 0, background: 'transparent', cursor: 'pointer', padding: '2px 0', fontSize: 11, color: settings.modelBaseUrl === ep.url ? C.primary : C.textSecondary, fontWeight: settings.modelBaseUrl === ep.url ? 700 : 500 }}>
                    <span>{ep.label}</span>
                    <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>{ep.url}</span>
                  </button>
                ))}
                <div style={{ fontSize: 11, color: C.textMuted }}>OpenAI 兼容端点通常以 /v1 结尾；localhost 端点会自动拉取模型列表。</div>
              </div>
            )}
          </div>

          <ModelPicker
            value={settings.model}
            baseUrl={settings.modelBaseUrl}
            apiKey={settings.apiKey}
            onChange={m => onSettingsCommit({ ...settings, model: m })}
          />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>关闭思考输出</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                通过 chat_template_kwargs.enable_thinking=false 关闭 omlx / vLLM 系服务端的思考过程
              </div>
            </div>
            <Toggle
              checked={settings.thinking === 'off'}
              onChange={v => onSettingsChange({ ...settings, thinking: v ? 'off' : 'default' })}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <Btn variant="ghost" icon={<X size={14} />} onClick={onClearApiKey}>清除密钥</Btn>
            <Btn variant="outline" icon={<TestTube size={14} />} onClick={onTestModel} loading={testing}>
              {testing ? '测试中…' : '测试连接'}
            </Btn>
            <div style={{ flex: 1 }} />
            <Btn variant="primary" icon={<Save size={14} />} onClick={onSave}>保存</Btn>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Model Picker with /models fetch ───
export function ModelPicker({ value, baseUrl, apiKey, onChange, compact = false }: {
  value: string; baseUrl: string; apiKey: string; onChange: (m: string) => void; compact?: boolean;
}) {
  const [models, setModels] = useState<Array<{ value: string; label: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [autoSwitched, setAutoSwitched] = useState('');

  const isLocal = (() => {
    try {
      const host = new URL(baseUrl).hostname;
      return host === 'localhost' || host === '127.0.0.1';
    } catch {
      return false;
    }
  })();

  const fetchModels = async () => {
    if (!baseUrl) return;
    setLoading(true); setError('');
    try {
      const url = baseUrl.replace(/\/$/, '') + '/models';
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { data?: Array<{ id: string }> };
      const list = (data.data ?? []).map(m => ({ value: m.id, label: m.id })).sort((a, b) => a.label.localeCompare(b.label));
      setModels(list);
      // 当前模型不在服务器列表里（例如从官方预设切到本地服务）时自动切到第一个可用模型，
      // 避免拿着 gpt-4o-mini 反复请求本地服务得到 404 not_found_error。
      if (list.length > 0 && value && !list.some((m) => m.value === value)) {
        setAutoSwitched(list[0].value);
        onChange(list[0].value);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取模型列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isLocal && models.length === 0) void fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, isLocal]);

  const control = (
    <>
      <div style={{ display: 'flex', gap: 6 }}>
        <Input
          value={value}
          onChange={onChange}
          list="ra-model-suggestions"
          placeholder="模型名，如 qwen35-a3b / gpt-4o-mini"
          style={{ flex: 1, ...(compact ? { height: 30 } : {}) }}
          mono
        />
        <datalist id="ra-model-suggestions">
          {models.map(m => <option key={m.value} value={m.value} />)}
        </datalist>
        <Btn variant="outline" size={compact ? 'sm' : 'md'} onClick={() => void fetchModels()} disabled={loading} title="拉取服务器模型列表">
          {loading ? <Spinner size={14} /> : <RefreshCw size={14} />}
        </Btn>
      </div>
      {error && <div style={{ fontSize: 11, color: C.danger, marginTop: 2 }}>模型列表获取失败：{error}（可直接手动填写模型名）</div>}
      {autoSwitched && (
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
          原模型不在服务器列表中，已自动切换到 {autoSwitched}（已保存）。
        </div>
      )}
      {models.length > 0 && !models.some((m) => m.value === value) && (
        <div style={{ fontSize: 11, color: C.warning, marginTop: 2 }}>当前模型不在服务器可用列表中（手动值仍可保存）。</div>
      )}
    </>
  );

  if (compact) {
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{control}</div>;
  }
  return (
    <Field label="模型" hint={models.length > 0 ? `${models.length} 个可用（可输入可下拉）` : isLocal ? '本地服务自动获取' : '点击刷新获取'}>
      {control}
    </Field>
  );
}

// ─── Review Settings ───
function ProjectPromptManager({ settings, projectKey, onCommit }: {
  settings: RuntimeSettings; projectKey: string; onCommit: (s: RuntimeSettings) => void;
}) {
  const prompts = settings.projectPrompts ?? {};
  const keys = [...new Set([projectKey, ...Object.keys(prompts)])].filter(Boolean);
  const [managedKey, setManagedKey] = useState(projectKey || keys[0] || '');
  const effectiveKey = managedKey || projectKey;
  const setPrompt = (key: string, value: string) => {
    const next = { ...prompts };
    if (value.trim()) next[key] = value;
    else delete next[key];
    onCommit({ ...settings, projectPrompts: next });
  };
  const removeKey = (key: string) => {
    const next = { ...prompts };
    delete next[key];
    onCommit({ ...settings, projectPrompts: next });
    if (managedKey === key) setManagedKey(projectKey);
  };
  return (
    <Field
      label="项目补充 System Prompt"
      hint={effectiveKey ? `注入 ${effectiveKey} 的混合评审 user 消息；按项目记住` : '当前页面没有项目上下文'}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <Select
            value={effectiveKey}
            onChange={setManagedKey}
            options={keys.map((key) => ({ value: key, label: key === projectKey ? `${key}（当前）` : key }))}
            style={{ flex: 1 }}
          />
          <Btn
            variant="ghost" size="sm" icon={<Trash2 size={13} />}
            disabled={!effectiveKey || !(effectiveKey in prompts)}
            title="删除该项目的补充提示"
            onClick={() => removeKey(effectiveKey)}
          >
            删除
          </Btn>
        </div>
        <textarea
          autoComplete="off"
          value={prompts[effectiveKey] ?? ''}
          onChange={(e) => setPrompt(effectiveKey, e.target.value)}
          disabled={!effectiveKey}
          placeholder="例如：本仓库禁止直接查表，必须走 repository 层；涉及金额计算必须使用 decimal；不要在报告里评论命名风格。"
          style={{
            width: '100%', minHeight: 84, resize: 'vertical', padding: 8,
            borderRadius: C.radiusSm, border: `1px solid ${C.border}`, fontSize: 12, lineHeight: 1.6,
            fontFamily: 'inherit', color: C.text, background: C.bgSubtle, outline: 'none',
          }}
        />
        <div style={{ fontSize: 11, color: C.textMuted }}>
          已缓存 {Object.keys(prompts).length} 个项目的补充提示；起始页「开始一次混合评审」里也能直接编辑当前项目。
        </div>
      </div>
    </Field>
  );
}

function ReviewSection({ settings, onSettingsChange, onSettingsCommit, projectKey }: SettingsViewProps) {
  return (
    <Card>
      <CardHeader icon={<Shield size={16} />} title="审查设置" desc="规则阶段始终在本地执行，不消耗 token" />
      <CardBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="评审模式" hint={settings.reviewMode === 'rules' ? '不调用模型' : settings.reviewMode === 'ai' ? '跳过规则检查' : '规则命中与 AI 结果分开标注'}>
            <Segmented
              value={settings.reviewMode}
              onChange={v => onSettingsChange({ ...settings, reviewMode: v as RuntimeSettings['reviewMode'] })}
              options={[
                { value: 'hybrid', label: '规则 + AI' },
                { value: 'rules', label: '仅规则' },
                { value: 'ai', label: '仅 AI' },
              ]}
            />
          </Field>
          <ProjectPromptManager settings={settings} projectKey={projectKey} onCommit={onSettingsCommit} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="审查强度" hint="只影响 AI 结果">
            <Select
              value={settings.effort}
              onChange={v => onSettingsChange({ ...settings, effort: v as RuntimeSettings['effort'] })}
              options={[
                { value: 'fast', label: '快速（仅高置信度）' },
                { value: 'balanced', label: '均衡（推荐）' },
                { value: 'thorough', label: '全面（更多问题）' },
              ]}
            />
          </Field>
          <Field label="输出语言">
            <Select
              value={settings.language}
              onChange={v => onSettingsChange({ ...settings, language: v as RuntimeSettings['language'] })}
              options={[
                { value: 'zh-CN', label: '简体中文' },
                { value: 'en-US', label: 'English' },
              ]}
            />
          </Field>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Repo index ───
function RepoIndexSection({ settings, onSettingsChange }: SettingsViewProps) {
  const repo = settings.repoIndex;
  const patch = (next: Partial<typeof repo>) => onSettingsChange({ ...settings, repoIndex: { ...repo, ...next } });
  return (
    <Card>
      <CardHeader
        icon={<Database size={16} />}
        title="仓库索引"
        desc="本地符号搜索 / 调用链 / Review 仓库上下文"
        badge={repo.enabled ? { text: '已启用', color: 'success' } : undefined}
      />
      <CardBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>启用仓库索引</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                把仓库文件缓存到浏览器 OPFS，构建符号表；GitLab REST 没有符号级 API
              </div>
            </div>
            <Toggle checked={repo.enabled} onChange={(v) => patch({ enabled: v })} />
          </div>
          {repo.enabled && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="最大文件数" hint="超出部分不索引">
                  <Input
                    mono value={String(repo.maxFiles)}
                    onChange={(v) => patch({ maxFiles: Math.max(10, Math.min(5000, Number(v.replace(/\D/g, '')) || repo.maxFiles)) })}
                  />
                </Field>
                <Field label="单份体积上限 (MB)">
                  <Input
                    mono value={String(Math.round(repo.maxBytes / 1024 / 1024))}
                    onChange={(v) => patch({ maxBytes: Math.max(1, Math.min(200, Number(v.replace(/\D/g, '')) || 12)) * 1024 * 1024 })}
                  />
                </Field>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="保留索引份数" hint="不同 branch/commit 各一份，超出自动清理最旧">
                  <Input
                    mono value={String(repo.maxIndexes)}
                    onChange={(v) => patch({ maxIndexes: Math.max(1, Math.min(20, Number(v.replace(/\D/g, '')) || 6)) })}
                  />
                </Field>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>Review 注入仓库上下文</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                    把「变更文件定义了哪些符号、被 Diff 外谁调用」加入模型提示词
                  </div>
                </div>
                <Toggle checked={settings.repoContext} onChange={(v) => onSettingsChange({ ...settings, repoContext: v })} />
              </div>
            </>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ─── GitLab API ───
function GitLabSection({ settings, onSettingsChange, capabilities, onProbeCapabilities }: SettingsViewProps) {
  return (
    <Card>
      <CardHeader
        icon={<Globe size={16} />}
        title="GitLab API"
        badge={capabilities?.authenticated ? { text: '已连接', color: 'success' } : undefined}
      />
      <CardBody>
        <Field label="Personal Access Token" hint="同源 REST API 使用浏览器 Cookie，可选 PAT">
          <Input
            type="password"
            value={settings.gitlabToken}
            onChange={v => onSettingsChange({ ...settings, gitlabToken: v })}
            placeholder="glpat-...（可选）"
          />
        </Field>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <Btn variant="outline" size="sm" onClick={onProbeCapabilities}>检测权限</Btn>
          {capabilities && (
            <div style={{ display: 'flex', gap: 6 }}>
              <Badge text="认证" color={capabilities.authenticated ? 'success' : 'danger'} />
              <Badge text="读 MR" color={capabilities.canReadMergeRequests ? 'success' : 'danger'} />
              <Badge text="发评论" color={capabilities.canCreateDiscussions ? 'success' : 'danger'} />
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Token Usage ───
function UsageSection({ usageSummary, onClearUsage }: SettingsViewProps) {
  if (!usageSummary) return null;
  return (
    <Card>
      <CardHeader icon={<TestTube size={16} />} title="Token 用量" />
      <CardBody>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {[
            { label: '调用次数', value: String(usageSummary.callCount) },
            { label: '输入 Tokens', value: formatTokenCount(usageSummary.totalInputTokens) },
            { label: '输出 Tokens', value: formatTokenCount(usageSummary.totalOutputTokens) },
            { label: '估算费用', value: formatCost(usageSummary.totalEstimatedCost) },
          ].map(s => (
            <div key={s.label} style={{ padding: '8px 12px', background: C.bgSubtle, borderRadius: C.radiusSm }}>
              <div style={{ fontSize: 11, color: C.textMuted }}>{s.label}</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text, fontFamily: 'monospace', marginTop: 2 }}>{s.value}</div>
            </div>
          ))}
        </div>
        {Object.entries(usageSummary.byModel).length > 0 && (
          <div style={{ marginTop: 10 }}>
            {Object.entries(usageSummary.byModel).map(([key, data]) => (
              <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderTop: `1px solid ${C.border}`, fontSize: 11, fontFamily: 'monospace' }}>
                <span style={{ color: C.textSecondary }}>{key}</span>
                <span style={{ color: C.text }}>{formatTokenCount(data.inputTokens)} → {formatTokenCount(data.outputTokens)}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <Btn variant="ghost" size="sm" onClick={onClearUsage}>清空记录</Btn>
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Rule Packs ───
function RulePackSection({ rulePacks, onToggleRulePack, onToggleRule, onNewRulePack, onDeleteRulePack, onImportRulePack, onExportRulePack, onUpdateRulePack, importError, onExportSiteConfig, packScope, projectLabel, publicCustomCount, onPackScopeChange }: SettingsViewProps) {
  const [importText, setImportText] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader icon={<Package size={16} />} title="规则包" desc={`始终参与的确定性检查，当前启用 ${countEnabledRules(rulePacks)} 条规则`} />
      <CardBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {projectLabel ? (
            <Segmented
              value={packScope}
              onChange={v => onPackScopeChange(v as 'public' | 'project')}
              options={[
                { value: 'public', label: '公共' },
                { value: 'project', label: `当前项目 ${projectLabel.replace(/^.*\//, '')}` },
              ]}
            />
          ) : (
            <div style={{ fontSize: 11, color: C.textMuted }}>公共作用域（当前页面没有项目上下文）</div>
          )}
          {packScope === 'project' && (
            <div style={{ fontSize: 11, color: C.textMuted }}>
              此处仅管理当前项目的自定义规则包；内置规则包开关在公共作用域管理，另有 {publicCustomCount} 个公共自定义包同时生效。
            </div>
          )}
          {rulePacks.map(pack => {
            const isBuiltin = pack.id === BUILT_IN_PACK.id;
            const expanded = expandedId === pack.id;
            return (
              <div key={pack.id} style={{ border: `1px solid ${C.border}`, borderRadius: C.radius, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: pack.enabled ? '#f0f8f4' : C.bgSubtle }}>
                  <Toggle checked={pack.enabled} onChange={v => onToggleRulePack(pack.id, v)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{pack.name}</span>
                      <Badge text={pack.version} />
                      <Badge text={`${pack.rules.length} 条规则`} />
                      {isBuiltin && <Badge text="内置" />}
                    </div>
                    {pack.description && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{pack.description}</div>}
                  </div>
                  <button type="button" onClick={() => setExpandedId(expanded ? null : pack.id)}
                    style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.textMuted, display: 'flex', padding: 4 }}>
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  {!isBuiltin && (
                    <>
                      <button type="button" onClick={() => onExportRulePack(pack.id)}
                        style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.textMuted, display: 'flex', padding: 4 }}
                        title="导出"><Download size={14} /></button>
                      <button type="button" onClick={() => onDeleteRulePack(pack.id)}
                        style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.danger, display: 'flex', padding: 4 }}
                        title="删除"><X size={14} /></button>
                    </>
                  )}
                </div>
                {expanded && (
                  <div style={{ padding: '12px 16px', borderTop: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Field label="名称">
                      <Input value={pack.name} onChange={v => onUpdateRulePack(pack.id, { name: v })} />
                    </Field>
                    <Field label="描述">
                      <Input value={pack.description ?? ''} onChange={v => onUpdateRulePack(pack.id, { description: v })} />
                    </Field>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: C.textSecondary, marginBottom: 6 }}>规则列表</div>
                      {pack.rules.map((rule, i) => (
                        <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: i > 0 ? `1px solid ${C.border}` : 'none', fontSize: 11 }}>
                          <input
                            type="checkbox" checked={rule.enabled} autoComplete="off" aria-label={`启用规则 ${rule.title}`}
                            onChange={() => onToggleRule(pack.id, rule.id)}
                            style={{ width: 13, height: 13, accentColor: C.primary, cursor: 'pointer', flexShrink: 0 }}
                          />
                          <Badge text={rule.category} color={rule.category === 'security' ? 'danger' : rule.category === 'bug' ? 'warning' : undefined} />
                          <Badge text={rule.severity} color={rule.severity === 'critical' || rule.severity === 'high' ? 'danger' : rule.severity === 'medium' ? 'warning' : undefined} />
                          <span title={rule.content} style={{ flex: 1, color: rule.enabled ? C.text : C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rule.title}</span>
                          {rule.languages && rule.languages.length > 0 && (
                            <span style={{ color: C.textMuted, fontSize: 10, flexShrink: 0 }}>{rule.languages.join('/')}</span>
                          )}
                          <span style={{ color: C.textMuted, fontSize: 10, flexShrink: 0 }}>{rule.fileLevel ? '文件级' : `${rule.matchPatterns.length} 模式`}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="outline" size="sm" icon={<Package size={13} />} onClick={onNewRulePack}>新建规则包</Btn>
          </div>
          <Divider label="导入" />
          <Field label="规则包 JSON">
            <textarea
              autoComplete="off"
              value={importText}
              onChange={e => setImportText(e.target.value)}
              placeholder="粘贴规则包 JSON…"
              rows={3}
              style={{
                width: '100%', padding: '8px 12px', borderRadius: C.radiusSm,
                border: `1.5px solid ${C.border}`, fontSize: 12, fontFamily: 'monospace',
                color: C.text, resize: 'vertical', outline: 'none', boxSizing: 'border-box',
                background: C.bg,
              }}
            />
          </Field>
          {importError && <div style={{ fontSize: 11, color: C.danger }}>{importError}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="outline" icon={<Upload size={14} />} onClick={() => { onImportRulePack(importText); setImportText(''); }}>导入规则包</Btn>
            <Btn variant="ghost" icon={<Download size={14} />} onClick={onExportSiteConfig}>导出站点配置</Btn>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Debug ───
function DebugSection({ settings, onSettingsChange, onOpenDebug }: SettingsViewProps) {
  return (
    <Card>
      <CardHeader
        icon={<Bug size={16} />}
        title="调试"
        desc="日志 / 网络 / 提示词 / 状态四面板，默认关闭"
        badge={settings.debugEnabled ? { text: '已打开', color: 'success' } : undefined}
      />
      <CardBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>显示调试标签页</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                记录 GitLab / 模型 / MCP / 索引的每次请求、发给模型的完整提示词、console 报错与运行时快照
              </div>
            </div>
            <Toggle
              checked={settings.debugEnabled}
              onChange={v => {
                onSettingsChange({ ...settings, debugEnabled: v });
                if (v) onOpenDebug();
              }}
            />
          </div>
          {settings.debugEnabled && (
            <Btn variant="outline" size="sm" icon={<Bug size={13} />} onClick={onOpenDebug}>打开调试面板</Btn>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ─── MCP ───
function McpSection({ settings, onSettingsChange }: SettingsViewProps) {
  const servers = settings.mcp.servers ?? [];
  const setServers = (next: McpServerEntry[]) => onSettingsChange({ ...settings, mcp: { ...settings.mcp, servers: next } });
  const updateServer = (index: number, patch: Partial<McpServerEntry>) => setServers(servers.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const removeServer = (index: number) => setServers(servers.filter((_, i) => i !== index));
  const addServer = () => setServers([...servers, { id: `mcp-${Date.now().toString(36)}`, name: `MCP ${servers.length + 1}`, url: 'http://127.0.0.1:3000/mcp', enabled: true }]);
  return (
    <Card>
      <CardHeader
        icon={<Puzzle size={16} />}
        title="MCP 扩展工具"
        desc="HTTP transport（Streamable HTTP / SSE）"
        badge={settings.mcp.enabled ? { text: '已启用', color: 'success' } : undefined}
      />
      <CardBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>启用 MCP</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>连接外部工具服务器扩展 Agent 能力</div>
            </div>
            <Toggle checked={settings.mcp.enabled} onChange={v => onSettingsChange({ ...settings, mcp: { ...settings.mcp, enabled: v } })} />
          </div>
          {settings.mcp.enabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {servers.map((entry, index) => (
                <div key={entry.id} style={{ border: `1px solid ${C.border}`, borderRadius: C.radiusSm, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Toggle checked={entry.enabled} onChange={v => updateServer(index, { enabled: v })} />
                    <Input value={entry.name} onChange={v => updateServer(index, { name: v })} placeholder="名称" style={{ flex: 1, height: 30 }} />
                    <Btn variant="ghost" size="sm" icon={<Trash2 size={13} />} ariaLabel="删除该 MCP 服务器" onClick={() => removeServer(index)} />
                  </div>
                  <Input value={entry.url} onChange={v => updateServer(index, { url: v })} placeholder="http://127.0.0.1:3000/mcp" mono style={{ height: 30 }} />
                </div>
              ))}
              {servers.length === 0 && <div style={{ fontSize: 11, color: C.textMuted }}>还没有 MCP 服务器，添加一个以扩展 Agent 工具。</div>}
              <Btn variant="outline" size="sm" icon={<Plus size={13} />} onClick={addServer}>添加 MCP 服务器</Btn>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
