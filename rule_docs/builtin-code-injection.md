---
id: builtin-code-injection
title: 动态执行代码或系统命令
severity: high
category: security
enabled: true
languages: [ts, js, java, kotlin, scala, python, go, php, ruby, csharp]
---

# 动态执行代码或系统命令

eval / new Function / Runtime.exec / os.system / shell=True 会把字符串当作代码或命令执行。请改用显式分支、白名单命令或结构化参数（execFile、subprocess 列表参数）。

## 匹配模式

```pattern
\beval\s*\(|new\s+Function\s*\(|Runtime\.getRuntime\s*\(\s*\)\s*\.\s*exec|\bProcessBuilder\s*\(|\bos\.system\s*\(|\bos\.popen\s*\(|shell\s*=\s*True|\bexecSync\s*\(|\bchild_process\b
```

## 反例

<!-- 补充触发该规则的代码片段 -->

## 正例

<!-- 补充推荐写法 -->
