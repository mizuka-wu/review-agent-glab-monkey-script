import { describe, expect, it, vi, afterEach } from 'vitest';
import { anchorFindings, resolvePublishPosition } from '../../src/core/anchor';
import { buildReviewContext, includedFiles } from '../../src/core/context';
import {
  NUMBERED_DIFF_LEGEND, diffContext, diffPromptSize, normalizeFileDiff, numberedDiff,
} from '../../src/core/diff';
import { normalizeFindings, parseModelFindings } from '../../src/core/findings';
import { OpenAIRuntime, reviewSystemPrompt } from '../../src/core/openai-runtime';
import { fileCharSize } from '../../src/core/review-bundles';
import type { FileDiff, Finding } from '../../src/core/types';

/** 真实形状的多 hunk diff：接口新增字段 + 函数体改写，含缩进行、空上下文行、新增空行。 */
const MULTI_HUNK = [
  '@@ -13,4 +13,5 @@ export const key = "diagram";',
  ' export interface Diagram {',
  '-  legacy: string;',
  '+  customProperties?: Map<string, string>;',
  '+  extra?: number;',
  '   mxGraphModel: MxGraphModel;',
  ' }',
  '@@ -40,4 +41,7 @@ export function parse(object: Diagram) {',
  '   const element = new Map();',
  '',
  '-  return element;',
  '+  const properties = new Map<string, string>();',
  '+  element.set("customProperties", properties);',
  '+',
  '+  return element;',
  ' }',
].join('\n');

const PATH = 'packages/y-mxgraph/src/models/diagram.ts';
const file = normalizeFileDiff({ old_path: PATH, new_path: PATH, diff: MULTI_HUNK });

const finding = (input: Partial<Finding>): Finding => ({
  id: 'id', fingerprint: 'fp', path: PATH, line: 0, endLine: 0, side: 'new',
  category: 'bug', severity: 'medium', confidence: 'medium', title: 'Title', content: 'Content',
  evidence: [], existingCode: '', suggestionCode: '', comment: 'Comment', source: 'model', status: 'draft',
  ...input,
});

describe('numberedDiff：三类行各自标对应侧的行号', () => {
  it('新增行标 new 侧、删除行标 old 侧、上下文行标 new 侧，hunk 头原样保留', () => {
    expect(numberedDiff(MULTI_HUNK).split('\n')).toEqual([
      '@@ -13,4 +13,5 @@ export const key = "diagram";',
      ' L13 export interface Diagram {',
      '-L14   legacy: string;',
      '+L14   customProperties?: Map<string, string>;',
      '+L15   extra?: number;',
      ' L16   mxGraphModel: MxGraphModel;',
      ' L17 }',
      '@@ -40,4 +41,7 @@ export function parse(object: Diagram) {',
      ' L41   const element = new Map();',
      ' L42',
      '-L42   return element;',
      '+L43   const properties = new Map<string, string>();',
      '+L44   element.set("customProperties", properties);',
      '+L45',
      '+L46   return element;',
      ' L47 }',
    ]);
  });

  it('每个 hunk 都从自己的 @@ 头重新起算，不接着上一个 hunk 往下数', () => {
    const numbered = numberedDiff(MULTI_HUNK).split('\n');
    expect(numbered[8]).toBe(' L41   const element = new Map();');
    expect(numbered.filter((row) => row.startsWith('@@'))).toHaveLength(2);
  });

  it('hunk 之外的文件头与 \\ No newline 标记原样透出，不占行号', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1234567..89abcde 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-const a = 1;',
      '+const a = 2;',
      '\\ No newline at end of file',
    ].join('\n');

    expect(numberedDiff(diff).split('\n')).toEqual([
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1234567..89abcde 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-L1 const a = 1;',
      '+L1 const a = 2;',
      '\\ No newline at end of file',
    ]);
  });

  it('末尾换行不会切出一个凭空编号的幻影行', () => {
    expect(numberedDiff('@@ -0,0 +1,2 @@\n+one\n+two\n')).toBe('@@ -0,0 +1,2 @@\n+L1 one\n+L2 two');
  });

  it('空行只留行号标记，不带悬空的尾随空格', () => {
    expect(numberedDiff('@@ -1,3 +1,3 @@\n a\n+\n c')).toBe('@@ -1,3 +1,3 @@\n L1 a\n+L2\n L3 c');
  });

  it('没有 hunk 头的 diff（选区合成）不编号：不替模型编造行号', () => {
    expect(numberedDiff('+a\n+b')).toBe('+a\n+b');
  });

  it('CRLF 与末尾换行的 diff 同样逐行编号', () => {
    expect(numberedDiff('@@ -1 +1 @@\r\n-a\r\n+b\r\n')).toBe('@@ -1 +1 @@\n-L1 a\n+L1 b');
  });
});

