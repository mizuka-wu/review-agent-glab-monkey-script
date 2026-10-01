---
id: builtin-hardcoded-secret
title: 代码中疑似硬编码敏感信息
severity: high
category: security
enabled: true
patternFlags: ["i"]
---

# 代码中疑似硬编码敏感信息

新增赋值涉及密码、Token 或 API Key。应从环境变量、安全配置或密钥管理服务读取，并确认该值没有进入日志、构建产物和 Git 历史；若已提交真实凭据请立即轮换。

## 匹配模式

```pattern
\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*["'][^"']{3,}
```

## 反例

```
const apiKey = "sk-live-9f8e7d6c5b4a";
const cfg = { password: "hunter2" };
```

## 正例

```
const apiKey = process.env.API_KEY;
const cfg = { password: readSecret("db-password") };
```
