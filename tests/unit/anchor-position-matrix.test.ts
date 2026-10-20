import { describe, expect, it } from 'vitest';
import { resolvePublishPosition } from '../../src/core/anchor';
import { normalizeFileDiff } from '../../src/core/diff';
import { buildDiscussionPayload } from '../../src/core/gitlab-adapter';
import { inlineFallbackCause } from '../../src/core/inline-fallback';
import { toDiscussionPosition } from '../../src/core/reanchor';
import type { DiscussionPosition, FileDiff, Finding } from '../../src/core/types';

/**
 * anchor → GitLab position 的逐形态覆盖。
 *
 * 400 的根因是 position 里带了「不是当前 diff 真实行」的东西：模型报的行号、自己凑的
 * (old_line, new_line) 配对、或跟行号不同源的 sha。GitLab 一律只回一句
 * `line_code can't be blank`，从报错看不出是哪一样错了，所以这里逐形态把真实 diff 行、
 * 重新锚定的结果与最终 payload 一起钉死。
 */

const REFS = { baseSha: 'base-sha', headSha: 'head-sha', startSha: 'start-sha' };

const finding = (input: Partial<Finding> = {}): Finding => ({
  id: `f-${Math.random().toString(36).slice(2)}`, fingerprint: 'fp', path: 'src/pricing.ts',
  line: 0, endLine: 0, side: 'new', category: 'bug', severity: 'medium', confidence: 'medium',
  title: 'Title', content: 'Content', evidence: [], existingCode: '', suggestionCode: '',
  comment: 'Comment', source: 'model', status: 'draft', ...input,
});

/**
 * 普通修改：一行删除换成两行新增，上下文行两侧号码错开（old 20 = new 21）。
 * old 侧行号 18 19 20 21 22；new 侧行号 18 19 20 21 22 23。
 */
const modified: FileDiff = normalizeFileDiff({
  old_path: 'src/pricing.ts', new_path: 'src/pricing.ts',
  diff: [
    '@@ -18,5 +18,6 @@ export function price(input: Input) {',
    '   const quantity = clamp(input.quantity);',
    '-  const fee = 0.1;',
    '+  const fee = lookupFee(input.region);',
    '+  const surcharge = lookupSurcharge(input.region);',
    '   const subtotal = quantity * fee;',
    '   return { subtotal };',
  ].join('\n'),
});

/** 重命名 + 内容变更：old_path 与 new_path 不同，GitLab 两个都要真实路径。 */
const renamed: FileDiff = normalizeFileDiff({
  old_path: 'packages/legacy/rate.ts', new_path: 'packages/pricing/rate.ts', renamed_file: true,
  diff: [
    '@@ -3,3 +3,4 @@',
    ' export const RATE = 1;',
    '-export const LEGACY = true;',
    '+export const LEGACY = false;',
    '+export const AUDIT = true;',
    ' // trailing',
  ].join('\n'),
});

/** 同一段代码在同一侧出现两次：分不清是哪一处，只能降级。 */
const duplicated: FileDiff = normalizeFileDiff({
  old_path: 'src/dup.ts', new_path: 'src/dup.ts',
  diff: [
    '@@ -5,3 +5,4 @@',
    '   before();',
    '+  logger.info("hit");',
    '   middle();',
    '   after();',
    '@@ -40,3 +41,4 @@',
    '   head();',
    '+  logger.info("hit");',
    '   tail();',
    '   end();',
  ].join('\n'),
});

const twin: FileDiff = normalizeFileDiff({
  old_path: 'src/twin.ts', new_path: 'src/twin.ts',
  diff: '@@ -1,1 +1,2 @@\n head\n+  logger.info("hit");',
});

/**
 * 真实发出的 JSON body 展平成 position[a][b] 视图：键名与 GitLab position.json 逐字一致，
 * 断言口径不随编码方式变（0.4.24 起 discussions 端点发 JSON，不再是 form 平铺字段）。
 */
function flatten(value: unknown, prefix: string): [string, string][] {
  if (value === null || typeof value !== 'object') return [[prefix, String(value)]];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .flatMap(([key, item]) => flatten(item, `${prefix}[${key}]`));
}

/** 锚定结果 → 真实发出去的 payload；不可发布时 position 必须是 undefined（连请求都不该发）。 */
function payloadOf(input: Partial<Finding>, files: FileDiff[]) {
  const publish = resolvePublishPosition(finding(input), files);
  const position = toDiscussionPosition(publish, REFS);
  const payload = position ? buildDiscussionPayload({ body: 'b', position }) : undefined;
  return {
    publish,
    position,
    payload,
    sent: payload ? JSON.parse(payload) as { body: string; position?: Record<string, unknown> } : undefined,
    params: payload
      ? Object.fromEntries(flatten((JSON.parse(payload) as { position?: unknown }).position, 'position'))
      : undefined,
  };
}