describe('diffContext：图例 + 带行号的 diff', () => {
  it('格式说明写在 diff 前面，文件段里每行都带行号', () => {
    const context = diffContext([file]);
    expect(context.startsWith(`${NUMBERED_DIFF_LEGEND}\n\n### ${PATH}\n`)).toBe(true);
    expect(context).toContain('+L14   customProperties?: Map<string, string>;');
    expect(context).toContain('-L42   return element;');
  });

  it('图例自己占预算：算上图例才超预算的文件照样被裁并说明原因', () => {
    const chunk = `### ${PATH}\n${numberedDiff(MULTI_HUNK)}`;
    expect(diffContext([file], chunk.length)).toContain('context budget exceeded');
    expect(diffContext([file], chunk.length + NUMBERED_DIFF_LEGEND.length + 2)).not.toContain('context budget exceeded');
  });

  it('没有文件时连图例都不渲染', () => {
    expect(diffContext([])).toBe('');
  });
});

/** 按行数造一个真实形状的大 diff：每行 ~45 字符，用来量行号前缀的占比。 */
function manyHunks(hunks: number, rows: number): string {
  const parts: string[] = [];
  for (let hunk = 0; hunk < hunks; hunk += 1) {
    const start = hunk * 100 + 1;
    parts.push(`@@ -${start},${rows + 2} +${start},${rows + 2} @@ export function handler${hunk}(payload: Payload) {`);
    for (let row = 0; row < rows; row += 1) {
      parts.push(`   const normalizedValue${row} = normalizePayloadValue(payload, ${row});`);
    }
    parts.push('-  return legacySerialize(normalizedValue0);');
    parts.push('+  return serialize(normalizedValue0, { strict: true });');
  }
  return parts.join('\n');
}

