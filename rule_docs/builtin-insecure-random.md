---
id: builtin-insecure-random
title: 安全场景使用了可预测的随机数
severity: medium
category: security
enabled: true
languages: [ts, js, python]
patternFlags: ["i"]
---

# 安全场景使用了可预测的随机数

Math.random / random.random 不是加密安全的伪随机数，用于 Token、验证码、盐值时可被预测。请改用 crypto.randomBytes、crypto.getRandomValues、secrets 或 java.security.SecureRandom。

## 匹配模式

```pattern
(?:token|secret|password|passwd|api[_-]?key|nonce|salt|session|otp|verify[_-]?code|captcha)[\w.]{0,24}[^;\n]{0,80}(?:Math\.random|random\.random)\s*\(|(?:Math\.random|random\.random)\s*\([^;\n]{0,80}(?:token|secret|password|api[_-]?key|nonce|salt|session|otp|captcha)
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
