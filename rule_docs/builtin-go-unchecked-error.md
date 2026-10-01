---
id: builtin-go-unchecked-error
title: Go 返回的 error 被丢弃
severity: medium
category: bug
enabled: true
languages: [go]
---

# Go 返回的 error 被丢弃

把 error 赋给 _ 会让失败路径无法被感知。请显式处理错误、用 fmt.Errorf("...: %w", err) 包装后返回，或在注释中说明为什么可以安全忽略。

## 匹配模式

```pattern
(?:^|[\s,(])(?:[\w.]+\s*,\s*)?_\s*(?::?=)\s*[\w.]+\(
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
