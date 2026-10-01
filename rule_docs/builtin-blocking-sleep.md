---
id: builtin-blocking-sleep
title: 使用固定休眠等待状态变化
severity: low
category: performance
enabled: true
languages: [java, kotlin, scala, python, go]
---

# 使用固定休眠等待状态变化

Thread.sleep / time.sleep 会让线程或请求阻塞固定时长，既拖慢响应又不可靠。请改为条件变量、轮询带上限的退避策略，或事件回调。

## 匹配模式

```pattern
Thread\.sleep\s*\(|\btime\.sleep\s*\(|\bSleep\s*\(\s*time\.|Thread\.currentThread\(\)\.sleep
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
