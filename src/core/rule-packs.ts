import { fingerprintFinding } from './findings';
import type { FileDiff, Finding, FindingCategory, FindingSeverity } from './types';

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

export type RuleLanguage =
  | 'ts' | 'js' | 'java' | 'kotlin' | 'python' | 'go' | 'rust' | 'php' | 'ruby'
  | 'csharp' | 'cpp' | 'c' | 'swift' | 'scala' | 'sql' | 'shell' | 'yaml'
  | 'json' | 'xml' | 'html' | 'markdown' | 'terraform' | 'protobuf' | 'other';

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
  /** 省略表示对所有语言生效。 */
  languages?: RuleLanguage[];
  /** 文件级规则：不逐行匹配，整个变更集只产出一条（如“缺少回归测试”）。 */
  fileLevel?: boolean;
  /** 默认跳过纯注释行，减少噪声；TODO / 冲突标记这类规则需要关闭。 */
  skipComments?: boolean;
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

const EXTENSION_LANGUAGES: Record<string, RuleLanguage> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', vue: 'ts', astro: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', svelte: 'js',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  py: 'python', pyi: 'python',
  go: 'go', rs: 'rust', php: 'php', rb: 'ruby',
  cs: 'csharp', c: 'c', h: 'cpp', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
  swift: 'swift', scala: 'scala',
  sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', yaml: 'yaml', json: 'json', xml: 'xml', html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown', tf: 'terraform', proto: 'protobuf',
};

const FILENAME_LANGUAGES: Record<string, RuleLanguage> = {
  dockerfile: 'shell', makefile: 'shell', jenkinsfile: 'shell',
  'package.json': 'json', 'tsconfig.json': 'json',
};

export function detectLanguage(path: string): RuleLanguage {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (FILENAME_LANGUAGES[name]) return FILENAME_LANGUAGES[name];
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'shell';
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return EXTENSION_LANGUAGES[extension] ?? 'other';
}

const HASH_COMMENT_LANGUAGES = new Set<RuleLanguage>(['python', 'ruby', 'yaml', 'shell', 'terraform']);
const SLASH_COMMENT_LANGUAGES = new Set<RuleLanguage>([
  'ts', 'js', 'java', 'kotlin', 'go', 'rust', 'php', 'csharp', 'cpp', 'c', 'swift', 'scala', 'protobuf',
]);