/** line_code 的行号尾巴逐字对齐，哈希部分只校验形态（哈希值由容器里的 SHA1 决定）。 */
const lineCode = (tail: string) => expect.stringMatching(new RegExp(`^[0-9a-f]{40}_${tail}$`));

/**
 * line_range 的起止端点只有 line_code + type 两个键：old_line / new_line 在 GitLab 16/17 上类型对撞
 * （gitlab#572121，参数层 String、position.json 是 integer|null），传整数或字符串都会 400，所以一律不发。
 */
function expectLineRangeKeys(params: Record<string, string> | undefined) {
  for (const endpoint of ['start', 'end']) {
    const keys = Object.keys(params!)
      .filter((key) => key.startsWith(`position[line_range][${endpoint}][`))
      .sort();
    expect(keys, `${endpoint} 端点只该发 line_code + type`).toEqual([
      `position[line_range][${endpoint}][line_code]`,
      `position[line_range][${endpoint}][type]`,
    ]);
  }
}

const expectNoPosition = (publish: { publishable: boolean }, position?: DiscussionPosition) => {
  expect(publish.publishable).toBe(false);
  expect(position).toBeUndefined();
};

describe('position 逐形态：三类 diff 行各自的行号配对', () => {
  it('added 行只传 new_line，绝不带 old_line', () => {
    const { publish, params } = payloadOf({
      line: 19, endLine: 19, side: 'new', existingCode: 'const fee = lookupFee(input.region);',
    }, [modified]);

    expect(publish.publishable).toBe(true);
    expect(publish.lines).toEqual({ start: { newLine: 19 }, end: { newLine: 19 } });
    expect(params).toMatchObject({ 'position[new_line]': '19' });
    expect(params!['position[old_line]']).toBeUndefined();
    // 单行评论压根没有 line_range：端点键（含行号键）自然一个都不存在
    expect(params!['position[line_range][start][line_code]']).toBeUndefined();
    expect(params!['position[line_range][start][new_line]']).toBeUndefined();
  });

  it('deleted 行只传 old_line，模型把 side 写成 new 也一样落在 old 侧', () => {
    for (const side of ['old', 'new'] as const) {
      const { publish, params } = payloadOf({
        line: 19, endLine: 19, side, existingCode: 'const fee = 0.1;',
      }, [modified]);

      expect(publish.finding).toMatchObject({ line: 19, endLine: 19, side: 'old' });
      expect(publish.lines).toEqual({ start: { oldLine: 19 }, end: { oldLine: 19 } });
      expect(params).toMatchObject({ 'position[old_line]': '19' });
      expect(params!['position[new_line]']).toBeUndefined();
    }
  });

  it('context 行同时传 old_line 与 new_line，两个号都取自真实 diff 行', () => {
    const { publish, params } = payloadOf({
      line: 21, endLine: 21, side: 'new', existingCode: 'const subtotal = quantity * fee;',
    }, [modified]);

    // 这一行在 old 侧是第 20 行、new 侧是第 21 行：只填一侧 GitLab 就 400
    expect(publish.lines).toEqual({ start: { oldLine: 20, newLine: 21 }, end: { oldLine: 20, newLine: 21 } });
    expect(params).toMatchObject({ 'position[old_line]': '20', 'position[new_line]': '21' });
  });

  it('删除文件里的行同样只按 old 侧发', () => {
    const deleted = normalizeFileDiff({
      old_path: 'src/gone.ts', new_path: 'src/gone.ts', deleted_file: true,
      diff: '@@ -7,2 +6,0 @@\n-export const GONE = 1;\n-export const ALSO_GONE = 2;',
    });
    const { publish, params } = payloadOf({
      path: 'src/gone.ts', line: 8, endLine: 8, side: 'new', existingCode: 'export const ALSO_GONE = 2;',
    }, [deleted]);

    expect(publish.finding).toMatchObject({ side: 'old', line: 8 });
    expect(publish.lines).toEqual({ start: { oldLine: 8 }, end: { oldLine: 8 } });
    expect(params).toMatchObject({ 'position[old_line]': '8' });
    expect(params!['position[new_line]']).toBeUndefined();
  });
});

