---
id: builtin-kotlin-notnull-assertion
title: 使用 !! 强行断言非空
severity: medium
category: bug
enabled: true
languages: [kotlin]
---

# 使用 !! 强行断言非空

!! 会把可空类型直接解包，一旦为 null 就抛出 NullPointerException，绕过编译期的空安全检查。请改用 ?.、?: 提供默认值，或 requireNotNull(value) { "原因" } 给出可读的失败信息。

## 匹配模式

```pattern
[\w)\]]!!(?:[.\[]|\s*[;,)=]|\s*$)
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
