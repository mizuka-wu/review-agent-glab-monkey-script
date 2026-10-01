---
id: builtin-console-log
title: 新增调试日志可能泄漏运行时信息
severity: low
category: maintainability
enabled: true
languages: [ts, js]
suggestionTemplate: logger.debug
scopeExclude: ["**/*.test.*","**/*.spec.*","**/__tests__/**","**/tests/**","**/testdata/**"]
---

# 新增调试日志可能泄漏运行时信息

生产代码中的 console.log/debug 会污染日志，并可能输出用户数据或令牌。建议改用受控 logger（带级别和脱敏），或在合并前移除。

## 匹配模式

```pattern
console\.(?:log|debug|info)\s*\(
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
