import { detectLanguage, type RuleLanguage } from './rule-packs';

/**
 * 浏览器端的轻量符号索引：GitLab REST 没有符号级 API（代码智能依赖 LSIF 且
 * 不通过 REST 暴露），因此把仓库文件缓存到本地后自己做启发式抽取。
 * 目标是"够用的符号搜索 + 调用链提示"，不是精确的调用图。
 */

export type SymbolKind = 'function' | 'method' | 'class' | 'type' | 'constant';

export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  signature: string;
  exported: boolean;
}

export interface SymbolRef {
  name: string;
  path: string;
  line: number;
  text: string;
  call: boolean;
  /** 该引用通过 import 解析到的定义文件；未解析出为 undefined。 */
  resolvedPath?: string;
}

export interface FileSymbols {
  path: string;
  language: RuleLanguage;
  bytes: number;
  defs: SymbolDef[];
}

export interface SymbolIndex {
  ref: string;
  indexedAt: string;
  files: FileSymbols[];
  refs: Record<string, SymbolRef[]>;
}

export interface CallChainNode {
  symbol: string;
  def?: SymbolDef;
  callers: { symbol: string; path: string; line: number; text: string }[];
  children: CallChainNode[];
}

const STOP_NAMES = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'await', 'async',
  'get', 'set', 'main', 'test', 'run', 'value', 'data', 'item', 'items', 'result', 'results',
  'name', 'type', 'id', 'key', 'keys', 'list', 'index', 'length', 'push', 'map', 'filter',
  'find', 'then', 'catch', 'toString', 'equals', 'hashCode', 'println', 'print', 'format',
  'string', 'number', 'boolean', 'object', 'void', 'null', 'true', 'false', 'self', 'this',
  'super', 'constructor', 'require', 'import', 'export', 'from', 'default',
]);

interface DefPattern { kind: SymbolKind; regex: RegExp; group?: number }