describe('行号前缀如实计入上下文预算', () => {
  it('buildReviewContext 按真正发出去的字符计费：raw 塞得下、带前缀塞不下的文件被标成 budget 省略', () => {
    const small = normalizeFileDiff({ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' });
    const rawSize = small.diff.length + small.newPath.length;

    expect(diffPromptSize(small)).toBeGreaterThan(rawSize);
    expect(buildReviewContext({ files: [small], budgetCharacters: rawSize }).omittedFiles)
      .toEqual([{ path: 'src/a.ts', reason: 'budget' }]);
    expect(includedFiles(buildReviewContext({ files: [small], budgetCharacters: diffPromptSize(small) }))
      .map((item) => item.newPath)).toEqual(['src/a.ts']);
  });

  it('estimatedCharacters 记的是带行号之后的字符数', () => {
    const context = buildReviewContext({ files: [file], budgetCharacters: 100_000 });
    expect(context.estimatedCharacters).toBe(diffPromptSize(file));
  });

  it('评审分组与上下文预算同一口径', () => {
    expect(fileCharSize(file)).toBe(diffPromptSize(file));
    expect(fileCharSize(file)).toBeGreaterThan(file.diff.length + file.newPath.length);
  });

  it('多 hunk 大文件的前缀占比可控：默认预算下不会因为多了行号被裁，真超预算时仍然整文件裁掉', () => {
    const big = normalizeFileDiff({ old_path: 'src/big.ts', new_path: 'src/big.ts', diff: manyHunks(40, 15) });
    const overhead = diffPromptSize(big) / (big.diff.length + big.newPath.length) - 1;

    expect(overhead).toBeGreaterThan(0);
    expect(overhead).toBeLessThan(0.25);
    expect(includedFiles(buildReviewContext({ files: [big] })).map((item) => item.newPath)).toEqual(['src/big.ts']);
    expect(diffContext([big])).not.toContain('context budget exceeded');

    const tight = buildReviewContext({ files: [big], budgetCharacters: big.diff.length + big.newPath.length });
    expect(tight.omittedFiles).toEqual([{ path: 'src/big.ts', reason: 'budget' }]);
  });
});

describe('reviewSystemPrompt：说明新的带行号格式', () => {
  it('讲清三种前缀各自的侧别，并要求直接引用行首数字', () => {
    const prompt = reviewSystemPrompt('zh-CN', '优先精确率。');

    expect(prompt).toContain('前缀 L数字');
    expect(prompt).toContain('+L23 = 新增行在 new 侧的第 23 行（side 填 new）');
    expect(prompt).toContain('-L17 = 删除行在 old 侧的第 17 行（side 填 old）');
    expect(prompt).toContain('不要自己从 @@ 头往下推算');
    expect(prompt).toContain('不要带 L 行号前缀');
  });

  it('既有的「可锚定行」要求原样保留', () => {
    const prompt = reviewSystemPrompt('zh-CN', '优先精确率。');
    expect(prompt).toContain('完整文件段标题里标了「可锚定行」的区间');
    expect(prompt).toContain('line 必须落在其中');
    expect(prompt).toContain('优先精确率。');
    expect(reviewSystemPrompt('en-US', 'prefer precision')).toContain('Write findings in English');
  });
});

const settings = {
  provider: 'openai' as const,
  modelBaseUrl: 'https://model.test/v1',
  apiKey: 'key',
  model: 'model',
  gitlabToken: '',
  effort: 'balanced' as const,
  language: 'zh-CN' as const,
  mcp: { enabled: false, serverUrl: '' },
  auth: { mode: 'bearer' as const, customHeaders: {}, apiKeyHeader: 'Authorization', apiKeyQueryParam: 'key' },
  includeMrDescription: true,
  includeMrCommits: true,
};

function jsonResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('发给模型的 review 请求', () => {
  it('user message 里再没有不带行号的 diff 行', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse('{"findings":[]}'));
    vi.stubGlobal('fetch', fetcher);

    await new OpenAIRuntime(settings).review([file], undefined, 'zh-CN');

    const body = JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body)) as {
      messages: { role: string; content: string }[];
    };
    const user = body.messages.find((message) => message.role === 'user')!.content;
    const rows = user.split('\n');

    expect(rows.filter((row) => /^[-+ ]L\d+/.test(row))).toHaveLength(file.lines.length);
    expect(rows.filter((row) => /^[-+ ][^L]|^[-+]$/.test(row))).toEqual([]);
    expect(user).toContain(NUMBERED_DIFF_LEGEND);
    expect(body.messages.find((message) => message.role === 'system')!.content).toContain('前缀 L数字');
  });
});

describe('模型照抄行号前缀也能锚上', () => {
  it('existingCode 带着 +L14 前缀，行号又写错时靠内容重定位回真正的行', () => {
    const position = resolvePublishPosition(
      finding({ line: 99, endLine: 99, existingCode: '+L14   customProperties?: Map<string, string>;' }),
      [file],
    );

    expect(position.publishable).toBe(true);
    expect(position.finding).toMatchObject({ line: 14, endLine: 14, side: 'new' });
    expect(position.lines?.start).toEqual({ newLine: 14 });
  });

  it('上下文行与删除行的前缀（ L41 / -L42）同样剥得掉', () => {
    // 上下文行两侧同号、删除行与新增行内容相同：光有片段判不出侧别，靠模型抄对的行号定案
    const context = anchorFindings(
      [finding({ line: 41, endLine: 41, existingCode: ' L41   const element = new Map();' })], [file]);
    expect(context[0]).toMatchObject({ line: 41, endLine: 41, side: 'new' });

    const removed = anchorFindings(
      [finding({ line: 42, endLine: 42, side: 'old', existingCode: '-L42   return element;' })], [file]);
    expect(removed[0]).toMatchObject({ line: 42, endLine: 42, side: 'old' });
  });

  it('多行片段混着前缀也能整段锚定', () => {
    const anchored = anchorFindings([finding({
      existingCode: '+L14   customProperties?: Map<string, string>;\n+L15   extra?: number;',
    })], [file]);

    expect(anchored[0]).toMatchObject({ line: 14, endLine: 15, side: 'new' });
    expect(anchored[0].anchor).toMatchObject({ source: 'diff', publishable: true });
  });

  it('完整文件上下文的「42: code」写法照旧能剥（旧 case 不回归）', () => {
    const anchored = anchorFindings([finding({ existingCode: '14:   customProperties?: Map<string, string>;' })], [file]);
    expect(anchored[0]).toMatchObject({ line: 14, endLine: 14, side: 'new' });
  });
});

