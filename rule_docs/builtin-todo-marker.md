---
id: builtin-todo-marker
title: 变更引入未完成标记
severity: low
category: maintainability
enabled: true
skipComments: false
---

# 变更引入未完成标记

TODO/FIXME/HACK 表示实现或修复尚未完成。建议在合并前处理掉，或补充负责人与可追踪的 Issue 链接。

## 匹配模式

```pattern
\b(?:TODO|FIXME|HACK|XXX)\b[:\s]
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
