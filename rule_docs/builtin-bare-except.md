---
id: builtin-bare-except
title: 裸 except 捕获了所有异常
severity: medium
category: bug
enabled: true
languages: [python]
---

# 裸 except 捕获了所有异常

裸 except 会连同 KeyboardInterrupt、SystemExit 一起吞掉，掩盖真实故障。请捕获具体异常类型，记录上下文后再决定重试、降级或向上抛出。

## 匹配模式

```pattern
^\s*except\s*:|except\s+Exception\s*(?:as\s+\w+)?\s*:\s*(?:pass|\.\..)\s*$
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
