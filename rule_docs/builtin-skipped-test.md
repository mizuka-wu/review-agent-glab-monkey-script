---
id: builtin-skipped-test
title: 测试被跳过或禁用
severity: medium
category: test
enabled: true
languages: [ts, js, java, kotlin, scala, python, go, csharp, ruby]
---

# 测试被跳过或禁用

it.skip / @Disabled / pytest.mark.skip 会让回归保护失效。请修复被跳过的用例，或关联可追踪的 Issue 说明恢复时间，避免长期挂起。

## 匹配模式

```pattern
\b(?:it|test|describe)\.skip\b|\bx(?:it|describe|test)\s*\(|@Ignore\b|@Disabled\b|pytest\.mark\.skip|\bt\.Skip\b|@pytest\.mark\.xfail|\[Ignore\]
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