describe('发出去的整条 body：JSON，不是 form 平铺字段', () => {
  it('body 可被 JSON.parse，position 是嵌套对象、行号是整数', () => {
    const { payload, sent } = payloadOf({
      line: 19, endLine: 21, existingCode: [
        'const fee = lookupFee(input.region);',
        'const surcharge = lookupSurcharge(input.region);',
        'const subtotal = quantity * fee;',
      ].join('\n'),
    }, [modified]);

    expect(payload).not.toContain('position%5B');
    expect(payload).not.toContain('position[');
    expect(sent!.body).toBe('b');
    const range = sent!.position!.line_range as { start: Record<string, unknown>; end: Record<string, unknown> };
    expect(typeof sent!.position!.new_line).toBe('number');
    expect(range.start).toEqual({ type: 'new', line_code: lineCode('0_19') });
    expect(range.end).toEqual({ type: 'old', line_code: lineCode('20_21') });
    // 多行时 line_range 两端只有 line_code + type，单行时顶层仍只发真实侧
    expect(Object.keys(range.start).sort()).toEqual(['line_code', 'type']);
    expect(Object.keys(range.end).sort()).toEqual(['line_code', 'type']);
  });

  it('不可发布时压根没有 body：连请求都不该发出去', () => {
    const { payload, params } = payloadOf({ line: 19, endLine: 19, existingCode: 'const nope = 1;' }, [modified]);
    expect(payload).toBeUndefined();
    expect(params).toBeUndefined();
  });
});

