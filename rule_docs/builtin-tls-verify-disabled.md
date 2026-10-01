---
id: builtin-tls-verify-disabled
title: 关闭了 TLS 证书或主机名校验
severity: high
category: security
enabled: true
---

# 关闭了 TLS 证书或主机名校验

跳过证书校验会让连接容易被中间人攻击。请配置正确的 CA 证书链；仅在受控的本地联调环境用开关临时关闭，并确保不会进入生产构建。

## 匹配模式

```pattern
rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED|verify\s*=\s*False|check_hostname\s*=\s*False|CURLOPT_SSL_VERIFY(?:PEER|HOST)[^;]{0,20}(?:0|false)|trustAllCerts|ALLOW_ALL_HOSTNAME_VERIFIER|new\s+X509TrustManager|ssl\s*=\s*False
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
