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
  language: 'zh-CN',
  mcp: { enabled: false, serverUrl: 'http://127.0.0.1:3000/mcp' },
};

const STORAGE_KEY = 'review-agent-settings-v1';

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
    return { ...defaultSettings, ...(stored as Partial<RuntimeSettings>) };
  } catch {
    return defaultSettings;
  }
}

export async function saveSettings(settings: RuntimeSettings) {
  if (gmStorage()) {
    await gmStorage()?.setValue(STORAGE_KEY, settings);
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }
}

export async function clearSensitiveSettings() {
  const settings = await loadSettings();
  await saveSettings({ ...settings, apiKey: '', gitlabToken: '' });
}
