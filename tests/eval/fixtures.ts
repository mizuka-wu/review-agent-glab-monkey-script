import type { FileDiff } from '../src/core/types';

/**
 * Evaluation fixture: a simulated MR diff with known issues.
 * Each fixture has expected findings that the review engine should detect.
 */

export interface EvalExpectedFinding {
  category: 'bug' | 'security' | 'performance' | 'maintainability' | 'test';
  severity: 'critical' | 'high' | 'medium' | 'low';
  titleContains: string;
  path: string;
  /** Line number range the finding should map to (optional, for anchor validation) */
  lineRange?: [number, number];
}

export interface EvalFixture {
  name: string;
  description: string;
  files: FileDiff[];
  expectedFindings: EvalExpectedFinding[];
  /** Findings that should NOT be produced (false positive checks) */
  notExpected?: string[];
}

function makeFile(path: string, diffLines: { kind: 'added' | 'removed' | 'context'; text: string; oldLine?: number; newLine?: number }[]): FileDiff {
  const diff = diffLines.map((line) => {
    const prefix = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
    return `${prefix}${line.text}`;
  }).join('\n');

  return {
    oldPath: path,
    newPath: path,
    diff: `@@ -1,${diffLines.filter((l) => l.kind !== 'added').length} +1,${diffLines.filter((l) => l.kind !== 'removed').length} @@\n${diff}`,
    newFile: false,
    deletedFile: false,
    renamedFile: false,
    lines: diffLines.map((line, index) => ({
      hunkId: 'h1',
      oldLine: line.oldLine ?? (line.kind !== 'added' ? index + 1 : undefined),
      newLine: line.newLine ?? (line.kind !== 'removed' ? index + 1 : undefined),
      kind: line.kind,
      text: line.text,
    })),
  };
}

