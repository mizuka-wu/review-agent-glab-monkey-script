---
id: builtin-missing-test
title: 本次实现变更缺少回归测试
severity: low
category: test
enabled: true
fileLevel: true
---

# 本次实现变更缺少回归测试

Diff 中没有测试文件变更。建议至少覆盖新增分支、失败路径和边界条件；若确实无需测试，请在 MR 描述中说明原因。

## 匹配模式

```pattern

```

## 反例

```
src/checkout/retry.ts 新增重试分支，但 MR 中没有任何 *.test.* 变更
```

## 正例

```
同 MR 包含 src/checkout/retry.test.ts 覆盖成功/失败/超时路径
```
