import type { RuntimeSettings } from './types';

export const defaultSettings: RuntimeSettings = {
  modelBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  gitlabToken: '',
  effort: 'balanced',
  language: 'zh-CN',
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
