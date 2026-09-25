import { describe, expect, it } from 'vitest';
import {
  exportSiteConfig,
  importSiteConfig,
  parseDiffFromDom,
  sanitizeLog,
} from '../../src/core/capabilities';

describe('sanitizeLog', () => {
  it('redacts Bearer tokens', () => {
    expect(sanitizeLog('Authorization: Bearer abc123def456')).toBe('Authorization: [REDACTED]');
  });

  it('redacts OpenAI API keys', () => {
    expect(sanitizeLog('key=sk-1234567890abcdef1234567890abcdef')).toContain('[REDACTED]');
    expect(sanitizeLog('key=sk-1234567890abcdef1234567890abcdef')).not.toContain('sk-1234567890');
  });

  it('redacts Anthropic API keys', () => {
    expect(sanitizeLog('sk-ant-abcdef1234567890-abcdef1234567890')).toContain('[REDACTED]');
  });

  it('redacts GitLab PATs', () => {
    expect(sanitizeLog('token: glpat-abcdefghij1234567890')).toContain('[REDACTED]');
  });

  it('redacts Gemini API keys', () => {
    expect(sanitizeLog('AIzaSyA1234567890abcdefghijklmnopqrstuv')).toContain('[REDACTED]');
  });

  it('preserves normal text', () => {
    const text = 'reviewing file src/payment.ts line 42';
    expect(sanitizeLog(text)).toBe(text);
  });

  it('redacts password-like key=value pairs', () => {
    expect(sanitizeLog('password=SuperSecret123')).toContain('[REDACTED]');
    expect(sanitizeLog('secret: mysecretvalue99')).toContain('[REDACTED]');
  });
});

describe('exportSiteConfig / importSiteConfig', () => {
  const mockPage = {
    origin: 'https://gitlab.example.com',
    route: 'merge-request' as const,
    projectPath: 'acme/app',
    mergeRequestIid: 42,
  };

  const mockCapabilities = {
    authenticated: true,
    canReadMergeRequests: true,
    canCreateDiscussions: true,
    canSearchCode: false,
    canReadRepository: true,
    canPaginateDiffs: true,
    maxDiffPageSize: 100,
    authMode: 'pat' as const,
    domAvailable: true,
    csrfAvailable: true,
    warnings: [],
  };

  it('exports and imports config round-trip', () => {
    const json = exportSiteConfig(mockPage, mockCapabilities, {
      provider: 'openai',
      apiKey: 'sk-secret-should-be-stripped',
      gitlabToken: 'glpat-secret-should-be-stripped',
    });
    const result = importSiteConfig(json);
    expect(result.errors).toHaveLength(0);
    expect(result.config).toBeDefined();
    expect(result.config!.version).toBe(1);
    expect(result.config!.origin).toBe('https://gitlab.example.com');
    expect(result.config!.settings.apiKey).toBe('');
    expect(result.config!.settings.gitlabToken).toBe('');
  });

  it('rejects invalid JSON', () => {
    const result = importSiteConfig('not json');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects wrong version', () => {
    const result = importSiteConfig(JSON.stringify({ version: 99 }));
    expect(result.errors).toContain('不支持的配置版本');
  });
});

describe('parseDiffFromDom', () => {
  it('returns empty when no diff content', () => {
    const doc = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    const result = parseDiffFromDom(doc);
    expect(result.available).toBe(false);
    expect(result.files).toHaveLength(0);
  });

  it('parses diff content from mock DOM', () => {
    const doc = new DOMParser().parseFromString(`
      <html><body>
        <div class="diff-file" data-file-path="src/app.ts">
          <div class="file-title-name">src/app.ts</div>
          <div class="line_holder" data-line-number="1"><code>const x = 1;</code></div>
          <div class="line_holder" data-line-number="2"><code>const y = 2;</code></div>
        </div>
      </body></html>`, 'text/html');
    const result = parseDiffFromDom(doc);
    expect(result.available).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/app.ts');
    expect(result.files[0].lines).toHaveLength(2);
    expect(result.files[0].lines[0].text).toBe('const x = 1;');
  });
});