export const evalFixtures: EvalFixture[] = [
  {
    name: 'security-hardcoded-credentials',
    description: '硬编码密钥和密码泄漏',
    files: [
      makeFile('src/config/database.ts', [
        { kind: 'context', text: 'export const config = {' },
        { kind: 'added', text: '  password: "SuperSecret123!@#",' },
        { kind: 'added', text: '  apiKey: "sk-live-abcdef123456",' },
        { kind: 'added', text: '  accessToken: "tok_xyz789",' },
        { kind: 'context', text: '  host: "localhost",' },
        { kind: 'context', text: '};' },
      ]),
    ],
    expectedFindings: [
      { category: 'security', severity: 'high', titleContains: '硬编码', path: 'src/config/database.ts', lineRange: [2, 2] },
      { category: 'security', severity: 'high', titleContains: '硬编码', path: 'src/config/database.ts', lineRange: [3, 3] },
      { category: 'security', severity: 'high', titleContains: '硬编码', path: 'src/config/database.ts', lineRange: [4, 4] },
    ],
  },
  {
    name: 'maintainability-debug-logs',
    description: '调试日志和 TODO 标记',
    files: [
      makeFile('src/services/payment.ts', [
        { kind: 'context', text: 'export async function processPayment(order: Order) {' },
        { kind: 'added', text: '  console.log("Processing order:", order.id);' },
        { kind: 'added', text: '  // TODO: handle retry logic' },
        { kind: 'added', text: '  console.debug("Payment details:", JSON.stringify(order));' },
        { kind: 'context', text: '  return gateway.charge(order);' },
        { kind: 'context', text: '}' },
      ]),
    ],
    expectedFindings: [
      { category: 'maintainability', severity: 'low', titleContains: '调试日志', path: 'src/services/payment.ts', lineRange: [2, 2] },
      { category: 'maintainability', severity: 'low', titleContains: '未完成标记', path: 'src/services/payment.ts', lineRange: [3, 3] },
      { category: 'maintainability', severity: 'low', titleContains: '调试日志', path: 'src/services/payment.ts', lineRange: [4, 4] },
    ],
  },
  {
    name: 'bug-weak-types',
    description: '类型安全和异常处理弱化',
    files: [
      makeFile('src/utils/parser.ts', [
        { kind: 'context', text: 'export function parse(input: string) {' },
        { kind: 'added', text: '  const result: any = JSON.parse(input);' },
        { kind: 'added', text: '  try {' },
        { kind: 'added', text: '    return result.data;' },
        { kind: 'added', text: '  } catch (e) { }' },
        { kind: 'context', text: '}' },
      ]),
    ],
    expectedFindings: [
      { category: 'bug', severity: 'medium', titleContains: '类型边界', path: 'src/utils/parser.ts', lineRange: [2, 2] },
      { category: 'bug', severity: 'medium', titleContains: '类型边界', path: 'src/utils/parser.ts', lineRange: [5, 5] },
    ],
  },
  {
    name: 'test-missing-regression',
    description: '缺少回归测试',
    files: [
      makeFile('src/api/users.ts', [
        { kind: 'context', text: 'export function createUser(data: UserData) {' },
        { kind: 'added', text: '  if (!data.email) throw new Error("email required");' },
        { kind: 'added', text: '  return db.insert("users", data);' },
        { kind: 'context', text: '}' },
      ]),
    ],
    expectedFindings: [
      { category: 'test', severity: 'low', titleContains: '缺少回归测试', path: 'src/api/users.ts' },
    ],
    notExpected: ['硬编码', '调试日志'],
  },
  {
    name: 'clean-code-no-findings',
    description: '干净代码不应产生 Finding',
    files: [
      makeFile('src/models/user.ts', [
        { kind: 'context', text: 'export interface User {' },
        { kind: 'added', text: '  readonly id: string;' },
        { kind: 'added', text: '  readonly name: string;' },
        { kind: 'added', text: '  readonly email: string;' },
        { kind: 'context', text: '}' },
      ]),
      makeFile('src/models/user.test.ts', [
        { kind: 'context', text: 'describe("User", () => {' },
        { kind: 'added', text: '  it("has correct shape", () => {' },
        { kind: 'added', text: '    expect(true).toBe(true);' },
        { kind: 'added', text: '  });' },
        { kind: 'context', text: '});' },
      ]),
    ],
    expectedFindings: [],
    notExpected: ['硬编码', '调试日志', '类型边界', '未完成标记', '缺少回归测试'],
  },
  {
    name: 'multi-file-mixed',
    description: '多文件混合问题',
    files: [
      makeFile('src/auth/login.ts', [
        { kind: 'context', text: 'export function login(username: string, password: string) {' },
        { kind: 'added', text: '  console.log("Login attempt:", username);' },
        { kind: 'added', text: '  const secret = "hardcoded-jwt-secret";' },
        { kind: 'added', text: '  return jwt.sign({ username }, secret);' },
        { kind: 'context', text: '}' },
      ]),
      makeFile('src/auth/login.test.ts', [
        { kind: 'context', text: 'describe("login", () => {' },
        { kind: 'added', text: '  it("should authenticate user", () => {' },
        { kind: 'added', text: '    expect(login("test", "pass")).toBeDefined();' },
        { kind: 'added', text: '  });' },
        { kind: 'context', text: '});' },
      ]),
    ],
    expectedFindings: [
      { category: 'maintainability', severity: 'low', titleContains: '调试日志', path: 'src/auth/login.ts' },
      { category: 'security', severity: 'high', titleContains: '硬编码', path: 'src/auth/login.ts' },
    ],
    notExpected: ['缺少回归测试'],
  },
  {
    name: 'performance-inefficiency',
    description: '性能问题检测',
    files: [
      makeFile('src/data/processor.ts', [
        { kind: 'context', text: 'export function processItems(items: Item[]) {' },
        { kind: 'added', text: '  for (let i = 0; i < items.length; i++) {' },
        { kind: 'added', text: '    for (let j = 0; j < items.length; j++) {' },
        { kind: 'added', text: '      if (items[i].id === items[j].parentId) {' },
        { kind: 'added', text: '        items[i].children.push(items[j]);' },
        { kind: 'added', text: '      }' },
        { kind: 'added', text: '    }' },
        { kind: 'added', text: '  }' },
        { kind: 'context', text: '}' },
      ]),
    ],
    expectedFindings: [],
    notExpected: ['硬编码', '调试日志'],
  },
  {
    name: 'renamed-file-secrets',
    description: '配置文件中的安全问题',
    files: [
      makeFile('src/config/settings.ts', [
        { kind: 'context', text: 'export default {' },
        { kind: 'added', text: '  api_key: "sk-proj-1234567890",' },
        { kind: 'added', text: '  access_token: "ghp_abcdef123456",' },
        { kind: 'context', text: '};' },
      ]),
    ],
    expectedFindings: [
      { category: 'security', severity: 'high', titleContains: '硬编码', path: 'src/config/settings.ts' },
      { category: 'security', severity: 'high', titleContains: '硬编码', path: 'src/config/settings.ts' },
    ],
  },
  // ── 规则覆盖扩充（每条规则一个标注样本）──
  {
    name: 'security-credential-in-url',
    description: '数据库连接串内嵌账号密码',
    files: [makeFile('src/db/connect.ts', [
      { kind: 'added', text: 'const dsn = "postgres://admin:p4ssw0rd@db.internal:5432/app";' },
    ])],
    expectedFindings: [
      { category: 'security', severity: 'high', titleContains: 'URL 中内嵌', path: 'src/db/connect.ts' },
    ],
  },
  {
    name: 'security-sql-injection-python',
    description: 'Python f-string 拼接 SQL',
    files: [makeFile('app/users_repo.py', [
      { kind: 'added', text: 'cursor.execute("SELECT * FROM users WHERE id = " + user_id)' },
    ])],
    expectedFindings: [
      { category: 'security', severity: 'critical', titleContains: 'SQL 语句', path: 'app/users_repo.py' },
    ],
  },
  {
    name: 'security-xss-sink',
    description: '用户内容直接写入 innerHTML',
    files: [makeFile('src/render/comment.ts', [
      { kind: 'added', text: 'container.innerHTML = comment.body;' },
    ])],
    expectedFindings: [
      { category: 'security', severity: 'high', titleContains: 'XSS', path: 'src/render/comment.ts' },
    ],
  },
  {
    name: 'security-code-injection',
    description: 'eval 执行外部输入',
    files: [makeFile('src/runner.js', [
      { kind: 'added', text: 'eval(payload.expression);' },
    ])],
    expectedFindings: [
      { category: 'security', severity: 'high', titleContains: '动态执行', path: 'src/runner.js' },
    ],
  },
  {
    name: 'security-tls-verify-disabled',
    description: '关闭 TLS 证书校验',
    files: [makeFile('src/http/client.ts', [
      { kind: 'added', text: 'const agent = new https.Agent({ rejectUnauthorized: false });' },
    ])],
    expectedFindings: [
      { category: 'security', severity: 'high', titleContains: 'TLS', path: 'src/http/client.ts' },
    ],
  },
  {
    name: 'security-weak-hash',
    description: '使用 md5 哈希密码',
    files: [makeFile('src/crypto/digest.ts', [
      { kind: 'added', text: "const digest = createHash('md5').update(password).digest('hex');" },
    ])],
    expectedFindings: [
      { category: 'security', severity: 'medium', titleContains: '哈希', path: 'src/crypto/digest.ts' },
    ],
  },
  {
    name: 'security-insecure-random',
    description: '会话令牌使用 Math.random',
    files: [makeFile('src/auth/token.ts', [
      { kind: 'added', text: 'const sessionToken = Math.random().toString(36).slice(2);' },
    ])],
    expectedFindings: [
      { category: 'security', severity: 'medium', titleContains: '随机数', path: 'src/auth/token.ts' },
    ],
  },
  {
    name: 'bug-git-conflict-marker',
    description: '提交残留冲突标记',
    files: [makeFile('src/merge/resolver.ts', [
      { kind: 'added', text: '<<<<<<< HEAD' },
      { kind: 'added', text: 'const mode = "fast";' },
      { kind: 'added', text: '>>>>>>> feature/fast-mode' },
    ])],
    expectedFindings: [
      { category: 'bug', severity: 'critical', titleContains: '冲突标记', path: 'src/merge/resolver.ts' },
    ],
  },
  {
    name: 'bug-java-equals-on-variable',
    description: '变量调用 equals 可能 NPE',
    files: [makeFile('src/Main.java', [
      { kind: 'added', text: 'if (name.equals("admin")) {' },
    ])],
    expectedFindings: [
      { category: 'bug', severity: 'medium', titleContains: 'equals', path: 'src/Main.java' },
    ],
  },
  {
    name: 'bug-kotlin-not-null',
    description: 'Kotlin !! 断言',
    files: [makeFile('src/UserService.kt', [
      { kind: 'added', text: 'val user = repo.findById(id)!!' },
    ])],
    expectedFindings: [
      { category: 'bug', severity: 'medium', titleContains: '强行断言', path: 'src/UserService.kt' },
    ],
  },
  {
    name: 'bug-ts-non-null-assertion',
    description: 'TS 非空断言链',
    files: [makeFile('src/dom/root.ts', [
      { kind: 'added', text: "const root = document.querySelector('#root')!.firstChild;" },
    ])],
    expectedFindings: [
      { category: 'bug', severity: 'low', titleContains: '绕过空值', path: 'src/dom/root.ts' },
    ],
  },
  {
    name: 'bug-weak-types',
    description: 'as any 弱化类型边界',
    files: [makeFile('src/utils/parse.ts', [
      { kind: 'added', text: 'const payload = JSON.parse(raw) as any;' },
    ])],
    expectedFindings: [
      { category: 'bug', severity: 'medium', titleContains: '类型边界', path: 'src/utils/parse.ts' },
    ],
  },
  {
    name: 'bug-swallowed-promise-error',
    description: 'catch 空函数吞掉失败',
    files: [makeFile('src/persist/save.ts', [
      { kind: 'added', text: 'void save().catch(() => {});' },
    ])],
    expectedFindings: [
      { category: 'bug', severity: 'medium', titleContains: '静默吞掉', path: 'src/persist/save.ts' },
    ],
  },
  {
    name: 'bug-bare-except-python',
    description: '裸 except 吞异常',
    files: [makeFile('app/loader.py', [
      { kind: 'added', text: 'try:' },
      { kind: 'added', text: '    load(path)' },
      { kind: 'added', text: 'except:' },
      { kind: 'added', text: '    pass' },
    ])],
    expectedFindings: [
      { category: 'bug', severity: 'medium', titleContains: '裸 except', path: 'app/loader.py' },
    ],
  },
  {
    name: 'bug-go-unchecked-error',
    description: 'Go 丢弃 error 返回值',
    files: [makeFile('src/client.go', [
      { kind: 'added', text: 'resp, _ := http.Get(url)' },
    ])],
    expectedFindings: [
      { category: 'bug', severity: 'medium', titleContains: 'error 被丢弃', path: 'src/client.go' },
    ],
  },
  {
    name: 'bug-thread-unsafe-shared-state',
    description: '静态可变共享状态',
    files: [makeFile('src/SessionStore.java', [
      { kind: 'added', text: 'private static HashMap<String, Session> sessions = new HashMap<>();' },
    ])],
    expectedFindings: [
      { category: 'bug', severity: 'high', titleContains: '共享状态', path: 'src/SessionStore.java' },
    ],
  },
  {
    name: 'performance-blocking-sleep',
    description: '固定休眠等待',
    files: [makeFile('src/Waiter.java', [
      { kind: 'added', text: 'Thread.sleep(5000);' },
    ])],
    expectedFindings: [
      { category: 'performance', severity: 'low', titleContains: '固定休眠', path: 'src/Waiter.java' },
    ],
  },
  {
    name: 'test-skipped-case',
    description: '跳过关键测试',
    files: [makeFile('src/checkout/refund.test.ts', [
      { kind: 'added', text: "it.skip('refunds partial amount', async () => {" },
    ])],
    expectedFindings: [
      { category: 'test', severity: 'medium', titleContains: '跳过', path: 'src/checkout/refund.test.ts' },
    ],
  },
  {
    name: 'maintainability-console-log',
    description: '调试日志泄漏会话',
    files: [makeFile('src/auth/session.ts', [
      { kind: 'added', text: "console.log('session', session);" },
    ])],
    expectedFindings: [
      { category: 'maintainability', severity: 'low', titleContains: '调试日志', path: 'src/auth/session.ts' },
    ],
  },
  {
    name: 'maintainability-stdout-debug',
    description: 'print 调试输出',
    files: [makeFile('app/service.py', [
      { kind: 'added', text: 'print(f"debug: {payload}")' },
    ])],
    expectedFindings: [
      { category: 'maintainability', severity: 'low', titleContains: '标准输出', path: 'app/service.py' },
    ],
  },
  {
    name: 'maintainability-hardcoded-internal-endpoint',
    description: '硬编码内网地址',
    files: [makeFile('src/config/api.ts', [
      { kind: 'added', text: 'const apiBase = "http://192.168.1.50:8080/api";' },
    ])],
    expectedFindings: [
      { category: 'maintainability', severity: 'low', titleContains: '内网', path: 'src/config/api.ts' },
    ],
  },
  {
    name: 'maintainability-todo-marker',
    description: '引入未完成标记',
    files: [makeFile('src/retry/policy.ts', [
      { kind: 'added', text: '// TODO: handle retry budget' },
    ])],
    expectedFindings: [
      { category: 'maintainability', severity: 'low', titleContains: '未完成标记', path: 'src/retry/policy.ts' },
    ],
  },
  {
    name: 'clean-typed-refactor',
    description: '干净的类型化重构，不应产生任何 finding',
    files: [makeFile('src/math/add.ts', [
      { kind: 'removed', text: 'export function add(a, b) {' },
      { kind: 'added', text: 'export function add(a: number, b: number): number {' },
      { kind: 'added', text: '  return a + b;' },
      { kind: 'added', text: '}' },
    ])],
    expectedFindings: [],
    notExpected: ['敏感', 'SQL', '冲突', '调试日志'],
  },

];

// --- Benchmark result types ---

export interface BenchmarkFinding {
  path: string;
  category: string;
  severity: string;
  title: string;
  line: number;
  matched?: boolean;
}

export interface FixtureResult {
  fixtureName: string;
  totalExpected: number;
  detected: number;
  falsePositives: number;
  missed: string[];
  unexpected: string[];
  detectionRate: number;
  precision: number;
}

export interface BenchmarkSummary {
  fixtures: FixtureResult[];
  overallDetectionRate: number;
  overallPrecision: number;
  totalExpected: number;
  totalDetected: number;
  totalFalsePositives: number;
}
