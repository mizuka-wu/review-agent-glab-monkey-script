---
id: builtin-weak-hash
title: 使用了已不安全的哈希算法
severity: medium
category: security
enabled: true
patternFlags: ["i"]
---

# 使用了已不安全的哈希算法

MD5 / SHA-1 / DES / RC4 已被证明存在碰撞或密钥长度不足的问题。请改用 SHA-256 及以上；涉及口令存储时使用 bcrypt、scrypt 或 Argon2 等带盐的慢哈希。

## 匹配模式

```pattern
\bmd5\s*\(|\bsha1\s*\(|createHash\s*\(\s*['"](?:md5|sha1)['"]|MessageDigest\.getInstance\s*\(\s*"(?:MD5|SHA-?1|DES)"|hashlib\.(?:md5|sha1)\s*\(|\bDESede?\b|\bRC[24]\b
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
