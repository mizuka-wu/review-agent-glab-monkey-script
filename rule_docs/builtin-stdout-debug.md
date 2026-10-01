---
id: builtin-stdout-debug
title: 直接输出到标准输出调试
severity: low
category: maintainability
enabled: true
languages: [java, kotlin, scala, python, go, csharp, php]
scopeExclude: ["**/*.test.*","**/*.spec.*","**/__tests__/**","**/tests/**","**/testdata/**"]
---

# 直接输出到标准输出调试

System.out / fmt.Print / print 等直接打印会绕过日志框架的级别、结构和脱敏能力。请改用项目统一的日志组件。

## 匹配模式

```pattern
System\.(?:out|err)\.print|\bfmt\.Print(?:ln|f)?\s*\(|\bConsole\.Write(?:Line)?\s*\(|^\s*print\s*\(|\bprint_r\s*\(
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
