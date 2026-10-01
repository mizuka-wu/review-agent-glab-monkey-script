---
id: builtin-xss-sink
title: 直接写入 HTML 造成 XSS 风险
severity: high
category: security
enabled: true
languages: [ts, js, html, php, ruby]
---

# 直接写入 HTML 造成 XSS 风险

innerHTML / dangerouslySetInnerHTML / v-html / document.write 会原样执行插入的标记。若内容来自用户或接口，请先做转义或使用受信的 sanitize 库，并确认没有绕过框架的自动转义。

## 匹配模式

```pattern
\.(?:innerHTML|outerHTML)\s*=[^=]|insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\(|dangerouslySetInnerHTML|v-html\s*=|\$\([^)]*\)\.html\s*\(
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
