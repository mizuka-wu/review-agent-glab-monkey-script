---
id: builtin-credential-in-url
title: URL 中内嵌账号密码
severity: high
category: security
enabled: true
---

# URL 中内嵌账号密码

形如 http://user:pass@host 的地址会把凭据写入代码、日志和浏览器历史。请改为在请求头或密钥管理服务中传递认证信息。

## 匹配模式

```pattern
(?:https?|ftp|mysql|postgres(?:ql)?|redis|amqp|mongodb)://[^/\s"']+:[^@\s"']+@
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