const PATTERNS: Partial<Record<RuleLanguage, DefPattern[]>> = {
  ts: [
    { kind: 'function', regex: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
    { kind: 'constant', regex: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=>/ },
    { kind: 'class', regex: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'type', regex: /^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'method', regex: /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/ },
  ],
  js: [
    { kind: 'function', regex: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
    { kind: 'constant', regex: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { kind: 'class', regex: /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  ],
  java: [
    { kind: 'class', regex: /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+|static\s+)*(?:class|interface|enum)\s+([A-Za-z_]\w*)/ },
    { kind: 'method', regex: /^\s*(?:@\w+\s+)?(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w<>\[\],. ]+?\s+([a-zA-Z_]\w*)\s*\([^)]*\)\s*(?:throws\s+[\w,. ]+)?\{/ },
  ],
  kotlin: [
    { kind: 'class', regex: /^\s*(?:public\s+|private\s+|internal\s+)?(?:data\s+|sealed\s+|abstract\s+|open\s+)*(?:class|interface|object|enum class)\s+([A-Za-z_]\w*)/ },
    { kind: 'function', regex: /^\s*(?:public\s+|private\s+|internal\s+)?(?:suspend\s+)?fun\s+(?:<[^>]+>\s*)?([a-zA-Z_]\w*)\s*\(/ },
  ],
  python: [
    { kind: 'function', regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: 'class', regex: /^\s*class\s+([A-Za-z_]\w*)/ },
  ],
  go: [
    { kind: 'function', regex: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: 'type', regex: /^type\s+([A-Za-z_]\w*)/ },
  ],
  rust: [
    { kind: 'function', regex: /^(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([a-zA-Z_]\w*)/ },
    { kind: 'type', regex: /^(?:pub\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/ },
  ],
  ruby: [
    { kind: 'method', regex: /^\s*def\s+(?:self\.)?([a-zA-Z_]\w*)/ },
    { kind: 'class', regex: /^\s*(?:class|module)\s+([A-Za-z_]\w*)/ },
  ],
  php: [
    { kind: 'method', regex: /^\s*(?:public|private|protected)?\s*(?:static\s+)?function\s+([a-zA-Z_]\w*)/ },
    { kind: 'class', regex: /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/ },
  ],
  csharp: [
    { kind: 'class', regex: /^\s*(?:public\s+|private\s+|internal\s+)?(?:abstract\s+|sealed\s+|static\s+)*(?:class|interface|struct|enum)\s+([A-Za-z_]\w*)/ },
    { kind: 'method', regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?(?:virtual\s+|override\s+)?[\w<>\[\],. ]+?\s+([a-zA-Z_]\w*)\s*\([^)]*\)/ },
  ],
  cpp: [
    { kind: 'class', regex: /^\s*(?:class|struct|enum class)\s+([A-Za-z_]\w*)/ },
    { kind: 'function', regex: /^[\w:<>*& ]+\s+([a-zA-Z_]\w*)\s*\([^)]*\)\s*(?:const\s*)?(?:\{|$)/ },
  ],
  c: [
    { kind: 'function', regex: /^[\w][\w *]*\s+([a-zA-Z_]\w*)\s*\([^)]*\)\s*\{/ },
    { kind: 'type', regex: /^\s*(?:typedef\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/ },
  ],
  swift: [
    { kind: 'function', regex: /^\s*(?:public\s+|private\s+|internal\s+)?(?:static\s+)?func\s+([a-zA-Z_]\w*)/ },
    { kind: 'class', regex: /^\s*(?:public\s+|final\s+)*(?:class|struct|enum|protocol)\s+([A-Za-z_]\w*)/ },
  ],
  scala: [
    { kind: 'function', regex: /^\s*(?:public\s+|private\s+)?(?:def)\s+([a-zA-Z_]\w*)/ },
    { kind: 'class', regex: /^\s*(?:case\s+)?(?:class|object|trait)\s+([A-Za-z_]\w*)/ },
  ],
};

export function extractFileSymbols(path: string, content: string): FileSymbols {
  const language = detectLanguage(path);
  const patterns = PATTERNS[language];
  const defs: SymbolDef[] = [];
  if (patterns) {
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (!match) continue;
        const name = match[1];
        if (!name || STOP_NAMES.has(name) || name.length < 2) continue;
        if (defs.some((def) => def.name === name && def.line === index + 1)) continue;
        defs.push({
          name,
          kind: pattern.kind,
          path,
          line: index + 1,
          signature: line.trim().slice(0, 140),
          exported: /^(?:export|public)\b/.test(line.trim()),
        });
        break;
      }
    }
  }
  return { path, language, bytes: content.length, defs };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** 第二遍扫描：为每个符号收集跨文件引用与调用点。 */
export function buildSymbolIndex(input: {
  ref: string;
  files: { path: string; language: RuleLanguage; bytes: number; defs: SymbolDef[]; content: string }[];
  indexedAt?: string;
}): SymbolIndex {
  const names = [...new Set(input.files.flatMap((file) => file.defs.map((def) => def.name)))]
    .filter((name) => !STOP_NAMES.has(name) && name.length >= 3);

  const refs: Record<string, SymbolRef[]> = {};
  const knownPaths = new Set(input.files.map((file) => file.path));
  const importMaps = new Map(input.files.map((file) => [file.path, extractImportMap(file.path, file.language, file.content, knownPaths)]));
  const defLines = new Map<string, Set<number>>();
  for (const file of input.files) {
    for (const def of file.defs) {
      const key = `${def.path}\u0000${def.name}`;
      if (!defLines.has(key)) defLines.set(key, new Set());
      defLines.get(key)!.add(def.line);
    }
  }

  for (const group of chunk(names, 120)) {
    const regex = new RegExp(`\\b(${group.map(escapeRegex).join('|')})\\b`, 'g');
    for (const file of input.files) {
      const lines = file.content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line || line.length > 400) continue;
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        const seenOnLine = new Set<string>();
        while ((match = regex.exec(line)) !== null) {
          const name = match[1];
          if (seenOnLine.has(name)) continue;
          seenOnLine.add(name);
          if (defLines.get(`${file.path}\u0000${name}`)?.has(index + 1)) continue;
          const call = new RegExp(`\\b${escapeRegex(name)}\\s*\\(`).test(line);
          (refs[name] ??= []).push({
            name, path: file.path, line: index + 1, text: line.trim().slice(0, 160), call,
            resolvedPath: importMaps.get(file.path)?.get(name),
          });
        }
      }
    }
  }

  return {
    ref: input.ref,
    indexedAt: input.indexedAt ?? new Date().toISOString(),
    files: input.files.map(({ content: _content, ...rest }) => rest),
    refs,
  };
}

const IMPORT_RESOLVERS: { languages: RuleLanguage[]; regex: RegExp; pick: (m: RegExpMatchArray) => { local: string; from: string }[] }[] = [
  {
    languages: ['ts', 'js'],
    regex: /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g,
    pick: (m) => m[1].split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
      const [origin, alias] = part.split(/\s+as\s+/);
      return { local: (alias ?? origin).trim(), from: m[2] };
    }),
  },
  {
    languages: ['ts', 'js'],
    regex: /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g,
    pick: (m) => [{ local: m[1], from: m[2] }],
  },
  {
    languages: ['ts', 'js'],
    regex: /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g,
    pick: (m) => [{ local: m[1], from: m[2] }],
  },
  {
    languages: ['python'],
    regex: /from\s+([\w.]+)\s+import\s+([^#\n]+)/g,
    pick: (m) => m[2].split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
      const [origin, alias] = part.split(/\s+as\s+/);
      return { local: (alias ?? origin).trim(), from: m[1] };
    }),
  },
  {
    languages: ['go'],
    regex: /import\s+(?:\w+\s+)?["']([^"']+)["']/g,
    pick: (m) => [{ local: m[1].split('/').pop() ?? m[1], from: m[1] }],
  },
];

/** 解析 import 绑定：本地名 → 定义文件（仅在索引已知文件中解析）。 */
export function extractImportMap(
  path: string,
  language: RuleLanguage,
  content: string,
  knownPaths: Set<string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const resolver of IMPORT_RESOLVERS) {
    if (!resolver.languages.includes(language)) continue;
    resolver.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = resolver.regex.exec(content)) !== null) {
      for (const { local, from } of resolver.pick(match)) {
        const resolved = resolveModulePath(from, path, knownPaths);
        if (resolved) map.set(local, resolved);
      }
    }
  }
  return map;
}

