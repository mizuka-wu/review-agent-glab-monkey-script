/**
 * 发布行内评论时把「真实发出的那一条 HTTP 请求」整条打进日志。
 *
 * 用户老实例上 0.4.24（JSON 直发）仍然 400。[inline-fallback] 给的是脚本侧的 position 参数与
 * 服务端原话，中间那一段——实际 URL、实际 headers、实际 body 字节——之前只能靠推断，而推断已经
 * 推断过两轮（补 line_range 四键、改 JSON 直发）都没命中，真根因后来才定位到：line_range 的行号键
 * 在 GitLab 16/17 上类型对撞（gitlab#572121），发整数还是字符串都 400，只能不发。
 * 这里在传输层出口把请求现场原样落地：
 * console + 调试面板 + 导出包各一份，并附一条可直接粘贴重放的 curl，用户在自己实例上跑一遍就能
 * 分清是脚本拼错了 payload、还是那台 GitLab 的校验口径更严。
 *
 * body 原文不截断（行内请求就几百字节，position / line_range / sha 全在里面，截了就白打）——这意味着
 * 评论正文也会一并落日志，与调试面板里本来就存的完整提示词 / 代码同级，用户导出前自己过一眼即可；
 * 所有输出都过 sanitizeLog，PRIVATE-TOKEN 只留首尾 4 位与长度，CSRF / Authorization 全抹，PAT 永不落日志。
 */

import { sanitizeLog } from './capabilities';
import { debugBus } from './debug-bus';

/** 每一行都带这个前缀：与 [inline-fallback] 各自独立，grep '[inline-request]' 只看请求现场。 */
export const PUBLISH_REQUEST_PREFIX = '[inline-request]';

/** curl 里的令牌占位符：真 PAT 不进日志，用户重放前自己替换。 */
export const CURL_TOKEN_PLACEHOLDER = '<PAT>';

/** 只打发布链路的写请求：discussions（行内 / 全文）、discussion 内回复、notes（MR 总评论）。 */
const PUBLISH_PATH = /\/merge_requests\/\d+\/(?:discussions(?:\/[^/]+\/notes)?|notes)$/;

/** 响应 body 的上限：GitLab 的 400 就一句话，但网关 502 会甩一整页 HTML 进 localStorage。 */
const RESPONSE_CAP = 4000;

export function isPublishRequest(method: string, path: string): boolean {
  return method === 'POST' && PUBLISH_PATH.test(path.split('?')[0]);
}

/** 一次发布请求的完整现场，由传输层（GitLabAdapter#request）在出口处提供。 */
export interface PublishRequestScene {
  method: string;
  /** origin + path，与真实发出的那一条完全一致。 */
  url: string;
  /** 真实发出的 headers（含 PRIVATE-TOKEN 原值，格式化时才脱敏）。 */
  headers: Record<string, string>;
  /** 请求 body 原文：JSON 字符串，或 form 端点序列化后的字符串。 */
  body?: string;
  /** 传输层就失败（连不上 / 被拦）时没有 status。 */
  status?: number;
  /** 失败时的响应 body 原文；成功只记 status。 */
  responseText?: string;
  ok: boolean;
  ms: number;
  error?: string;
}

