import type { AdapterCapabilities, PageContext } from './types';

export interface ExtendedCapabilities extends AdapterCapabilities {
  apiVersion?: string;
  gitlabVersion?: string;
  canSearchCode: boolean;
  canReadRepository: boolean;
  canPaginateDiffs: boolean;
  maxDiffPageSize: number;
  authMode: 'cookie' | 'pat' | 'none';
  domAvailable: boolean;
  csrfAvailable: boolean;
  warnings: string[];
}

export interface ProbeResult {
  capabilities: ExtendedCapabilities;
  diagnostics: DiagnosticEntry[];
}

export interface DiagnosticEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
  detail?: string;
}

function makeDiag(level: DiagnosticEntry['level'], source: string, message: string, detail?: string): DiagnosticEntry {
  return { timestamp: new Date().toISOString(), level, source, message, detail };
}

/**
 * Probe GitLab instance capabilities for self-deployment compatibility.
 * Falls back gracefully when APIs are unavailable.
 */
export async function probeCapabilities(
  origin: string,
  gitlabToken: string,
  fetcher: typeof fetch = fetch.bind(globalThis),
): Promise<ProbeResult> {
  const diagnostics: DiagnosticEntry[] = [];
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (gitlabToken) headers['PRIVATE-TOKEN'] = gitlabToken;

  const base: ExtendedCapabilities = {
    authenticated: false,
    canReadMergeRequests: true,
    canCreateDiscussions: true,
    canSearchCode: false,
    canReadRepository: true,
    canPaginateDiffs: true,
    maxDiffPageSize: 100,
    authMode: gitlabToken ? 'pat' : 'cookie',
    domAvailable: typeof document !== 'undefined',
    csrfAvailable: Boolean(document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content),
    warnings: [],
  };

  // 1. Check /api/v4/user for auth
  try {
    const response = await fetcher(`${origin}/api/v4/user`, { headers, credentials: 'same-origin' });
    if (response.ok) {
      const user = await response.json() as { username?: string };
      base.authenticated = true;
      diagnostics.push(makeDiag('info', 'auth', `已认证为 ${user.username ?? 'unknown'}`, `mode=${base.authMode}`));
    } else if (response.status === 401) {
      base.authenticated = false;
      base.warnings.push('GitLab API 认证失败，评论发布可能受限。');
      diagnostics.push(makeDiag('warn', 'auth', 'API 认证失败 (401)', '检查 PAT 或登录状态'));
    }
  } catch (error) {
    base.warnings.push('GitLab API 不可达，将尝试 DOM 模式。');
    diagnostics.push(makeDiag('error', 'auth', `API 不可达: ${String(error)}`));
    base.canReadMergeRequests = false;
    base.canCreateDiscussions = false;
    base.canSearchCode = false;
  }

  // 2. Check version
  try {
    const response = await fetcher(`${origin}/api/v4/version`, { headers, credentials: 'same-origin' });
    if (response.ok) {
      const version = await response.json() as { version?: string };
      base.gitlabVersion = version.version;
      diagnostics.push(makeDiag('info', 'version', `GitLab 版本: ${version.version}`));
    }
  } catch {
    diagnostics.push(makeDiag('warn', 'version', '无法获取 GitLab 版本'));
  }

  // 3. Check search API
  try {
    const response = await fetcher(`${origin}/api/v4/search?scope=blobs&search=test`, { headers, credentials: 'same-origin' });
    base.canSearchCode = response.ok;
    if (!response.ok) {
      diagnostics.push(makeDiag('warn', 'search', `搜索 API 返回 ${response.status}`, '可能未启用 Elasticsearch'));
    }
  } catch {
    base.canSearchCode = false;
    diagnostics.push(makeDiag('warn', 'search', '搜索 API 不可用'));
  }

  // 4. Check CSRF
  if (!base.csrfAvailable) {
    base.warnings.push('页面缺少 CSRF token，可能无法创建评论。');
    diagnostics.push(makeDiag('warn', 'csrf', '未找到 CSRF token meta 标签'));
  }

  // 5. DOM check
  if (!base.domAvailable) {
    diagnostics.push(makeDiag('warn', 'dom', 'DOM 环境不可用'));
  }

  return { capabilities: base, diagnostics };
}

// --- DOM-only fallback ---

/**
 * Parse diff content from the DOM when GitLab API is unavailable.
 * Extracts file paths and line numbers from the diff page markup.
 */
export function parseDiffFromDom(document: Document): {
  files: { path: string; lines: { line: number; text: string; kind: 'added' | 'removed' | 'context' }[] }[];
  available: boolean;
} {
  const files: { path: string; lines: { line: number; text: string; kind: 'added' | 'removed' | 'context' }[] }[] = [];

  const diffContainers = document.querySelectorAll<HTMLElement>('.diff-file, [data-file-path]');
  for (const container of diffContainers) {
    const pathEl = container.querySelector('.file-title-name, [data-file-path]');
    const path = pathEl?.getAttribute('data-file-path') ?? pathEl?.textContent?.trim() ?? '';
    if (!path) continue;

    const lines: { line: number; text: string; kind: 'added' | 'removed' | 'context' }[] = [];
    const lineElements = container.querySelectorAll<HTMLElement>('.line_holder, [data-line-number]');

    for (const lineEl of lineElements) {
      const lineNo = Number(lineEl.dataset.lineNumber ?? lineEl.dataset.line ?? '0');
      const codeEl = lineEl.querySelector('code, .line_content');
      const text = codeEl?.textContent ?? '';

      let kind: 'added' | 'removed' | 'context' = 'context';
      if (lineEl.classList.contains('added') || lineEl.classList.contains('new')) kind = 'added';
      else if (lineEl.classList.contains('removed') || lineEl.classList.contains('old')) kind = 'removed';

      if (lineNo > 0) {
        lines.push({ line: lineNo, text, kind });
      }
    }

    if (lines.length > 0) {
      files.push({ path, lines });
    }
  }

  return { files, available: files.length > 0 };
}

// --- Config import/export ---

export interface SiteConfig {
  version: 1;
  origin: string;
  projectPath: string;
  capabilities: ExtendedCapabilities;
  settings: Record<string, unknown>;
  exportedAt: string;
}

export function exportSiteConfig(
  page: PageContext,
  capabilities: ExtendedCapabilities,
  settings: Record<string, unknown>,
): string {
  const config: SiteConfig = {
    version: 1,
    origin: page.origin,
    projectPath: page.projectPath,
    capabilities,
    settings: {
      ...settings,
      // Strip sensitive fields
      apiKey: '',
      gitlabToken: '',
    },
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(config, null, 2);
}

export function importSiteConfig(json: string): { config?: SiteConfig; errors: string[] } {
  try {
    const parsed = JSON.parse(json);
    if (parsed.version !== 1) return { errors: ['不支持的配置版本'] };
    return { config: parsed as SiteConfig, errors: [] };
  } catch {
    return { errors: ['配置 JSON 解析失败'] };
  }
}

// --- Log sanitization ---

const SENSITIVE_PATTERNS = [
  /([Ss]ecret|[Pp]assword|[Tt]oken|[Kk]ey|SECRET|PASSWORD|TOKEN|KEY)['":\s]*=*\s*['"]?[A-Za-z0-9+/=_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9+/=_-]+/g,
  /sk-[A-Za-z0-9]{16,}/g,
  /sk-ant-[A-Za-z0-9-]{16,}/g,
  /AIza[A-Za-z0-9_-]{30,}/g,
  /glpat-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
];

export function sanitizeLog(input: string): string {
  let output = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }
  return output;
}
