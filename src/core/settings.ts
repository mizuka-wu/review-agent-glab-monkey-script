import type { ModelProvider, RuntimeSettings } from './types';

export interface ProviderPreset {
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  placeholderKey: string;
}

export const providerPresets: Record<ModelProvider, ProviderPreset> = {
  openai: {
    label: 'OpenAI-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    placeholderKey: 'sk-...',
  },
  anthropic: {
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
    placeholderKey: 'sk-ant-...',
  },
  gemini: {
    label: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.0-flash',
    placeholderKey: 'AIza...',
  },
};

export const defaultSettings: RuntimeSettings = {
  provider: 'openai',
  modelBaseUrl: providerPresets.openai.defaultBaseUrl,
  apiKey: '',
  model: providerPresets.openai.defaultModel,
  gitlabToken: '',
  effort: 'balanced',
  reviewMode: 'hybrid',
  language: 'zh-CN',
  mcp: { enabled: false, serverUrl: 'http://127.0.0.1:3000/mcp' },
  repoIndex: { enabled: true, maxFiles: 400, maxBytes: 12 * 1024 * 1024 },
  repoContext: true,
  auth: {
    mode: 'bearer',
    customHeaders: {},
    apiKeyHeader: 'Authorization',
    apiKeyQueryParam: 'key',
  },
};

const STORAGE_KEY = 'review-agent-settings-v1';

// --- Configuration readiness ---

export type ConfigurationField = 'apiKey' | 'modelBaseUrl' | 'model';

export interface ConfigurationIssue {
  field: ConfigurationField;
  label: string;
  hint: string;
}

export interface ConfigurationState {
  /** 模型可用：能跑 AI 评审和对话。 */
  modelReady: boolean;
  issues: ConfigurationIssue[];
  hasGitLabToken: boolean;
}

export function isOfficialOpenAIEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * 只有官方 OpenAI 端点强制要求 API Key；企业网关 / 本地代理常常免鉴权，
 * 未填 Key 也应该允许直接连。
 */
export function modelConfigurationIssues(settings: RuntimeSettings): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  if (!settings.modelBaseUrl.trim()) {
    issues.push({ field: 'modelBaseUrl', label: 'Base URL', hint: '例如 https://api.openai.com/v1 或企业网关地址' });
  }
  if (!settings.model.trim()) {
    issues.push({ field: 'model', label: '模型', hint: '例如 gpt-4o-mini' });
  }
  if (!settings.apiKey.trim() && isOfficialOpenAIEndpoint(settings.modelBaseUrl)) {
    issues.push({ field: 'apiKey', label: 'API Key', hint: '官方 OpenAI 端点必须填写' });
  }
  return issues;
}

export function isModelConfigured(settings: RuntimeSettings): boolean {
  return modelConfigurationIssues(settings).length === 0
    && Boolean(settings.modelBaseUrl && settings.model);
}

export function inspectConfiguration(settings: RuntimeSettings): ConfigurationState {
  return {
    modelReady: isModelConfigured(settings),
    issues: modelConfigurationIssues(settings),
    hasGitLabToken: Boolean(settings.gitlabToken.trim()),
  };
}

// --- Secure key obfuscation ---
// XOR + base64: not real encryption, but prevents casual plaintext exposure in devtools.

function xorEncode(text: string, key: string): string {
  const bytes = new TextEncoder().encode(text);
  const keyBytes = new TextEncoder().encode(key);
  const result = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    result[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return btoa(String.fromCharCode(...result));
}

function xorDecode(encoded: string, key: string): string {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const keyBytes = new TextEncoder().encode(key);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return encoded;
  }
}

const OBFUSCATION_KEY = 'RA-2024-GitLab-Review';

function obfuscateSettings(settings: RuntimeSettings): RuntimeSettings {
  return {
    ...settings,
    apiKey: settings.apiKey ? `enc:${xorEncode(settings.apiKey, OBFUSCATION_KEY)}` : '',
    gitlabToken: settings.gitlabToken ? `enc:${xorEncode(settings.gitlabToken, OBFUSCATION_KEY)}` : '',
  };
}

function deobfuscateSettings(settings: RuntimeSettings): RuntimeSettings {
  return {
    ...settings,
    apiKey: settings.apiKey.startsWith('enc:') ? xorDecode(settings.apiKey.slice(4), OBFUSCATION_KEY) : settings.apiKey,
    gitlabToken: settings.gitlabToken.startsWith('enc:') ? xorDecode(settings.gitlabToken.slice(4), OBFUSCATION_KEY) : settings.gitlabToken,
  };
}

type GreaseMonkeyStorage = {
  getValue(key: string, fallback: unknown): Promise<unknown>;
  setValue(key: string, value: unknown): Promise<void>;
  deleteValue(key: string): Promise<void>;
};

function gmStorage(): GreaseMonkeyStorage | undefined {
  return (globalThis as typeof globalThis & { GM?: GreaseMonkeyStorage }).GM;
}

export async function loadSettings(): Promise<RuntimeSettings> {
  try {
    const stored = gmStorage()
      ? await gmStorage()?.getValue(STORAGE_KEY, {})
      : JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const partial = stored as Partial<RuntimeSettings>;
    return deobfuscateSettings({
      ...defaultSettings,
      ...partial,
      mcp: { ...defaultSettings.mcp, ...(partial.mcp ?? {}) },
      auth: { ...defaultSettings.auth, ...(partial.auth ?? {}) },
      repoIndex: { ...defaultSettings.repoIndex, ...(partial.repoIndex ?? {}) },
    });
  } catch {
    return defaultSettings;
  }
}

export async function saveSettings(settings: RuntimeSettings) {
  const obfuscated = obfuscateSettings(settings);
  if (gmStorage()) {
    await gmStorage()?.setValue(STORAGE_KEY, obfuscated);
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obfuscated));
  }
}

export async function clearSensitiveSettings() {
  const settings = await loadSettings();
  await saveSettings({ ...settings, apiKey: '', gitlabToken: '' });
}
