---
id: builtin-sql-injection
title: SQL 语句由字符串拼接或插值构成
severity: critical
category: security
enabled: true
languages: [ts, js, java, kotlin, scala, python, go, php, ruby, csharp, sql]
patternFlags: ["i"]
---

# SQL 语句由字符串拼接或插值构成

SQL 与外部输入直接拼接会造成注入风险。请改用参数化查询 / PreparedStatement / ORM 绑定参数，并确认排序字段、表名等无法参数化的部分走了白名单校验。

## 匹配模式

```pattern
\b(?:select\s.+?\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from)\b[^;]{0,240}?(?:\$\{|"\s*\+|'\s*\+|\+\s*"|\+\s*'|\.format\s*\(|%\s*[(\w]|f"|f')
```

## 反例

```
db.query("SELECT * FROM users WHERE id = " + userId);
cursor.execute(f"SELECT * FROM t WHERE name = '{name}'")
```

## 正例

```
db.query("SELECT * FROM users WHERE id = ?", [userId]);
cursor.execute("SELECT * FROM t WHERE name = %s", (name,))
```
