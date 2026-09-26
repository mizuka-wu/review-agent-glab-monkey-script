import { fingerprintFinding } from './findings';
import type { Finding, FindingCategory, FindingSeverity, FileDiff } from './types';

// --- Pattern & Rule Schema ---

export interface RulePattern {
  type: 'regex';
  pattern: string;
  flags?: string;
}

export interface RuleScope {
  include?: string[];
  exclude?: string[];
}

export interface RuleDef {
  id: string;
  enabled: boolean;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  content: string;
  matchPatterns: RulePattern[];
  suggestionTemplate?: string;
  scope?: RuleScope;
}

export interface RulePack {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  builtIn: boolean;
  rules: RuleDef[];
}

// --- Path matching ---

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/{{GLOBSTAR}}/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesScope(path: string, scope?: RuleScope): boolean {
  if (!scope) return true;
  if (scope.include && scope.include.length > 0) {
    if (!scope.include.some((pattern) => globToRegex(pattern).test(path))) return false;
  }
  if (scope.exclude && scope.exclude.length > 0) {
    if (scope.exclude.some((pattern) => globToRegex(pattern).test(path))) return false;
  }
  return true;
}

// --- Built-in rules ---

const builtInRules: RuleDef[] = [
  {
    id: 'builtin-console-log',
    enabled: true,
    severity: 'low',
    category: 'maintainability',
    title: '新增调试日志可能泄漏运行时信息',
    content: '生产代码中的 console.log/debug 会污染日志，并可能输出用户或令牌信息。建议改用受控 logger 或在合并前移除。',
    matchPatterns: [{ type: 'regex', pattern: 'console\\.(?:log|debug)\\s*\\(' }],
    suggestionTemplate: 'logger.debug',
  },
  {
    id: 'builtin-hardcoded-secret',
    enabled: true,
    severity: 'high',
    category: 'security',
    title: '代码中疑似硬编码敏感信息',
    content: '新增赋值涉及密码、Token 或 API Key。应从安全配置或密钥管理服务读取，并确认该值没有进入日志和构建产物。',
    matchPatterns: [{ type: 'regex', pattern: '\\b(?:password|api[_-]?key|access[_-]?token|secret)\\b\\s*[:=]', flags: 'i' }],
  },
  {
    id: 'builtin-weak-types',
    enabled: true,
    severity: 'medium',
    category: 'bug',
    title: '异常处理或类型边界被弱化',
    content: 'any、@ts-ignore 或空 catch 会隐藏类型错误与失败路径。建议保留精确类型并显式处理异常。',
    matchPatterns: [{ type: 'regex', pattern: '\\bany\\b|@ts-ignore|catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}' }],
  },
  {
    id: 'builtin-todo-marker',
    enabled: true,
    severity: 'low',
    category: 'maintainability',
    title: '变更引入未完成标记',
    content: 'TODO/FIXME/HACK 表示实现或修复尚未完成。建议在合并前完成处理，或关联可追踪的问题。',
    matchPatterns: [{ type: 'regex', pattern: '\\b(?:TODO|FIXME|HACK)\\b', flags: 'i' }],
  },
  {
    id: 'builtin-missing-test',
    enabled: true,
    severity: 'low',
    category: 'test',
    title: '本次实现变更缺少回归测试',
    content: 'Diff 中没有测试文件变更。建议至少覆盖新增分支、失败路径和边界条件。',
    matchPatterns: [],
  },
];

const testPattern = /(?:\.test\.|\.spec\.|\/__tests__\/|\/tests?\/)/i;

export const BUILT_IN_PACK: RulePack = {
  id: 'built-in',
  name: '内置规则',
  version: '1.0.0',
  description: '默认的安全、质量和可维护性检查规则。',
  enabled: true,
  builtIn: true,
  rules: builtInRules,
};

// --- Storage ---

const STORAGE_KEY = 'review-agent-rule-packs-v1';

type StorageBackend = {
  getValue(key: string, fallback: unknown): Promise<unknown>;
  setValue(key: string, value: unknown): Promise<void>;
};

