---
id: builtin-thread-unsafe-shared-state
title: 静态字段持有可变共享状态
severity: high
category: bug
enabled: true
languages: [java, kotlin, scala]
---

# 静态字段持有可变共享状态

SimpleDateFormat、Calendar、HashMap、ArrayList、StringBuilder 等类型不是线程安全的，放在 static 字段上会被多线程共享，导致解析错乱、数据丢失甚至死循环。请改为方法内局部变量、ThreadLocal，或使用 DateTimeFormatter、ConcurrentHashMap、CopyOnWriteArrayList 等并发安全实现。

## 匹配模式

```pattern
\bstatic\b[^=;(){}]{0,60}\b(?:SimpleDateFormat|Calendar|HashMap|ArrayList|LinkedList|HashSet|TreeMap|TreeSet|StringBuilder|StringBuffer|Random)\b
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
