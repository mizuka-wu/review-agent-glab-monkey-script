---
id: builtin-ts-non-null-assertion
title: 使用 ! 断言绕过空值检查
severity: low
category: bug
enabled: true
languages: [ts]
scopeExclude: ["**/*.test.*","**/*.spec.*","**/__tests__/**","**/tests/**","**/testdata/**"]
---

# 使用 ! 断言绕过空值检查

非空断言会让 TypeScript 跳过 undefined / null 检查，运行时仍可能抛错。请补充显式判空、可选链或收窄类型，只有在类型系统无法表达但业务上确实非空时才使用断言。

## 匹配模式

```pattern
[\w)\]]!\.|[\w)\]]!\[
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
