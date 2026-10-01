---
id: builtin-java-equals-on-variable
title: equals 的调用方可能为 null
severity: medium
category: bug
enabled: true
languages: [java]
---

# equals 的调用方可能为 null

用变量调用 equals 传入字面量时，变量为 null 会抛 NullPointerException。请把字面量或已知非空的常量放在前面，例如 "ACTIVE".equals(status)，或改用 Objects.equals(a, b)。

## 匹配模式

```pattern
(?:^|[^"\w.])[a-z_]\w*\.equals\s*\(\s*"
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
