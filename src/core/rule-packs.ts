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

const WEB = ['ts', 'js'] as RuleLanguage[];
const JVM = ['java', 'kotlin', 'scala'] as RuleLanguage[];

const builtInRules: RuleDef[] = [
  {
    id: 'builtin-git-conflict-marker',
    enabled: true,
    severity: 'critical',
    category: 'bug',
    title: '提交中残留 Git 冲突标记',
    content: '合并冲突标记被直接提交，会导致文件无法编译或运行。请在合并前解决冲突并删除 <<<<<<< / ======= / >>>>>>> 标记。',
    matchPatterns: [{ type: 'regex', pattern: '^\\s*(?:<{7}\\s|>{7}\\s|={7}\\s*$)' }],
    skipComments: false,
  },
  {
    id: 'builtin-hardcoded-secret',
    enabled: true,
    severity: 'high',
    category: 'security',
    title: '代码中疑似硬编码敏感信息',
    content: '新增赋值涉及密码、Token 或 API Key。应从环境变量、安全配置或密钥管理服务读取，并确认该值没有进入日志、构建产物和 Git 历史；若已提交真实凭据请立即轮换。',
    matchPatterns: [{ type: 'regex', pattern: '\\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|private[_-]?key|client[_-]?secret)\\b\\s*[:=]\\s*["\'][^"\']{3,}', flags: 'i' }],
  },
  {
    id: 'builtin-credential-in-url',
    enabled: true,
    severity: 'high',
    category: 'security',
    title: 'URL 中内嵌账号密码',
    content: '形如 http://user:pass@host 的地址会把凭据写入代码、日志和浏览器历史。请改为在请求头或密钥管理服务中传递认证信息。',
    matchPatterns: [{ type: 'regex', pattern: '(?:https?|ftp|mysql|postgres(?:ql)?|redis|amqp|mongodb)://[^/\\s"\']+:[^@\\s"\']+@' }],
  },
  {
    id: 'builtin-sql-injection',
    enabled: true,
    severity: 'critical',
    category: 'security',
    title: 'SQL 语句由字符串拼接或插值构成',
    content: 'SQL 与外部输入直接拼接会造成注入风险。请改用参数化查询 / PreparedStatement / ORM 绑定参数，并确认排序字段、表名等无法参数化的部分走了白名单校验。',
    matchPatterns: [{
      type: 'regex',
      pattern: '\\b(?:select\\s.+?\\sfrom|insert\\s+into|update\\s+\\w+\\s+set|delete\\s+from)\\b[^;]{0,240}?(?:\\$\\{|"\\s*\\+|\'\\s*\\+|\\+\\s*"|\\+\\s*\'|\\.format\\s*\\(|%\\s*[(\\w]|f"|f\')',
      flags: 'i',
    }],
    languages: [...WEB, ...JVM, 'python', 'go', 'php', 'ruby', 'csharp', 'sql'],
  },
  {
    id: 'builtin-xss-sink',
    enabled: true,
    severity: 'high',
    category: 'security',
    title: '直接写入 HTML 造成 XSS 风险',
    content: 'innerHTML / dangerouslySetInnerHTML / v-html / document.write 会原样执行插入的标记。若内容来自用户或接口，请先做转义或使用受信的 sanitize 库，并确认没有绕过框架的自动转义。',
    matchPatterns: [{
      type: 'regex',
      pattern: '\\.(?:innerHTML|outerHTML)\\s*=[^=]|insertAdjacentHTML\\s*\\(|document\\.write(?:ln)?\\s*\\(|dangerouslySetInnerHTML|v-html\\s*=|\\$\\([^)]*\\)\\.html\\s*\\(',
    }],
    languages: [...WEB, 'html', 'php', 'ruby'],
  },
  {
    id: 'builtin-code-injection',
    enabled: true,
    severity: 'high',
    category: 'security',
    title: '动态执行代码或系统命令',
    content: 'eval / new Function / Runtime.exec / os.system / shell=True 会把字符串当作代码或命令执行。请改用显式分支、白名单命令或结构化参数（execFile、subprocess 列表参数）。',
    matchPatterns: [{
      type: 'regex',
      pattern: '\\beval\\s*\\(|new\\s+Function\\s*\\(|Runtime\\.getRuntime\\s*\\(\\s*\\)\\s*\\.\\s*exec|\\bProcessBuilder\\s*\\(|\\bos\\.system\\s*\\(|\\bos\\.popen\\s*\\(|shell\\s*=\\s*True|\\bexecSync\\s*\\(|\\bchild_process\\b',
    }],
    languages: [...WEB, ...JVM, 'python', 'go', 'php', 'ruby', 'csharp'],
  },
  {
    id: 'builtin-tls-verify-disabled',
    enabled: true,
    severity: 'high',
    category: 'security',
    title: '关闭了 TLS 证书或主机名校验',
    content: '跳过证书校验会让连接容易被中间人攻击。请配置正确的 CA 证书链；仅在受控的本地联调环境用开关临时关闭，并确保不会进入生产构建。',
    matchPatterns: [{
      type: 'regex',
      pattern: 'rejectUnauthorized\\s*:\\s*false|InsecureSkipVerify\\s*:\\s*true|NODE_TLS_REJECT_UNAUTHORIZED|verify\\s*=\\s*False|check_hostname\\s*=\\s*False|CURLOPT_SSL_VERIFY(?:PEER|HOST)[^;]{0,20}(?:0|false)|trustAllCerts|ALLOW_ALL_HOSTNAME_VERIFIER|new\\s+X509TrustManager|ssl\\s*=\\s*False',
    }],
  },
  {
    id: 'builtin-weak-hash',
    enabled: true,
    severity: 'medium',
    category: 'security',
    title: '使用了已不安全的哈希算法',
    content: 'MD5 / SHA-1 / DES / RC4 已被证明存在碰撞或密钥长度不足的问题。请改用 SHA-256 及以上；涉及口令存储时使用 bcrypt、scrypt 或 Argon2 等带盐的慢哈希。',
    matchPatterns: [{
      type: 'regex',
      pattern: '\\bmd5\\s*\\(|\\bsha1\\s*\\(|createHash\\s*\\(\\s*[\'"](?:md5|sha1)[\'"]|MessageDigest\\.getInstance\\s*\\(\\s*"(?:MD5|SHA-?1|DES)"|hashlib\\.(?:md5|sha1)\\s*\\(|\\bDESede?\\b|\\bRC[24]\\b',
      flags: 'i',
    }],
  },
  {
    id: 'builtin-insecure-random',
    enabled: true,
    severity: 'medium',
    category: 'security',
    title: '安全场景使用了可预测的随机数',
    content: 'Math.random / random.random 不是加密安全的伪随机数，用于 Token、验证码、盐值时可被预测。请改用 crypto.randomBytes、crypto.getRandomValues、secrets 或 java.security.SecureRandom。',
    matchPatterns: [{
      type: 'regex',
      pattern: '(?:token|secret|password|passwd|api[_-]?key|nonce|salt|session|otp|verify[_-]?code|captcha)[\\w.]{0,24}[^;\\n]{0,80}(?:Math\\.random|random\\.random)\\s*\\(|(?:Math\\.random|random\\.random)\\s*\\([^;\\n]{0,80}(?:token|secret|password|api[_-]?key|nonce|salt|session|otp|captcha)',
      flags: 'i',
    }],
    languages: [...WEB, 'python'],
  },
  {
    id: 'builtin-thread-unsafe-shared-state',
    enabled: true,
    severity: 'high',
    category: 'bug',
    title: '静态字段持有可变共享状态',
    content: 'SimpleDateFormat、Calendar、HashMap、ArrayList、StringBuilder 等类型不是线程安全的，放在 static 字段上会被多线程共享，导致解析错乱、数据丢失甚至死循环。请改为方法内局部变量、ThreadLocal，或使用 DateTimeFormatter、ConcurrentHashMap、CopyOnWriteArrayList 等并发安全实现。',
    matchPatterns: [{
      type: 'regex',
      pattern: '\\bstatic\\b[^=;(){}]{0,60}\\b(?:SimpleDateFormat|Calendar|HashMap|ArrayList|LinkedList|HashSet|TreeMap|TreeSet|StringBuilder|StringBuffer|Random)\\b',
    }],
    languages: JVM,
  },
  {
    id: 'builtin-java-equals-on-variable',
    enabled: true,
    severity: 'medium',
    category: 'bug',
    title: 'equals 的调用方可能为 null',
    content: '用变量调用 equals 传入字面量时，变量为 null 会抛 NullPointerException。请把字面量或已知非空的常量放在前面，例如 "ACTIVE".equals(status)，或改用 Objects.equals(a, b)。',
    matchPatterns: [{ type: 'regex', pattern: '(?:^|[^"\\w.])[a-z_]\\w*\\.equals\\s*\\(\\s*"' }],
    languages: ['java'],
  },
  {
    id: 'builtin-kotlin-notnull-assertion',
    enabled: true,
    severity: 'medium',
    category: 'bug',
    title: '使用 !! 强行断言非空',
    content: '!! 会把可空类型直接解包，一旦为 null 就抛出 NullPointerException，绕过编译期的空安全检查。请改用 ?.、?: 提供默认值，或 requireNotNull(value) { "原因" } 给出可读的失败信息。',
    matchPatterns: [{ type: 'regex', pattern: '[\\w)\\]]!!(?:[.\\[]|\\s*[;,)=]|\\s*$)' }],
    languages: ['kotlin'],
  },
  {
    id: 'builtin-ts-non-null-assertion',
    enabled: true,
    severity: 'low',
    category: 'bug',
    title: '使用 ! 断言绕过空值检查',
    content: '非空断言会让 TypeScript 跳过 undefined / null 检查，运行时仍可能抛错。请补充显式判空、可选链或收窄类型，只有在类型系统无法表达但业务上确实非空时才使用断言。',
    matchPatterns: [{ type: 'regex', pattern: '[\\w)\\]]!\\.|[\\w)\\]]!\\[' }],
    languages: ['ts'],
  },
  {
    id: 'builtin-weak-types',
    enabled: true,
    severity: 'medium',
    category: 'bug',
    title: '异常处理或类型边界被弱化',
    content: 'any、@ts-ignore、@ts-expect-error 或空 catch 会隐藏类型错误与失败路径。建议保留精确类型（unknown + 收窄），并在 catch 中记录日志或向上抛出。',
    matchPatterns: [{ type: 'regex', pattern: ':\\s*any\\b|<any>|as\\s+any\\b|@ts-(?:ignore|expect-error|nocheck)|catch\\s*(?:\\([^)]*\\))?\\s*\\{\\s*\\}' }],
    languages: WEB,
  },
  {
    id: 'builtin-swallowed-promise-error',
    enabled: true,
    severity: 'medium',
    category: 'bug',
    title: 'Promise 失败被静默吞掉',
    content: '空的 catch 回调会让异步失败无声消失，问题很难定位。请在回调中记录日志、上报监控或重新抛出，必要时返回明确的降级值。',
    matchPatterns: [{ type: 'regex', pattern: '\\.catch\\s*\\(\\s*(?:\\(\\s*\\w*\\s*\\)|\\w+)\\s*=>\\s*\\{\\s*\\}\\s*\\)|\\.catch\\s*\\(\\s*null\\s*\\)' }],
    languages: WEB,
  },
  {
    id: 'builtin-bare-except',
    enabled: true,
    severity: 'medium',
    category: 'bug',
    title: '裸 except 捕获了所有异常',
    content: '裸 except 会连同 KeyboardInterrupt、SystemExit 一起吞掉，掩盖真实故障。请捕获具体异常类型，记录上下文后再决定重试、降级或向上抛出。',
    matchPatterns: [{ type: 'regex', pattern: '^\\s*except\\s*:|except\\s+Exception\\s*(?:as\\s+\\w+)?\\s*:\\s*(?:pass|\\.\\..)\\s*$' }],
    languages: ['python'],
  },
  {
    id: 'builtin-go-unchecked-error',
    enabled: true,
    severity: 'medium',
    category: 'bug',
    title: 'Go 返回的 error 被丢弃',
    content: '把 error 赋给 _ 会让失败路径无法被感知。请显式处理错误、用 fmt.Errorf("...: %w", err) 包装后返回，或在注释中说明为什么可以安全忽略。',
    matchPatterns: [{ type: 'regex', pattern: '(?:^|[\\s,(])(?:[\\w.]+\\s*,\\s*)?_\\s*(?::?=)\\s*[\\w.]+\\(' }],
    languages: ['go'],
  },
  {
    id: 'builtin-blocking-sleep',
    enabled: true,
    severity: 'low',
    category: 'performance',
    title: '使用固定休眠等待状态变化',
    content: 'Thread.sleep / time.sleep 会让线程或请求阻塞固定时长，既拖慢响应又不可靠。请改为条件变量、轮询带上限的退避策略，或事件回调。',
    matchPatterns: [{ type: 'regex', pattern: 'Thread\\.sleep\\s*\\(|\\btime\\.sleep\\s*\\(|\\bSleep\\s*\\(\\s*time\\.|\bThread\\.currentThread\\(\\)\\.sleep' }],
    languages: [...JVM, 'python', 'go'],
  },
  {
    id: 'builtin-skipped-test',
    enabled: true,
    severity: 'medium',
    category: 'test',
    title: '测试被跳过或禁用',
    content: 'it.skip / @Disabled / pytest.mark.skip 会让回归保护失效。请修复被跳过的用例，或关联可追踪的 Issue 说明恢复时间，避免长期挂起。',
    matchPatterns: [{
      type: 'regex',
      pattern: '\\b(?:it|test|describe)\\.skip\\b|\\bx(?:it|describe|test)\\s*\\(|@Ignore\\b|@Disabled\\b|pytest\\.mark\\.skip|\\bt\\.Skip\\b|@pytest\\.mark\\.xfail|\\[Ignore\\]',
    }],
    languages: [...WEB, ...JVM, 'python', 'go', 'csharp', 'ruby'],
  },
  {
    id: 'builtin-console-log',
    enabled: true,
    severity: 'low',
    category: 'maintainability',
    title: '新增调试日志可能泄漏运行时信息',
    content: '生产代码中的 console.log/debug 会污染日志，并可能输出用户数据或令牌。建议改用受控 logger（带级别和脱敏），或在合并前移除。',
    matchPatterns: [{ type: 'regex', pattern: 'console\\.(?:log|debug|info)\\s*\\(' }],
    suggestionTemplate: 'logger.debug',
    languages: WEB,
  },
  {
    id: 'builtin-stdout-debug',
    enabled: true,
    severity: 'low',
    category: 'maintainability',
    title: '直接输出到标准输出调试',
    content: 'System.out / fmt.Print / print 等直接打印会绕过日志框架的级别、结构和脱敏能力。请改用项目统一的日志组件。',
    matchPatterns: [{
      type: 'regex',
      pattern: 'System\\.(?:out|err)\\.print|\\bfmt\\.Print(?:ln|f)?\\s*\\(|\\bConsole\\.Write(?:Line)?\\s*\\(|^\\s*print\\s*\\(|\\bprint_r\\s*\\(',
    }],
    languages: [...JVM, 'python', 'go', 'csharp', 'php'],
  },
  {
    id: 'builtin-hardcoded-local-endpoint',
    enabled: true,
    severity: 'low',
    category: 'maintainability',
    title: '硬编码本地或内网地址',
    content: 'localhost / 127.0.0.1 / 内网网段写死在代码里会让其他环境无法运行。请通过配置项或环境变量注入，并在文档中给出默认值。',
    matchPatterns: [{
      type: 'regex',
      pattern: 'https?://(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})(?::\\d+)?',
    }],
    scope: { exclude: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/testdata/**', '**/*.md', '**/*.yml', '**/*.yaml'] },
  },
  {
    id: 'builtin-todo-marker',
    enabled: true,
    severity: 'low',
    category: 'maintainability',
    title: '变更引入未完成标记',
    content: 'TODO/FIXME/HACK 表示实现或修复尚未完成。建议在合并前处理掉，或补充负责人与可追踪的 Issue 链接。',
    matchPatterns: [{ type: 'regex', pattern: '\\b(?:TODO|FIXME|HACK|XXX)\\b[:\\s]' }],
    skipComments: false,
  },
  {
    id: 'builtin-missing-test',
    enabled: true,
    severity: 'low',
    category: 'test',
    title: '本次实现变更缺少回归测试',
    content: 'Diff 中没有测试文件变更。建议至少覆盖新增分支、失败路径和边界条件；若确实无需测试，请在 MR 描述中说明原因。',
    matchPatterns: [],
    fileLevel: true,
  },
];

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

export async function loadRulePacks(storage = defaultStorage()): Promise<RulePack[]> {
  const raw = await storage.getValue(STORAGE_KEY, []);
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

export async function saveRulePacks(packs: RulePack[], storage = defaultStorage()): Promise<void> {
  const toSave = packs.map((pack) => {
    if (!pack.builtIn) return pack;
    return { ...pack, rules: pack.rules.map((rule) => ({ id: rule.id, enabled: rule.enabled })) };
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

export function runRulePackReview(files: FileDiff[], packs: RulePack[]): Finding[] {
  const findings: Finding[] = [];
  const inventory = enabledRulesOf(packs);
  const hasTestChange = files.some((candidate) => testPattern.test(candidate.newPath));

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
