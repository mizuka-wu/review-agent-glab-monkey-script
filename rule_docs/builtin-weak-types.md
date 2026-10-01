---
id: builtin-weak-types
title: 异常处理或类型边界被弱化
severity: medium
category: bug
enabled: true
languages: [ts, js]
scopeExclude: ["**/*.test.*","**/*.spec.*","**/__tests__/**","**/tests/**","**/testdata/**"]
---

# 异常处理或类型边界被弱化

any、@ts-ignore、@ts-expect-error 或空 catch 会隐藏类型错误与失败路径。建议保留精确类型（unknown + 收窄），并在 catch 中记录日志或向上抛出。

## 匹配模式

```pattern
:\s*any\b|<any>|as\s+any\b|@ts-(?:ignore|expect-error|nocheck)|catch\s*(?:\([^)]*\))?\s*\{\s*\}
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
