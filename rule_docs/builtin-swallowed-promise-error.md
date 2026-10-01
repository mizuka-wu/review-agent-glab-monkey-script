---
id: builtin-swallowed-promise-error
title: Promise 失败被静默吞掉
severity: medium
category: bug
enabled: true
languages: [ts, js]
---

# Promise 失败被静默吞掉

空的 catch 回调会让异步失败无声消失，问题很难定位。请在回调中记录日志、上报监控或重新抛出，必要时返回明确的降级值。

## 匹配模式

```pattern
\.catch\s*\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*\{\s*\}\s*\)|\.catch\s*\(\s*null\s*\)
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
