---
id: builtin-git-conflict-marker
title: 提交中残留 Git 冲突标记
severity: critical
category: bug
enabled: true
skipComments: false
---

# 提交中残留 Git 冲突标记

合并冲突标记被直接提交，会导致文件无法编译或运行。请在合并前解决冲突并删除 <<<<<<< / ======= / >>>>>>> 标记。

## 匹配模式

```pattern
^\s*(?:<{7}\s|>{7}\s|={7}\s*$)
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
