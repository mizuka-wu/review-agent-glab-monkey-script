import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const docsDir = join(root, 'rule_docs');
const target = join(root, 'src/core/builtin-rules.generated.ts');
const checkMode = process.argv.includes('--check');

function parseList(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    if (trimmed.startsWith('["') || trimmed.startsWith('[\'')) return JSON.parse(trimmed.replace(/'/g, '"'));
    return trimmed.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
  }
  return JSON.parse(trimmed);
}

function parseDoc(text) {
  const [ , frontmatter, body ] = text.split(/^---$/m);
  const meta = {};
  for (const line of frontmatter.trim().split('\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  const title = body.match(/^# (.+)$/m)?.[1]?.trim() ?? meta.title;
  const content = body.slice(body.indexOf(`# ${title}`) + title.length + 2, body.indexOf('## 匹配模式')).trim();
  const fence = body.match(/```pattern\n([\s\S]*?)```/)?.[1] ?? '';
  const patterns = fence.split('\n').filter((line) => line.trim().length > 0);
  const flags = meta.patternFlags ? JSON.parse(meta.patternFlags) : patterns.map(() => '');
  const rule = {
    id: meta.id,
    enabled: meta.enabled !== 'false',
    severity: meta.severity,
    category: meta.category,
    title,
    content,
    matchPatterns: patterns.map((pattern, index) => ({
      type: 'regex',
      pattern,
      ...(flags[index] ? { flags: flags[index] } : {}),
    })),
  };
  if (meta.suggestionTemplate) rule.suggestionTemplate = meta.suggestionTemplate;
  if (meta.scopeInclude || meta.scopeExclude) {
    rule.scope = {};
    if (meta.scopeInclude) rule.scope.include = parseList(meta.scopeInclude);
    if (meta.scopeExclude) rule.scope.exclude = parseList(meta.scopeExclude);
  }
  if (meta.languages) rule.languages = parseList(meta.languages);
  if (meta.fileLevel === 'true') rule.fileLevel = true;
  if (meta.skipComments === 'false') rule.skipComments = false;
  return rule;
}

const rules = readdirSync(docsDir)
  .filter((file) => file.endsWith('.md'))
  .sort()
  .map((file) => parseDoc(readFileSync(join(docsDir, file), 'utf8')));

const header = '// 由 scripts/generate-rules.mjs 从 rule_docs/*.md 生成，请勿手改。\n'
  + "import type { RuleDef } from './rule-packs';\n\n"
  + 'export const builtInRules: RuleDef[] = ';
const output = `${header}${JSON.stringify(rules, null, 2)};\n`;

if (checkMode) {
  const temp = mkdtempSync(join(tmpdir(), 'rules-'));
  const tempFile = join(temp, 'generated.ts');
  writeFileSync(tempFile, output);
  const current = readFileSync(target, 'utf8');
  rmSync(temp, { recursive: true, force: true });
  if (current !== output) {
    console.error('rule_docs/*.md 与 builtin-rules.generated.ts 不一致，请运行 pnpm generate:rules');
    process.exit(1);
  }
  console.log(`rule docs in sync (${rules.length} rules)`);
} else {
  writeFileSync(target, output);
  console.log(`Generated src/core/builtin-rules.generated.ts (${rules.length} rules)`);
}