function pickHeader(headers: Record<string, string>, name: string) {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

/**
 * 令牌类 header 的脱敏口径：够用户确认「这次用的是哪个 PAT / 有没有带」，又拼不回原值。
 * 短令牌整个抹掉——首尾 4 位对 8 字符的令牌等于全盘托出。
 */
export function redactHeaderValue(name: string, value: string): string {
  if (/^(x-csrf-token|authorization|proxy-authorization)$/i.test(name)) return `[REDACTED ${value.length} 字符]`;
  if (/^private-token$/i.test(name)) {
    return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}（${value.length} 字符）` : '[REDACTED]';
  }
  return value;
}

export function formatRequestHeaders(headers: Record<string, string>): string {
  // 空值也打出来：X-CSRF-Token 为空、PRIVATE-TOKEN 压根不存在，本身就是「为什么 401 / 403」的答案。
  const parts = Object.entries(headers)
    .map(([name, value]) => `${name}=${value === '' ? '（空）' : redactHeaderValue(name, value)}`);
  return parts.length > 0 ? parts.join(' · ') : '（无）';
}

/** body 里有没有 position：一段日志里行内尝试与全文降级各发一条 POST，得一眼分得清。 */
export function payloadKind(body?: string): 'inline' | 'full' | 'empty' | 'raw' {
  if (!body) return 'empty';
  try {
    return (JSON.parse(body) as { position?: unknown }).position === undefined ? 'full' : 'inline';
  } catch {
    return 'raw';
  }
}

/** 单引号安全转义：`a'b` → `'a'\''b'`，整条 curl 可以直接粘贴进 bash / zsh 执行。 */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * 同一现场拼出的 curl 重放命令（单行，替换 <PAT> 后可直接粘贴执行）。
 * 只带 Content-Type / Accept / PRIVATE-TOKEN：真实请求里的 CSRF 与 Cookie 对 PAT 重放没用，也不该外泄。
 */
export function buildCurlReplay(scene: PublishRequestScene): string {
  const parts = ['curl -sS -X', scene.method, shellQuote(scene.url)];
  const contentType = pickHeader(scene.headers, 'Content-Type');
  const accept = pickHeader(scene.headers, 'Accept');
  if (contentType) parts.push('-H', shellQuote(`Content-Type: ${contentType}`));
  if (accept) parts.push('-H', shellQuote(`Accept: ${accept}`));
  parts.push('-H', shellQuote(`PRIVATE-TOKEN: ${CURL_TOKEN_PLACEHOLDER}`));
  if (scene.body) parts.push('--data', shellQuote(scene.body));
  if (pickHeader(scene.headers, 'PRIVATE-TOKEN') === undefined) {
    parts.push('# 实际请求没带 PRIVATE-TOKEN（走浏览器 Cookie），重放前自己补认证');
  }
  return parts.join(' ');
}

function oneLine(text: string, cap = RESPONSE_CAP) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…（截断 ${flat.length - cap} 字符）` : flat;
}

/**
 * 响应 body 原文（失败时）：只压空白、不做别的加工——GitLab 那句 `Note {:line_code=>[...]}` 就是定位依据。
 * 网关甩过来的 502 HTML 会带一整页换行，压成一行才不破坏「每行一个前缀」的复制口径。
 */
function responseLine(scene: PublishRequestScene) {
  if (scene.ok) return `${PUBLISH_REQUEST_PREFIX} response: HTTP ${scene.status}`;
  if (scene.status === undefined) {
    return `${PUBLISH_REQUEST_PREFIX} response: 未收到响应 · ${oneLine(scene.error ?? 'unknown')}`;
  }
  return `${PUBLISH_REQUEST_PREFIX} response: HTTP ${scene.status} · ${oneLine(scene.responseText ?? scene.error ?? '')}`;
}

/**
 * 整段请求现场：每行一个维度、都带前缀，可以整段复制，也能只 grep body / curl 那一行。
 * body 与 curl 两行原样输出不压空白（JSON.stringify 本来就不产生裸换行，压了 curl 重放就不等价了），
 * 只在最后统一过一遍 sanitizeLog。
 */
export function formatPublishRequest(scene: PublishRequestScene): string[] {
  const outcome = scene.status === undefined ? '传输失败' : `HTTP ${scene.status}`;
  const lines = [
    `${PUBLISH_REQUEST_PREFIX} ${scene.method} ${scene.url} → ${outcome}${scene.ok ? '（成功）' : '（失败）'}`
      + ` · payload=${payloadKind(scene.body)} · ${scene.ms}ms`,
    `${PUBLISH_REQUEST_PREFIX} headers: ${formatRequestHeaders(scene.headers)}`,
    `${PUBLISH_REQUEST_PREFIX} body(${scene.body?.length ?? 0} 字符): ${scene.body ?? '（无 body）'}`,
    responseLine(scene),
    `${PUBLISH_REQUEST_PREFIX} curl（把 ${CURL_TOKEN_PLACEHOLDER} 换成你的 Token 后整行粘贴执行）: ${buildCurlReplay(scene)}`,
  ];
  return lines.map((line) => sanitizeLog(line));
}

/**
 * 发布请求出口的现场日志：失败必打（error 级），成功也打一条 debug 级——用户正在排查期，
 * 面板与 console 都看得到，嫌吵再收。返回格式化后的行，调用方不需要再算一遍。
 */
export function logPublishRequest(scene: PublishRequestScene): string[] {
  const lines = formatPublishRequest(scene);
  debugBus.logToConsole(scene.ok ? 'debug' : 'error', 'publish', lines[0], lines.slice(1).join('\n'));
  return lines;
}