describe('position 逐形态：rename 与 path 前缀', () => {
  it('rename：old_path / new_path 各写各的真实路径，Finding 只带旧路径也对得上', () => {
    const { publish, params } = payloadOf({
      path: 'packages/legacy/rate.ts', line: 5, endLine: 5, side: 'new',
      existingCode: 'export const AUDIT = true;',
    }, [renamed]);

    expect(publish.finding).toMatchObject({
      path: 'packages/pricing/rate.ts', oldPath: 'packages/legacy/rate.ts', newPath: 'packages/pricing/rate.ts',
    });
    expect(params).toMatchObject({
      'position[old_path]': 'packages/legacy/rate.ts',
      'position[new_path]': 'packages/pricing/rate.ts',
      'position[new_line]': '5',
    });
  });

  it('只重命名没有内容变更的文件给准确原因，不报「找不到第 N 行」', () => {
    const pureRename = normalizeFileDiff({
      old_path: 'a/old.ts', new_path: 'a/new.ts', renamed_file: true, diff: '',
    });
    const { publish, params, position } = payloadOf({
      path: 'a/new.ts', line: 1, endLine: 1, existingCode: 'whatever();',
    }, [pureRename]);

    expectNoPosition(publish, position);
    expect(publish.reasonCode).toBe('diff-collapsed');
    expect(publish.reason).toContain('只是重命名');
    expect(params).toBeUndefined();
  });

  it('path 前缀：a/ b/ 前缀、子目录相对路径、大小写漂移都还原成 diff 里的真实路径', () => {
    for (const path of ['b/src/pricing.ts', 'a/src/pricing.ts', 'pricing.ts', 'src/PRICING.ts', './src//pricing.ts']) {
      const { publish, params } = payloadOf({
        path, line: 19, endLine: 19, existingCode: 'const surcharge = lookupSurcharge(input.region);',
      }, [modified]);

      expect(publish.finding.path, path).toBe('src/pricing.ts');
      expect(params!['position[new_path]'], path).toBe('src/pricing.ts');
      expect(params!['position[old_path]'], path).toBe('src/pricing.ts');
    }
  });

  it('path 前缀不会漏进 payload：GitLab 把 a/ b/ 当路径过滤条件，那样一律 400', () => {
    const { params, payload } = payloadOf({
      path: 'b/src/pricing.ts', line: 19, endLine: 19, existingCode: 'const fee = lookupFee(input.region);',
    }, [modified]);
    for (const value of Object.values(params!)) expect(value).not.toMatch(/^[ab]\//);
    expect(payload).not.toContain('"a/');
    expect(payload).not.toContain('"b/');
  });
});

describe('position 逐形态：模型行号只作提示', () => {
  it('行号整体偏移也按内容锚回真实行，位置用的是 diff 里的行号', () => {
    const { publish, params } = payloadOf({
      line: 25, endLine: 25, existingCode: 'const surcharge = lookupSurcharge(input.region);',
    }, [modified]);

    expect(publish).toMatchObject({ publishable: true, corrected: true });
    expect(publish.finding).toMatchObject({ line: 20, endLine: 20, side: 'new' });
    expect(params).toMatchObject({ 'position[new_line]': '20' });
  });

  it('行号离谱到 diff 之外也照样锚回来，不因为行号不可用就降级', () => {
    const { publish } = payloadOf({
      line: 999, endLine: 999, existingCode: 'const quantity = clamp(input.quantity);',
    }, [modified]);
    expect(publish.finding).toMatchObject({ line: 18, endLine: 18, side: 'new' });
    expect(publish.lines).toEqual({ start: { oldLine: 18, newLine: 18 }, end: { oldLine: 18, newLine: 18 } });
  });

  it('模型抄了 diff 行首的 L 行号前缀也剥得掉，仍按内容锚定', () => {
    const { publish } = payloadOf({
      line: 0, endLine: 0, existingCode: '+L20   const surcharge = lookupSurcharge(input.region);',
    }, [modified]);
    expect(publish.finding).toMatchObject({ line: 20, endLine: 20, side: 'new' });
  });

  it('范围起点与提示行号一致时才按提示补足长度，补出来的仍是连续的真实 diff 行', () => {
    const { publish, params } = payloadOf({
      line: 19, endLine: 21, existingCode: 'const fee = lookupFee(input.region);',
    }, [modified]);

    expect(publish.finding).toMatchObject({ line: 19, endLine: 21 });
    expect(publish.lines).toEqual({ start: { newLine: 19 }, end: { oldLine: 20, newLine: 21 } });
    expect(params).toMatchObject({
      'position[new_line]': '21', 'position[old_line]': '20',
      'position[line_range][start][line_code]': lineCode('0_19'), 'position[line_range][start][type]': 'new',
      'position[line_range][end][line_code]': lineCode('20_21'), 'position[line_range][end][type]': 'old',
    });
    expectLineRangeKeys(params);
  });

  it('提示行号与命中位置不一致时不拿它凑 end：只覆盖真正匹配上的那一行', () => {
    const { publish } = payloadOf({
      line: 99, endLine: 101, existingCode: 'const fee = lookupFee(input.region);',
    }, [modified]);
    expect(publish.finding).toMatchObject({ line: 19, endLine: 19 });
    expect(publish.lines).toEqual({ start: { newLine: 19 }, end: { newLine: 19 } });
  });
});

describe('position 逐形态：多行评论', () => {
  it('跨 context + added 的多行范围，起止各自把真实 diff 行的配对编进 line_code', () => {
    const { publish, params } = payloadOf({
      line: 18, endLine: 20,
      existingCode: [
        'const quantity = clamp(input.quantity);',
        'const fee = lookupFee(input.region);',
        'const surcharge = lookupSurcharge(input.region);',
      ].join('\n'),
    }, [modified]);

    expect(publish.finding).toMatchObject({ line: 18, endLine: 20, side: 'new' });
    expect(publish.lines).toEqual({
      start: { oldLine: 18, newLine: 18 },
      end: { newLine: 20 },
    });
    // 顶层 old_line / new_line 描述的是结束行；line_range 的起止只发 line_code + type
    expect(params).toMatchObject({
      'position[new_line]': '20',
      'position[line_range][start][line_code]': lineCode('18_18'), 'position[line_range][start][type]': 'old',
      // end 是 added 行：缺的 old 侧按 0 编进 line_code（数字进字符串，碰不到 gitlab#572121 的类型对撞）
      'position[line_range][end][line_code]': lineCode('0_20'), 'position[line_range][end][type]': 'new',
    });
    expectLineRangeKeys(params);
    // 顶层单侧照旧：added 行的 old_line 压根不发（GitLab 拿它精确比对 diff 行，补 0 就匹配不到）
    expect(params!['position[old_line]']).toBeUndefined();
  });

  it('跨 removed + context 的多行范围落在 old 侧，结束行的两个号都带上', () => {
    const { publish, params } = payloadOf({
      line: 19, endLine: 20, side: 'old',
      existingCode: 'const fee = 0.1;\nconst subtotal = quantity * fee;',
    }, [modified]);

    expect(publish.finding).toMatchObject({ line: 19, endLine: 20, side: 'old' });
    expect(publish.lines).toEqual({ start: { oldLine: 19 }, end: { oldLine: 20, newLine: 21 } });
    expect(params).toMatchObject({
      'position[old_line]': '20', 'position[new_line]': '21',
      'position[line_range][start][line_code]': lineCode('19_0'), 'position[line_range][start][type]': 'old',
      'position[line_range][end][line_code]': lineCode('20_21'), 'position[line_range][end][type]': 'old',
    });
    expectLineRangeKeys(params);
  });

  it('片段里带着 diff 真实存在的空行时整段锚定，范围一直覆盖到第 5 行', () => {
    const gapped = normalizeFileDiff({
      old_path: 'src/g.ts', new_path: 'src/g.ts',
      diff: '@@ -1,1 +1,5 @@\n top\n+function pay() {\n+\n+  return 1;\n+}',
    });
    const { publish, params } = payloadOf({
      path: 'src/g.ts', line: 2, endLine: 5, existingCode: 'function pay() {\n\n  return 1;\n}',
    }, [gapped]);
    expect(publish.finding).toMatchObject({ line: 2, endLine: 5 });
    expect(publish.lines).toEqual({ start: { newLine: 2 }, end: { newLine: 5 } });
    expect(params).toMatchObject({
      'position[new_line]': '5',
      'position[line_range][start][line_code]': lineCode('0_2'), 'position[line_range][start][type]': 'new',
      'position[line_range][end][line_code]': lineCode('0_5'), 'position[line_range][end][type]': 'new',
    });
    expectLineRangeKeys(params);
    expect(params!['position[old_line]']).toBeUndefined();
  });

  it('模型多带的首尾空行剪掉后仍能锚定，范围按真正匹配上的行算', () => {
    const gapped = normalizeFileDiff({
      old_path: 'src/g.ts', new_path: 'src/g.ts',
      diff: '@@ -1,1 +1,5 @@\n top\n+function pay() {\n+\n+  return 1;\n+}',
    });
    const { publish } = payloadOf({
      path: 'src/g.ts', line: 4, endLine: 5, existingCode: '\nreturn 1;\n}\n',
    }, [gapped]);
    expect(publish.finding).toMatchObject({ line: 4, endLine: 5 });
    expect(publish.lines).toEqual({ start: { newLine: 4 }, end: { newLine: 5 } });
  });
});

describe('重新锚定失败一律降级为全文评论，不猜行号', () => {
  it('无匹配：片段在当前 diff 里找不到', () => {
    const { publish, position, params } = payloadOf({
      line: 19, endLine: 19, existingCode: 'const fee = calculateFee(input);',
    }, [modified]);

    expectNoPosition(publish, position);
    expect(publish.reasonCode).toBe('reanchor-no-match');
    expect(publish.reason).toContain('重新锚定失败：无匹配');
    expect(params).toBeUndefined();
  });

  it('无匹配：行号在 diff 里真实存在，但那一行是别的代码', () => {
    const { publish, position } = payloadOf({
      line: 19, endLine: 19, existingCode: 'const totally = different();',
    }, [modified]);
    expectNoPosition(publish, position);
    expect(publish.reasonCode).toBe('reanchor-no-match');
  });

  it('无匹配：没有可比对的代码片段时不拿模型行号硬发', () => {
    const { publish, position } = payloadOf({ line: 19, endLine: 19, existingCode: '' }, [modified]);
    expectNoPosition(publish, position);
    expect(publish.reasonCode).toBe('reanchor-no-match');
    expect(publish.reason).toContain('没有可比对的代码片段');
  });

  it('多候选：同一段代码在同一侧出现两次，说清命中了几处、分别在哪', () => {
    const { publish, position, params } = payloadOf({
      path: 'src/dup.ts', line: 6, endLine: 6, existingCode: 'logger.info("hit");',
    }, [duplicated]);

    expectNoPosition(publish, position);
    expect(publish.reasonCode).toBe('reanchor-ambiguous');
    expect(publish.reason).toContain('重新锚定失败：多候选');
    expect(publish.reason).toContain('命中 2 处');
    expect(publish.reason).toContain('第 6 行、第 42 行');
    expect(params).toBeUndefined();
  });

  it('多候选：跨文件也分不清时同样降级，不挑第一个命中的文件', () => {
    const { publish, position } = payloadOf({
      path: 'src/ghost.ts', line: 6, endLine: 6, existingCode: 'logger.info("hit");',
    }, [duplicated, twin]);
    expectNoPosition(publish, position);
    expect(publish.reasonCode).toBe('reanchor-ambiguous');
  });

  it('降级走既有的 [inline-fallback] 现场：cause=position-blocked，reasonCode 原样带出', () => {
    const publish = resolvePublishPosition(
      finding({ path: 'src/dup.ts', line: 6, endLine: 6, existingCode: 'logger.info("hit");' }), [duplicated]);
    expect(inlineFallbackCause({ finding: publish.finding, position: publish })).toMatchObject({
      cause: 'position-blocked',
      reasonCode: 'reanchor-ambiguous',
    });
    expect(inlineFallbackCause({ finding: publish.finding, position: publish })!.reason)
      .toContain('重新锚定失败：多候选');
  });
});
