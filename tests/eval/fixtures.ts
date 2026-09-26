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
