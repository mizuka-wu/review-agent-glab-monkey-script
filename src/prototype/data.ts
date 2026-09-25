import type { ChatMessage, DiffLine, Finding } from './types';

export const fileDiff: DiffLine[] = [
  {
    oldLine: 26,
    newLine: 26,
    kind: 'context',
    text: 'export async function checkout(request: CheckoutRequest) {',
  },
  {
    oldLine: 27,
    newLine: 27,
    kind: 'context',
    text: '  const order = await createOrder(request.cart);',
  },
  {
    oldLine: 28,
    newLine: 28,
    kind: 'removed',
    text: '  await reserveInventory(order.items);',
  },
  {
    oldLine: undefined,
    newLine: 28,
    kind: 'added',
    text: '  const reservation = await checkoutInventory(order.items);',
  },
  {
    oldLine: undefined,
    newLine: 29,
    kind: 'added',
    text: '  await reservation.confirm();',
  },
  {
    oldLine: 29,
    newLine: 30,
    kind: 'context',
    text: '',
  },
  {
    oldLine: 30,
    newLine: 31,
    kind: 'context',
    text: '  try {',
  },
  {
    oldLine: 31,
    newLine: 32,
    kind: 'context',
    text: '    const payment = await paymentGateway.capture(order.total);',
  },
  {
    oldLine: 32,
    newLine: 33,
    kind: 'context',
    text: '    return finalizeCheckout(order, payment);',
  },
  {
    oldLine: 33,
    newLine: 34,
    kind: 'context',
    text: '  } catch (error) {',
  },
  {
    oldLine: undefined,
    newLine: 35,
    kind: 'added',
    text: '    await reservation.release();',
  },
  {
    oldLine: 34,
    newLine: 36,
    kind: 'context',
    text: '    throw normalizePaymentError(error);',
  },
  {
    oldLine: 35,
    newLine: 37,
    kind: 'context',
    text: '  }',
  },
  {
    oldLine: 36,
    newLine: 38,
    kind: 'context',
    text: '}',
  },
];

export const initialMessages: ChatMessage[] = [
  {
    id: 'assistant-welcome',
    role: 'assistant',
    content:
      '我已读取当前 MR 的变更摘要。你可以选中 Diff 中的代码继续提问，或从右侧发起完整 Review。',
  },
];

export const chatSuggestions = [
  '这段变更可能有哪些并发问题？',
  '解释 reservation 的生命周期。',
  '为这个改动补充测试建议。',
];

export const findings: Finding[] = [
  {
    id: 'finding-inventory-race',
    path: 'src/checkout.ts',
    line: 28,
    endLine: 29,
    category: 'bug',
    severity: 'high',
    confidence: 'high',
    title: '库存确认与支付捕获不是原子操作',
    content:
      'reservation.confirm() 在支付成功前执行。如果支付失败，catch 分支虽然会 release，但在并发请求下仍可能出现短暂超卖，且 confirm/release 的幂等性没有在本次变更中体现。',
    evidence: [
      {
        path: 'src/checkout.ts',
        lines: 'L28-L33',
        quote: 'reservation.confirm() 后直接进入 paymentGateway.capture()',
      },
      {
        path: 'src/inventory.ts',
        lines: 'L18-L24',
        quote: 'confirm() 将 reservation 标记为 consumed，不等待支付结果',
      },
    ],
    existingCode: '  const reservation = await checkoutInventory(order.items);\n  await reservation.confirm();',
    suggestionCode:
      '  const reservation = await checkoutInventory(order.items);\n  await reservation.hold();',
    comment:
      '这里在支付捕获完成前就 confirm 了库存。若 paymentGateway.capture() 失败，虽然会走 release，但并发下仍可能造成短暂超卖。建议先 hold，在支付成功后再 confirm，并补充 confirm / release 幂等测试。',
    status: 'draft',
  },
  {
    id: 'finding-error-path',
    path: 'src/checkout.ts',
    line: 35,
    endLine: 35,
    category: 'maintainability',
    severity: 'medium',
    confidence: 'medium',
    title: '释放失败会覆盖原始支付错误',
    content:
      'reservation.release() 抛错时会替换原始支付异常，调用方将无法判断支付是否已经成功。建议记录 release 错误并保留原始 cause。',
    evidence: [
      {
        path: 'src/checkout.ts',
        lines: 'L34-L36',
        quote: 'catch 中 await reservation.release() 后再抛出 normalizePaymentError(error)',
      },
    ],
    existingCode: '    await reservation.release();\n    throw normalizePaymentError(error);',
    suggestionCode:
      '    await reservation.release().catch((releaseError) => {\n      logger.error({ releaseError, paymentError: error });\n    });\n    throw normalizePaymentError(error);',
    comment:
      'release() 失败时会覆盖支付阶段的原始异常。建议把 release 失败作为附加日志处理，并始终以 payment error 作为抛出的主因。',
    status: 'draft',
  },
  {
    id: 'finding-test-coverage',
    path: 'src/checkout.test.ts',
    line: 12,
    endLine: 12,
    category: 'test',
    severity: 'low',
    confidence: 'medium',
    title: '缺少支付失败后的库存释放测试',
    content:
      '当前测试只覆盖支付成功路径。建议补充 capture 失败、release 失败和重复 release 三类回归测试。',
    evidence: [
      {
        path: 'src/checkout.test.ts',
        lines: 'L8-L18',
        quote: '现有 describe 只包含 payment succeeds 场景',
      },
    ],
    existingCode: "  it('completes checkout', async () => {",
    suggestionCode:
      "  it('releases inventory when payment capture fails', async () => {\n    // ...\n  });",
    comment:
      '建议补充支付 capture 失败时释放库存、release 失败不覆盖原始错误、以及重复 release 的测试，覆盖本次新增的补偿路径。',
    status: 'draft',
  },
];

export const reviewStages = [
  { key: 'preparing', label: '准备上下文', detail: '读取 MR 元数据与 14 个变更文件' },
  { key: 'running', label: '分析变更', detail: '按文件组执行 4 个 Review 子任务' },
  { key: 'normalizing', label: '校验与定位', detail: '验证证据并将 Finding 映射到 Diff 行' },
];

export const toolTrace = [
  { tool: 'file_read_diff', detail: 'src/checkout.ts · 14 lines', time: '0.4s' },
  { tool: 'file_search', detail: 'CheckoutService · 6 matches', time: '0.2s' },
  { tool: 'rule_match', detail: 'checkout.inventory-atomicity', time: '0.1s' },
];
