import { describe, expect, it } from 'vitest';
import {
  buildCallChain, buildSymbolIndex, contextForFiles, extractFileSymbols, searchSymbols,
} from '../../src/core/symbols';

const tsSource = [
  'export function verifyToken(token: string) {',
  '  return decode(token);',
  '}',
  'function decode(value: string) {',
  '  return value;',
  '}',
  'export class PaymentService {',
  '  pay(amount: number) {',
  '    return verifyToken("t");',
  '  }',
  '}',
].join('\n');

const callerSource = [
  'import { verifyToken } from "./auth";',
  'export function handler(req: Request) {',
  '  if (verifyToken(req.token)) return ok();',
  '  return fail();',
  '}',
].join('\n');

function index() {
  return buildSymbolIndex({
    ref: 'sha',
    files: [
      { ...extractFileSymbols('src/auth.ts', tsSource), content: tsSource },
      { ...extractFileSymbols('src/handler.ts', callerSource), content: callerSource },
    ],
  });
}

describe('extractFileSymbols', () => {
  it('extracts functions, arrow constants, classes and methods', () => {
    const symbols = extractFileSymbols('src/auth.ts', tsSource);
    const names = symbols.defs.map((def) => `${def.kind}:${def.name}`);
    expect(names).toEqual(expect.arrayContaining(['function:verifyToken', 'function:decode', 'class:PaymentService', 'method:pay']));
    expect(symbols.defs.find((def) => def.name === 'verifyToken')).toMatchObject({ line: 1, exported: true });
    expect(symbols.defs.find((def) => def.name === 'decode')?.exported).toBe(false);
  });

  it('extracts python / go / java definitions', () => {
    expect(extractFileSymbols('a.py', 'def compute(x):\n    return x\n\nclass Repo:\n    pass').defs.map((d) => d.name))
      .toEqual(expect.arrayContaining(['compute', 'Repo']));
    expect(extractFileSymbols('a.go', 'func Load(id string) error {\n\treturn nil\n}\n\ntype Store struct{}').defs.map((d) => d.name))
      .toEqual(expect.arrayContaining(['Load', 'Store']));
    expect(extractFileSymbols('A.java', 'public class Pay {\n  public static void send(String id) {\n  }\n}').defs.map((d) => d.name))
      .toEqual(expect.arrayContaining(['Pay', 'send']));
  });
});

describe('buildSymbolIndex', () => {
  it('records cross-file call sites and skips the definition line', () => {
    const built = index();
    const refs = built.refs.verifyToken ?? [];
    expect(refs.some((ref) => ref.path === 'src/handler.ts' && ref.line === 3 && ref.call)).toBe(true);
    expect(refs.some((ref) => ref.path === 'src/auth.ts' && ref.line === 1)).toBe(false);
    expect(built.files.every((file) => !('content' in file))).toBe(true);
  });
});

describe('searchSymbols', () => {
  it('matches exact names first and returns refs', () => {
    const result = searchSymbols(index(), 'verify');
    expect(result.defs[0]?.name).toBe('verifyToken');
    expect(result.refs.length).toBeGreaterThan(0);
  });

  it('returns empty for blank query', () => {
    expect(searchSymbols(index(), '  ')).toEqual({ defs: [], refs: [] });
  });
});

describe('buildCallChain', () => {
  it('walks callers up to the requested depth', () => {
    const chain = buildCallChain(index(), 'verifyToken', 2);
    expect(chain.symbol).toBe('verifyToken');
    expect(chain.callers.map((caller) => caller.symbol)).toEqual(expect.arrayContaining(['handler', 'pay']));
  });

  it('resolves each node definition independently', () => {
    const chain = buildCallChain(index(), 'verifyToken', 2);
    const handlerNode = chain.children.find((child) => child.symbol === 'handler');
    expect(handlerNode?.def).toMatchObject({ path: 'src/handler.ts', line: 2 });
    expect(chain.def).toMatchObject({ path: 'src/auth.ts', line: 1 });
  });

  it('resolves each node definition independently', () => {
    const chain = buildCallChain(index(), 'verifyToken', 2);
    const handlerNode = chain.children.find((child) => child.symbol === 'handler');
    expect(handlerNode?.def).toMatchObject({ path: 'src/handler.ts', line: 2 });
    expect(chain.def).toMatchObject({ path: 'src/auth.ts', line: 1 });
  });

  it('reports missing definitions', () => {
    const chain = buildCallChain(index(), 'unknownSymbol', 1);
    expect(chain.def).toBeUndefined();
    expect(chain.callers).toEqual([]);
  });
});

describe('contextForFiles', () => {
  it('lists definitions and out-of-diff callers for changed files', () => {
    const text = contextForFiles(index(), ['src/auth.ts']);
    expect(text).toContain('src/auth.ts 定义 function verifyToken()');
    expect(text).toContain('src/handler.ts:3');
  });

  it('respects the character budget', () => {
    expect(contextForFiles(index(), ['src/auth.ts'], 10)).toHaveLength(0);
  });
});

describe('import-aware symbol precision', () => {
  const a = { path: 'src/a.ts', language: 'ts' as const, bytes: 10, content: 'export function loadConfig() {\n  return 1;\n}\n', defs: [] as never[] };
  function indexed() {
    const files = [
      { path: 'src/a.ts', language: 'ts' as const, bytes: 40, content: 'export function loadConfig() {\n  return 1;\n}\n', defs: extractFileSymbols('src/a.ts', 'export function loadConfig() {\n  return 1;\n}\n').defs },
      { path: 'src/b.ts', language: 'ts' as const, bytes: 60, content: "import { loadConfig } from './a';\nexport function run() {\n  return loadConfig();\n}\n", defs: extractFileSymbols('src/b.ts', "import { loadConfig } from './a';\nexport function run() {\n  return loadConfig();\n}\n").defs },
      { path: 'src/c.ts', language: 'ts' as const, bytes: 60, content: 'function loadConfig() {\n  return 2;\n}\nexport function other() {\n  return loadConfig();\n}\n', defs: extractFileSymbols('src/c.ts', 'function loadConfig() {\n  return 2;\n}\nexport function other() {\n  return loadConfig();\n}\n').defs },
    ];
    return buildSymbolIndex({ ref: 'r1', files });
  }

  it('resolves imported bindings to their defining file', () => {
    const index = indexed();
    const refs = index.refs['loadConfig'] ?? [];
    const fromB = refs.find((ref) => ref.path === 'src/b.ts' && ref.call);
    expect(fromB?.resolvedPath).toBe('src/a.ts');
  });

  it('excludes same-name local definitions from call chains', () => {
    const index = indexed();
    const chain = buildCallChain(index, 'loadConfig');
    const callerPaths = chain.callers.map((caller) => caller.path);
    expect(callerPaths).toContain('src/b.ts');
    expect(callerPaths).not.toContain('src/c.ts');
  });
});
