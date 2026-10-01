---
id: builtin-hardcoded-local-endpoint
title: 硬编码本地或内网地址
severity: low
category: maintainability
enabled: true
scopeExclude: ["**/*.test.*","**/*.spec.*","**/__tests__/**","**/testdata/**","**/*.md","**/*.yml","**/*.yaml"]
---

# 硬编码本地或内网地址

localhost / 127.0.0.1 / 内网网段写死在代码里会让其他环境无法运行。请通过配置项或环境变量注入，并在文档中给出默认值。

## 匹配模式

```pattern
https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