describe('新格式下的解析 → 锚定 → 发布链路', () => {
  it('模型直接引用 prompt 里行首的数字，位置就能挂上行内评论', () => {
    const prompt = diffContext([file]);
    const row = prompt.split('\n').find((line) => line.includes('customProperties?: Map<string, string>;'))!;
    const lineInPrompt = Number(/^\+L(\d+)/.exec(row)![1]);
    const existingCode = row.replace(/^\+L\d+\s/, '');
    expect(existingCode).toBe('  customProperties?: Map<string, string>;');

    const [parsed] = parseModelFindings(JSON.stringify({
      findings: [{
        path: PATH, line: lineInPrompt, endLine: lineInPrompt, side: 'new',
        category: 'bug', severity: 'high', confidence: 'high',
        title: '新增字段没有默认值保护', content: '序列化时 customProperties 可能是 undefined。',
        existingCode, evidence: [{ path: PATH, lines: `L${lineInPrompt}`, quote: existingCode.trim() }],
        comment: 'c',
      }],
    }), [file]);

    expect(parsed).toMatchObject({ path: PATH, line: 14, side: 'new' });
    const [anchored] = anchorFindings([parsed], [file]);
    expect(anchored.anchor).toMatchObject({ source: 'diff', publishable: true });

    const position = resolvePublishPosition(anchored, [file]);
    expect(position.publishable).toBe(true);
    expect(position.corrected).toBeUndefined();
    expect(position.lines).toEqual({ start: { newLine: 14 }, end: { newLine: 14 } });
  });

  it('模型把删除行的 old 侧行号抄对时，发布位置落在 old 侧', () => {
    const row = diffContext([file]).split('\n').find((line) => line.includes('return element;') && line.startsWith('-'))!;
    const lineInPrompt = Number(/^-L(\d+)/.exec(row)![1]);

    const [parsed] = normalizeFindings([{
      path: PATH, line: lineInPrompt, endLine: lineInPrompt, side: 'old',
      category: 'bug', severity: 'high', confidence: 'high',
      title: '删掉了返回值', content: '原来的 return 语句被替换，调用方拿到 undefined。',
      existingCode: row.replace(/^-L\d+\s/, ''), comment: 'c',
    }], [file]);

    expect(parsed).toMatchObject({ line: 42, side: 'old' });
    const position = resolvePublishPosition(anchorFindings([parsed], [file])[0], [file]);
    expect(position.publishable).toBe(true);
    expect(position.lines?.start).toEqual({ oldLine: 42 });
  });
});

describe('side 兜底不再伪造', () => {
  const oneSided: FileDiff = normalizeFileDiff({
    old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '@@ -1 +1,3 @@\n context\n+const x = 1;\n+return x;',
  });

  const sideOf = (input: Record<string, unknown>, files: FileDiff[] = [oneSided]) =>
    normalizeFindings([{ title: 't', content: 'c', ...input }], files)[0].side;

  it('行号两头都不在 diff 里时保持模型建议的侧别', () => {
    expect(sideOf({ path: 'src/a.ts', line: 99, side: 'new' })).toBe('new');
    expect(sideOf({ path: 'src/a.ts', line: 99, side: 'old' })).toBe('old');
  });

  it('模型没给 side 时仍按既有的 new 默认值，不因为兜底改动而漂移', () => {
    expect(sideOf({ path: 'src/a.ts', line: 99 })).toBe('new');
  });

  it('行号只命中 new 侧时仍然改判 new（既有纠错不回归）', () => {
    expect(sideOf({ path: 'src/a.ts', line: 3, side: 'old' })).toBe('new');
  });

  it('行号命中建议侧时按建议侧', () => {
    expect(sideOf({ path: 'src/a.ts', line: 1, side: 'old' })).toBe('old');
    expect(sideOf({ path: 'src/a.ts', line: 2, side: 'new' })).toBe('new');
  });

  it('侧别保持建议值不影响降级链：行号锚不上时照样按内容重定位', () => {
    const position = resolvePublishPosition(
      finding({ path: 'src/a.ts', line: 99, endLine: 99, side: 'new', existingCode: 'const x = 1;' }),
      [oneSided],
    );

    expect(position.publishable).toBe(true);
    expect(position.finding).toMatchObject({ line: 2, side: 'new' });
  });
});