export function isCommentLine(text: string, language: RuleLanguage): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) return true;
  if (SLASH_COMMENT_LANGUAGES.has(language) && (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'))) return true;
  if (HASH_COMMENT_LANGUAGES.has(language) && trimmed.startsWith('#')) return true;
  if (language === 'sql' && trimmed.startsWith('--')) return true;
  if (language === 'xml' && trimmed.startsWith('<!--')) return true;
  if (language === 'html' && trimmed.startsWith('<!--')) return true;
  return false;
}

// --- Built-in rules ---

import { builtInRules } from './builtin-rules.generated';

const testPattern = /(?:\.test\.|\.spec\.|\/__tests__\/|\/tests?\/|_test\.go$|\/testdata\/)/i;

export const BUILT_IN_PACK: RulePack = {
  id: 'built-in',
  name: '内置规则',
  version: '1.1.0',
  description: '无需模型即可运行的确定性检查：安全（密钥、注入、XSS、弱加密、TLS）、正确性（NPE、线程安全、错误吞掉）、测试与可维护性。',
  enabled: true,
  builtIn: true,
  rules: builtInRules,
};

/** 单个规则在单个文件内最多产出的 Finding 数，超出部分合并为 occurrences 计数。 */
const MAX_HITS_PER_RULE_FILE = 8;

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

/** 规则包作用域：公共（全站）或按 GitLab 项目隔离。 */
export type RulePackScope = { kind: 'public' } | { kind: 'project'; key: string };

export const PUBLIC_RULE_PACK_SCOPE: RulePackScope = { kind: 'public' };

export function rulePackStorageKey(scope: RulePackScope): string {
  return scope.kind === 'public' ? STORAGE_KEY : `${STORAGE_KEY}::project::${scope.key}`;
}

export async function loadScopedRulePacks(scope: RulePackScope, storage = defaultStorage()): Promise<RulePack[]> {
  const key = rulePackStorageKey(scope);
  const raw = await storage.getValue(key, []);
  const savedPacks = Array.isArray(raw) ? (raw as RulePack[]) : [];
  const userPacks = savedPacks.filter((pack) => pack.id !== BUILT_IN_PACK.id && Array.isArray(pack.rules));

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

export async function saveScopedRulePacks(packs: RulePack[], scope: RulePackScope, storage = defaultStorage()): Promise<void> {
  const toSave = packs.map((pack) => {
    if (!pack.builtIn) return pack;
    return { ...pack, rules: pack.rules.map((rule) => ({ id: rule.id, enabled: rule.enabled })) };
  });
  await storage.setValue(rulePackStorageKey(scope), toSave);
}

export async function addScopedRulePack(pack: RulePack, scope: RulePackScope, storage = defaultStorage()): Promise<RulePack[]> {
  const packs = await loadScopedRulePacks(scope, storage);
  const filtered = packs.filter((existing) => existing.id !== pack.id);
  filtered.push(pack);
  await saveScopedRulePacks(filtered, scope, storage);
  return filtered;
}

export async function removeScopedRulePack(packId: string, scope: RulePackScope, storage = defaultStorage()): Promise<RulePack[]> {
  const packs = await loadScopedRulePacks(scope, storage);
  const filtered = packs.filter((pack) => pack.id !== packId || pack.builtIn);
  await saveScopedRulePacks(filtered, scope, storage);
  return filtered;
}

/** 项目作用域的自定义包覆盖同 id 的公共包；内置包开关以公共作用域为准。 */
export function mergeScopedRulePacks(publicPacks: RulePack[], projectPacks: RulePack[]): RulePack[] {
  const builtin = publicPacks.find((pack) => pack.builtIn) ?? BUILT_IN_PACK;
  const users = new Map<string, RulePack>();
  for (const pack of [...publicPacks, ...projectPacks]) {
    if (!pack.builtIn) users.set(pack.id, pack);
  }
  return [builtin, ...users.values()];
}

export async function loadRulePacks(storage = defaultStorage()): Promise<RulePack[]> {
  return loadScopedRulePacks(PUBLIC_RULE_PACK_SCOPE, storage);
}

export async function saveRulePacks(packs: RulePack[], storage = defaultStorage()): Promise<void> {
  await saveScopedRulePacks(packs, PUBLIC_RULE_PACK_SCOPE, storage);
}

export async function addRulePack(pack: RulePack, storage = defaultStorage()): Promise<RulePack[]> {
  return addScopedRulePack(pack, PUBLIC_RULE_PACK_SCOPE, storage);
}

export async function removeRulePack(packId: string, storage = defaultStorage()): Promise<RulePack[]> {
  return removeScopedRulePack(packId, PUBLIC_RULE_PACK_SCOPE, storage);
}

// --- ID generation ---

export function generateRulePackId(): string {
  return `rp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function generateRuleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// --- Rule inventory helpers ---

export function enabledRulesOf(packs: RulePack[]): { pack: RulePack; rule: RuleDef }[] {
  return packs
    .filter((pack) => pack.enabled)
    .flatMap((pack) => pack.rules.filter((rule) => rule.enabled).map((rule) => ({ pack, rule })));
}

export function countEnabledRules(packs: RulePack[]): number {
  return enabledRulesOf(packs).length;
}

// --- Evaluation ---

const patternCache = new Map<string, RegExp | null>();

function compilePattern(pattern: RulePattern): RegExp | null {
  const key = `${pattern.pattern}:${pattern.flags ?? ''}`;
  if (patternCache.has(key)) return patternCache.get(key)!;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(pattern.pattern, pattern.flags ?? '');
  } catch {
    // Invalid regex from user-imported rule pack
  }
  patternCache.set(key, compiled);
  return compiled;
}

function evaluateRuleOnLine(rule: RuleDef, line: string): boolean {
  return rule.matchPatterns.some((pattern) => {
    const compiled = compilePattern(pattern);
    return compiled ? compiled.test(line) : false;
  });
}

function applySuggestion(original: string, template?: string): string {
  if (!template) return '';
  if (template === 'logger.debug') {
    return original.replace(/console\.(?:log|debug|info)/, 'logger.debug');
  }
  return template;
}

function isFileLevel(rule: RuleDef): boolean {
  return rule.fileLevel === true || rule.id === 'builtin-missing-test';
}

/**
 * contextFiles 是参考变更（配套的其他 MR）：只参与「整个变更集是否已经补了测试」这类跨文件判断，
 * 本身绝不产出 Finding —— 参考 MR 不是评审对象，也不会有发布位置。
 */
export function runRulePackReview(files: FileDiff[], packs: RulePack[], contextFiles: FileDiff[] = []): Finding[] {
  const findings: Finding[] = [];
  const inventory = enabledRulesOf(packs);
  const hasTestChange = [...files, ...contextFiles].some((candidate) => testPattern.test(candidate.newPath));

  for (const file of files) {
    const language = detectLanguage(file.newPath);
    const addedLines = file.lines.filter((line) => line.kind === 'added');

    for (const { pack, rule } of inventory) {
      if (rule.languages && !rule.languages.includes(language)) continue;
      if (!matchesScope(file.newPath, rule.scope)) continue;

      if (isFileLevel(rule)) {
        if (addedLines.length === 0 || testPattern.test(file.newPath) || hasTestChange) continue;
        const firstAdded = addedLines[0];
        findings.push(createFindingFromRule({
          rule, pack, file,
          line: firstAdded?.newLine ?? 1,
          existingCode: firstAdded?.text ?? file.newPath,
        }));
        continue;
      }

      if (rule.matchPatterns.length === 0) continue;
      const skipComments = rule.skipComments !== false;

      const hits = addedLines.filter((line) => {
        if (skipComments && isCommentLine(line.text, language)) return false;
        return evaluateRuleOnLine(rule, line.text);
      });
      if (hits.length === 0) continue;

      for (const line of hits.slice(0, MAX_HITS_PER_RULE_FILE)) {
        findings.push(createFindingFromRule({
          rule, pack, file,
          line: line.newLine ?? 1,
          existingCode: line.text,
          suggestionCode: applySuggestion(line.text, rule.suggestionTemplate),
          occurrences: hits.length,
        }));
      }
    }
  }

  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.fingerprint)) return false;
    seen.add(finding.fingerprint);
    return true;
  });
}

function createFindingFromRule(input: {
  rule: RuleDef;
  pack: RulePack;
  file: FileDiff;
  line: number;
  existingCode: string;
  suggestionCode?: string;
  occurrences?: number;
}): Finding {
  const { rule, pack, file, line, existingCode, occurrences } = input;
  const path = file.newPath;
  const fingerprint = fingerprintFinding({ path, existingCode, category: rule.category, title: rule.title, line });
  const occurrenceNote = occurrences && occurrences > 1 ? `\n\n同一规则在该文件共命中 ${occurrences} 处。` : '';
  return {
    id: fingerprint,
    fingerprint,
    path,
    oldPath: file.oldPath,
    newPath: file.newPath,
    newFile: file.newFile,
    deletedFile: file.deletedFile,
    line,
    endLine: line,
    side: 'new',
    category: rule.category,
    severity: rule.severity,
    confidence: 'high',
    title: rule.title,
    content: rule.content + occurrenceNote,
    evidence: [{ path, lines: `L${line}`, quote: existingCode.trim() }],
    existingCode,
    suggestionCode: input.suggestionCode ?? '',
    comment: `${rule.title}\n\n${rule.content}${occurrenceNote}\n\n\`\`\`\n${existingCode.trim()}\n\`\`\`\n\n<sub>规则检查 \`${rule.id}\`${pack.builtIn ? '' : ` · ${pack.name}`}</sub>`,
    source: 'rule',
    status: 'draft',
    ruleId: rule.id,
    rulePackId: pack.id,
    rulePackName: pack.name,
    occurrences: occurrences && occurrences > 1 ? occurrences : undefined,
    fileLevel: isFileLevel(rule) ? true : undefined,
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
      if ((!rule.matchPatterns || rule.matchPatterns.length === 0) && !isFileLevel(rule)) {
        errors.push({ field: `rule.${rule.id}.matchPatterns`, message: '至少需要一个匹配模式' });
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
  return JSON.stringify({ ...pack, builtIn: false }, null, 2);
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
        languages: Array.isArray(rule.languages) ? rule.languages : undefined,
        fileLevel: rule.fileLevel,
        skipComments: rule.skipComments,
      })) : [],
    };
    const validation = validateRulePack(pack);
    if (validation.length > 0) return { errors: validation.map((error) => error.message) };
    return { pack, errors: [] };
  } catch {
    return { errors: ['JSON 解析失败'] };
  }
}
