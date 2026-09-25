import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_PACK,
  exportRulePack,
  importRulePack,
  loadRulePacks,
  runRulePackReview,
  saveRulePacks,
  validateRulePack,
  type RulePack,
} from '../../src/core/rule-packs';
import type { FileDiff, DiffLine } from '../../src/core/types';

function makeFile(path: string, addedLines: string[]): FileDiff {
  const lines: DiffLine[] = addedLines.map((text, index) => ({
    hunkId: 'h1',
    newLine: index + 1,
    kind: 'added' as const,
    text,
  }));
  return {
    oldPath: path,
    newPath: path,
    diff: addedLines.map((line) => `+${line}`).join('\n'),
    newFile: false,
    deletedFile: false,
    renamedFile: false,
    lines,
  };
}

describe('rule-packs', () => {
  describe('BUILT_IN_PACK', () => {
    it('has a valid structure', () => {
      expect(BUILT_IN_PACK.id).toBe('built-in');
      expect(BUILT_IN_PACK.builtIn).toBe(true);
      expect(BUILT_IN_PACK.rules.length).toBeGreaterThan(0);
      for (const rule of BUILT_IN_PACK.rules) {
        expect(rule.id).toBeTruthy();
        expect(rule.title).toBeTruthy();
        expect(rule.content).toBeTruthy();
      }
    });
  });

  describe('runRulePackReview', () => {
    it('detects console.log in added lines', () => {
      const file = makeFile('src/app.ts', ['console.log("debug")']);
      const findings = runRulePackReview([file], [BUILT_IN_PACK]);
      expect(findings.some((f) => f.title.includes('调试日志'))).toBe(true);
    });

    it('detects hardcoded secrets', () => {
      const file = makeFile('src/config.ts', ['const apiKey = "sk-123"']);
      const findings = runRulePackReview([file], [BUILT_IN_PACK]);
      expect(findings.some((f) => f.category === 'security')).toBe(true);
    });

    it('detects weak types', () => {
      const file = makeFile('src/util.ts', ['const x: any = getValue()']);
      const findings = runRulePackReview([file], [BUILT_IN_PACK]);
      expect(findings.some((f) => f.title.includes('类型边界'))).toBe(true);
    });

    it('detects TODO markers', () => {
      const file = makeFile('src/fix.ts', ['// TODO: implement this']);
      const findings = runRulePackReview([file], [BUILT_IN_PACK]);
      expect(findings.some((f) => f.title.includes('未完成标记'))).toBe(true);
    });

    it('detects missing test when source file changes without test', () => {
      const file = makeFile('src/service.ts', ['export function doWork() {}']);
      const findings = runRulePackReview([file], [BUILT_IN_PACK]);
      expect(findings.some((f) => f.title.includes('缺少回归测试'))).toBe(true);
    });

    it('does not flag missing test when test file also changes', () => {
      const source = makeFile('src/service.ts', ['export function doWork() {}']);
      const test = makeFile('src/service.test.ts', ['expect(doWork()).toBe(true)']);
      const findings = runRulePackReview([source, test], [BUILT_IN_PACK]);
      expect(findings.some((f) => f.title.includes('缺少回归测试'))).toBe(false);
    });

    it('skips disabled packs', () => {
      const file = makeFile('src/app.ts', ['console.log("debug")']);
      const disabledPack = { ...BUILT_IN_PACK, enabled: false };
      const findings = runRulePackReview([file], [disabledPack]);
      expect(findings).toHaveLength(0);
    });

    it('skips disabled rules', () => {
      const file = makeFile('src/app.ts', ['console.log("debug")']);
      const pack: RulePack = {
        ...BUILT_IN_PACK,
        rules: BUILT_IN_PACK.rules.map((r) => ({ ...r, enabled: false })),
      };
      const findings = runRulePackReview([file], [pack]);
      expect(findings).toHaveLength(0);
    });

    it('respects scope include patterns', () => {
      const file = makeFile('vendor/lib.ts', ['console.log("debug")']);
      const pack: RulePack = {
        ...BUILT_IN_PACK,
        rules: BUILT_IN_PACK.rules.map((r) =>
          r.id === 'builtin-console-log'
            ? { ...r, scope: { include: ['src/**'] } }
            : r,
        ),
      };
      const findings = runRulePackReview([file], [pack]);
      expect(findings.some((f) => f.title.includes('调试日志'))).toBe(false);
    });

    it('respects scope exclude patterns', () => {
      const file = makeFile('src/debug.ts', ['console.log("debug")']);
      const pack: RulePack = {
        ...BUILT_IN_PACK,
        rules: BUILT_IN_PACK.rules.map((r) =>
          r.id === 'builtin-console-log'
            ? { ...r, scope: { exclude: ['src/debug.*'] } }
            : r,
        ),
      };
      const findings = runRulePackReview([file], [pack]);
      expect(findings.some((f) => f.title.includes('调试日志'))).toBe(false);
    });

    it('evaluates custom rule pack alongside built-in', () => {
      const customPack: RulePack = {
        id: 'custom-1',
        name: 'Custom',
        version: '1.0.0',
        enabled: true,
        builtIn: false,
        rules: [{
          id: 'custom-no-alert',
          enabled: true,
          severity: 'medium',
          category: 'maintainability',
          title: '不应使用 alert',
          content: 'alert 会阻塞 UI',
          matchPatterns: [{ type: 'regex', pattern: '\\balert\\s*\\(' }],
        }],
      };
      const file = makeFile('src/ui.ts', ['alert("oops")']);
      const findings = runRulePackReview([file], [BUILT_IN_PACK, customPack]);
      expect(findings.some((f) => f.title.includes('alert'))).toBe(true);
    });

    it('deduplicates findings by fingerprint', () => {
      const file = makeFile('src/app.ts', [
        'console.log("a")',
        'console.log("b")',
      ]);
      const findings = runRulePackReview([file], [BUILT_IN_PACK]);
      const consoleFindings = findings.filter((f) => f.title.includes('调试日志'));
      // Same line won't deduplicate since different existingCode,
      // but each line should produce one finding
      expect(consoleFindings.length).toBe(2);
    });
  });

  describe('validateRulePack', () => {
    it('returns errors for empty name', () => {
      const errors = validateRulePack({ name: '', version: '1.0.0', rules: [] });
      expect(errors.some((e) => e.field === 'name')).toBe(true);
    });

    it('returns errors for empty rules', () => {
      const errors = validateRulePack({ name: 'Test', version: '1.0.0', rules: [] });
      expect(errors.some((e) => e.field === 'rules')).toBe(true);
    });

    it('returns error for invalid regex', () => {
      const errors = validateRulePack({
        name: 'Test',
        version: '1.0.0',
        rules: [{
          id: 'r1',
          enabled: true,
          severity: 'low',
          category: 'bug',
          title: 'Test',
          content: 'Test',
          matchPatterns: [{ type: 'regex', pattern: '[invalid' }],
        }],
      });
      expect(errors.some((e) => e.message.includes('无效的正则表达式'))).toBe(true);
    });

    it('passes for valid pack', () => {
      const errors = validateRulePack({
        name: 'Test',
        version: '1.0.0',
        rules: [{
          id: 'r1',
          enabled: true,
          severity: 'low',
          category: 'bug',
          title: 'Test',
          content: 'Test',
          matchPatterns: [{ type: 'regex', pattern: 'foo' }],
        }],
      });
      expect(errors).toHaveLength(0);
    });
  });

  describe('import/export', () => {
    it('round-trips a pack through export and import', () => {
      const pack: RulePack = {
        id: 'test-pack',
        name: 'Test Pack',
        version: '2.0.0',
        description: 'A test pack',
        enabled: true,
        builtIn: false,
        rules: [{
          id: 'r1',
          enabled: true,
          severity: 'high',
          category: 'security',
          title: 'No eval',
          content: 'eval is dangerous',
          matchPatterns: [{ type: 'regex', pattern: '\\beval\\s*\\(' }],
        }],
      };
      const json = exportRulePack(pack);
      const result = importRulePack(json);
      expect(result.errors).toHaveLength(0);
      expect(result.pack).toBeDefined();
      expect(result.pack!.name).toBe('Test Pack');
      expect(result.pack!.rules).toHaveLength(1);
      expect(result.pack!.builtIn).toBe(false);
    });

    it('returns errors for invalid JSON', () => {
      const result = importRulePack('not json');
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns errors for invalid pack structure', () => {
      const result = importRulePack(JSON.stringify({ name: '', version: '', rules: [] }));
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('storage', () => {
    it('saves and loads user packs', async () => {
      const store = new Map<string, unknown>();
      const storage = {
        async getValue(key: string, fallback: unknown) {
          return store.has(key) ? store.get(key) : fallback;
        },
        async setValue(key: string, value: unknown) {
          store.set(key, value);
        },
      };

      const pack: RulePack = {
        id: 'user-pack-1',
        name: 'User Pack',
        version: '1.0.0',
        enabled: true,
        builtIn: false,
        rules: [{
          id: 'r1',
          enabled: true,
          severity: 'low',
          category: 'maintainability',
          title: 'Test',
          content: 'Test',
          matchPatterns: [{ type: 'regex', pattern: 'foo' }],
        }],
      };

      await saveRulePacks([BUILT_IN_PACK, pack], storage);
      const loaded = await loadRulePacks(storage);

      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe('built-in');
      expect(loaded[1].id).toBe('user-pack-1');
    });
  });
});