function defaultStorage(): StorageBackend {
  const gm = (globalThis as typeof globalThis & { GM?: StorageBackend }).GM;
  if (gm) return gm;
  return {
    async getValue(key, fallback) {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    },
    async setValue(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
  };
}

export async function loadRulePacks(storage = defaultStorage()): Promise<RulePack[]> {
  const raw = await storage.getValue(STORAGE_KEY, []);
  const savedPacks = Array.isArray(raw) ? (raw as RulePack[]) : [];
  const userPacks = savedPacks.filter((pack) => pack.id !== BUILT_IN_PACK.id);

  // Merge saved built-in overrides (enabled flags) into BUILT_IN_PACK
  const savedBuiltin = savedPacks.find((pack) => pack.id === BUILT_IN_PACK.id);
  let builtin = BUILT_IN_PACK;
  if (savedBuiltin) {
    builtin = {
      ...BUILT_IN_PACK,
      enabled: savedBuiltin.enabled,
      rules: BUILT_IN_PACK.rules.map((rule) => {
        const savedRule = savedBuiltin.rules?.find((r) => r.id === rule.id);
        return savedRule ? { ...rule, enabled: savedRule.enabled } : rule;
      }),
    };
  }

  return [builtin, ...userPacks];
}

export async function saveRulePacks(packs: RulePack[], storage = defaultStorage()): Promise<void> {
  // Save all packs including built-in (to persist enable/disable toggles)
  // On load, built-in rules are restored from BUILT_IN_PACK with overrides applied
  const toSave = packs.map((pack) => {
    if (!pack.builtIn) return pack;
    // Only persist enabled flags for built-in pack
    return {
      ...pack,
      rules: pack.rules.map((rule) => ({ id: rule.id, enabled: rule.enabled })),
    };
  });
  await storage.setValue(STORAGE_KEY, toSave);
}

export async function addRulePack(pack: RulePack, storage = defaultStorage()): Promise<RulePack[]> {
  const packs = await loadRulePacks(storage);
  const filtered = packs.filter((existing) => existing.id !== pack.id);
  filtered.push(pack);
  await saveRulePacks(filtered, storage);
  return filtered;
}

export async function removeRulePack(packId: string, storage = defaultStorage()): Promise<RulePack[]> {
  const packs = await loadRulePacks(storage);
  const filtered = packs.filter((pack) => pack.id !== packId || pack.builtIn);
  await saveRulePacks(filtered, storage);
  return filtered;
}

// --- ID generation ---

export function generateRulePackId(): string {
  return `rp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function generateRuleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// --- Evaluation ---

const patternCache = new Map<string, RegExp>();

function compilePattern(pattern: RulePattern): RegExp {
  const key = `${pattern.pattern}:${pattern.flags ?? ''}`;
  let compiled = patternCache.get(key);
  if (!compiled) {
    compiled = new RegExp(pattern.pattern, pattern.flags ?? '');
    patternCache.set(key, compiled);
  }
  return compiled;
}

function evaluateRuleOnLine(rule: RuleDef, line: string): boolean {
  return rule.matchPatterns.some((pattern) => compilePattern(pattern).test(line));
}

function applySuggestion(original: string, template?: string): string {
  if (!template) return '';
  if (template === 'logger.debug') {
    return original.replace(/console\.(?:log|debug)/, 'logger.debug');
  }
  return template;
}

export function runRulePackReview(files: FileDiff[], packs: RulePack[]): Finding[] {
  const findings: Finding[] = [];
  const enabledPacks = packs.filter((pack) => pack.enabled);

  for (const file of files) {
    const addedLines = file.lines.filter((line) => line.kind === 'added');

    for (const pack of enabledPacks) {
      const enabledRules = pack.rules.filter((rule) => rule.enabled);

      for (const rule of enabledRules) {
        // Special handling for the missing-test rule
        if (rule.id === 'builtin-missing-test') {
          if (addedLines.length > 0 && !testPattern.test(file.newPath)) {
            const hasTestChange = files.some((candidate) => testPattern.test(candidate.newPath));
            if (!hasTestChange) {
              const firstAdded = addedLines[0];
              findings.push(createFindingFromRule(rule, file, firstAdded?.newLine ?? 1, firstAdded?.text ?? file.newPath, pack.id));
            }
          }
          continue;
        }

        // Regular pattern-matching rules
        if (!matchesScope(file.newPath, rule.scope)) continue;

        for (const line of addedLines) {
          if (evaluateRuleOnLine(rule, line.text)) {
            const lineNo = line.newLine ?? 1;
            const suggestion = applySuggestion(line.text, rule.suggestionTemplate);
            findings.push(createFindingFromRule(rule, file, lineNo, line.text, pack.id, suggestion));
          }
        }
      }
    }
  }

  // Deduplicate by fingerprint
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.fingerprint)) return false;
    seen.add(finding.fingerprint);
    return true;
  });
}

function createFindingFromRule(
  rule: RuleDef,
  file: FileDiff,
  line: number,
  existingCode: string,
  packId: string,
  suggestionCode = '',
): Finding {
  const path = file.newPath;
  const fingerprint = fingerprintFinding({
    path,
    existingCode,
    category: rule.category,
    title: rule.title,
  });
  return {
    id: fingerprint,
    fingerprint,
    path,
    line,
    endLine: line,
    side: 'new',
    category: rule.category,
    severity: rule.severity,
    confidence: 'medium',
    title: rule.title,
    content: rule.content,
    evidence: [{ path, lines: `L${line}`, quote: existingCode }],
    existingCode,
    suggestionCode,
    comment: `${rule.title}\n\n${rule.content}`,
    source: 'rule',
    status: 'draft',
  };
}

// --- Pack validation ---

export interface RulePackValidationError {
  field: string;
  message: string;
}

export function validateRulePack(pack: Partial<RulePack>): RulePackValidationError[] {
  const errors: RulePackValidationError[] = [];
  if (!pack.name?.trim()) errors.push({ field: 'name', message: '规则包名称不能为空' });
  if (!pack.version?.trim()) errors.push({ field: 'version', message: '版本号不能为空' });
  if (!pack.rules || pack.rules.length === 0) {
    errors.push({ field: 'rules', message: '至少需要一条规则' });
  } else {
    for (const rule of pack.rules) {
      if (!rule.title?.trim()) errors.push({ field: `rule.${rule.id}.title`, message: '规则标题不能为空' });
      if (!rule.content?.trim()) errors.push({ field: `rule.${rule.id}.content`, message: '规则说明不能为空' });
      if (!rule.matchPatterns || rule.matchPatterns.length === 0) {
        // Only the special missing-test rule can have no patterns
        if (rule.id !== 'builtin-missing-test') {
          errors.push({ field: `rule.${rule.id}.matchPatterns`, message: '至少需要一个匹配模式' });
        }
      }
      for (const pattern of rule.matchPatterns ?? []) {
        try {
          new RegExp(pattern.pattern, pattern.flags);
        } catch {
          errors.push({ field: `rule.${rule.id}.pattern`, message: `无效的正则表达式: ${pattern.pattern}` });
        }
      }
    }
  }
  return errors;
}

// --- Import/Export ---

export function exportRulePack(pack: RulePack): string {
  const exportable = { ...pack, builtIn: false };
  return JSON.stringify(exportable, null, 2);
}

export function importRulePack(json: string): { pack?: RulePack; errors: string[] } {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return { errors: ['无效的 JSON 格式'] };
    const pack: RulePack = {
      id: parsed.id ?? generateRulePackId(),
      name: parsed.name ?? '导入的规则包',
      version: parsed.version ?? '1.0.0',
      description: parsed.description ?? '',
      enabled: parsed.enabled !== false,
      builtIn: false,
      rules: Array.isArray(parsed.rules) ? parsed.rules.map((rule: Partial<RuleDef>) => ({
        id: rule.id ?? generateRuleId(),
        enabled: rule.enabled !== false,
        severity: rule.severity ?? 'medium',
        category: rule.category ?? 'maintainability',
        title: rule.title ?? '',
        content: rule.content ?? '',
        matchPatterns: Array.isArray(rule.matchPatterns) ? rule.matchPatterns : [],
        suggestionTemplate: rule.suggestionTemplate,
        scope: rule.scope,
      })) : [],
    };
    const validation = validateRulePack(pack);
    if (validation.length > 0) return { errors: validation.map((error) => error.message) };
    return { pack, errors: [] };
  } catch {
    return { errors: ['JSON 解析失败'] };
  }
}