function resolveModulePath(specifier: string, fromPath: string, known: Set<string>): string | undefined {
  const clean = specifier.trim();
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const join = (base: string, relative: string) => {
    const out: string[] = [];
    for (const part of [...base.split('/'), ...relative.split('/')]) {
      if (part === '..') out.pop();
      else if (part !== '' && part !== '.') out.push(part);
    }
    return out.join('/');
  };
  if (clean.startsWith('.')) {
    const base = join(dir, clean);
    return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.py`, `${base}.go`, `${base}/index.ts`, `${base}/index.js`]
      .find((candidate) => known.has(candidate));
  }
  if (!clean.startsWith('/') && /^[\w.]+$/.test(clean) && clean.includes('.')) {
    const asPath = clean.replace(/\./g, '/');
    return [`${asPath}.py`, `${asPath}/__init__.py`].find((candidate) => known.has(candidate));
  }
  return undefined;
}

/** 调用点归属判定：优先 import 解析结果；无解析信息时排除「同文件内有同名定义」的自调用误边。 */
function isRealCaller(
  fileOf: Map<string, SymbolIndex['files'][number]>,
  defPath: string,
  name: string,
  ref: SymbolRef,
): boolean {
  if (ref.resolvedPath) return ref.resolvedPath === defPath;
  const localDef = fileOf.get(ref.path)?.defs.some((item) => item.name === name);
  return !localDef;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SymbolSearchResult {
  defs: SymbolDef[];
  refs: SymbolRef[];
}

export function searchSymbols(index: SymbolIndex, query: string, limit = 20): SymbolSearchResult {
  const needle = query.trim().toLowerCase();
  if (!needle) return { defs: [], refs: [] };
  const allDefs = index.files.flatMap((file) => file.defs);
  const defs = allDefs
    .filter((def) => def.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(a.name.toLowerCase() !== needle) - Number(b.name.toLowerCase() !== needle))
    .slice(0, limit);
  const exact = index.refs[query.trim()] ?? [];
  const refs = exact.length > 0
    ? exact.slice(0, limit * 2)
    : defs.flatMap((def) => index.refs[def.name] ?? []).slice(0, limit * 2);
  return { defs, refs };
}

function enclosingSymbol(file: FileSymbols | undefined, line: number): string | undefined {
  if (!file) return undefined;
  let found: SymbolDef | undefined;
  for (const def of file.defs) {
    if (def.line <= line && (def.kind === 'function' || def.kind === 'method')) found = def;
    if (def.line > line) break;
  }
  return found?.name;
}

/** 启发式调用链：谁调用了 symbol，以及调用者又被谁调用（限深）。 */
export function buildCallChain(index: SymbolIndex, symbol: string, depth = 2): CallChainNode {
  const fileOf = new Map(index.files.map((file) => [file.path, file]));
  const allDefs = index.files.flatMap((file) => file.defs);

  const visit = (name: string, remaining: number, visited: Set<string>): CallChainNode => {
    const def = allDefs.find((item) => item.name === name);
    const callers: CallChainNode['callers'] = [];
    for (const ref of index.refs[name] ?? []) {
      if (!ref.call) continue;
      if (def && ref.path !== def.path && !isRealCaller(fileOf, def.path, name, ref)) continue;
      const file = fileOf.get(ref.path);
      const caller = enclosingSymbol(file, ref.line);
      callers.push({
        symbol: caller ?? `${ref.path}（模块级）`,
        path: ref.path,
        line: ref.line,
        text: ref.text,
      });
    }
    const unique = new Map<string, CallChainNode['callers'][number]>();
    for (const caller of callers) unique.set(`${caller.symbol}@${caller.path}:${caller.line}`, caller);
    const list = [...unique.values()].slice(0, 12);

    const children: CallChainNode[] = [];
    if (remaining > 0) {
      const nextVisited = new Set(visited);
      nextVisited.add(name);
      for (const caller of list) {
        if (nextVisited.has(caller.symbol) || caller.symbol.includes('（模块级）')) continue;
        children.push(visit(caller.symbol, remaining - 1, nextVisited));
      }
    }
    return { symbol: name, def, callers: list, children };
  };

  return visit(symbol, depth, new Set());
}

/** 供 Review 提示词使用的紧凑仓库上下文：变更文件定义了哪些符号、被谁调用。 */
export function contextForFiles(index: SymbolIndex, paths: string[], budgetCharacters = 2400): string {
  const changed = new Set(paths);
  const lines: string[] = [];
  let used = 0;
  for (const path of paths) {
    const file = index.files.find((item) => item.path === path);
    if (!file || file.defs.length === 0) continue;
    for (const def of file.defs.slice(0, 8)) {
      const callers = (index.refs[def.name] ?? [])
        .filter((ref) => ref.call && !changed.has(ref.path))
        .slice(0, 4)
        .map((ref) => `${ref.path}:${ref.line}`);
      const line = callers.length > 0
        ? `- ${path} 定义 ${def.kind} ${def.name}()，被 Diff 外调用：${callers.join(', ')}`
        : `- ${path} 定义 ${def.kind} ${def.name}()，Diff 外暂无调用点`;
      if (used + line.length > budgetCharacters) return lines.join('\n');
      lines.push(line);
      used += line.length;
    }
  }
  return lines.join('\n');
}
