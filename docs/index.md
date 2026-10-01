---
layout: home

hero:
  name: Review Agent for GitLab
  text: 规则优先 × 模型叠加的 MR 评审油猴脚本
  tagline: 无需 API Key 即可用；配置模型后叠加 AI 评审、流式思考、符号搜索与调用链
  actions:
    - theme: brand
      text: 一键安装（Release）
      link: https://github.com/mizuka-wu/review-agent-glab-monkey-script/releases/latest/download/review-agent-glab-monkey-script.user.js
    - theme: alt
      text: 系统架构
      link: /02-architecture
    - theme: alt
      text: GitHub
      link: https://github.com/mizuka-wu/review-agent-glab-monkey-script

features:
  - title: 规则优先 · 无 Key 可用
    details: 24 条内置确定性规则在浏览器本地执行，零 token；未配置模型时 Review、定位、编辑、复制草稿全部可用。
  - title: 流式评审 · 思考折叠
    details: 模型阶段 SSE 流式：思考通道折叠打字机、finding 逐条增量进入结果列表、可随时停止；规则结果先行渲染。
  - title: 本地符号索引
    details: OPFS 缓存仓库文件并构建符号表，提供 symbol_search / call_chain 工具与「Diff 外调用点」上下文，按 branch 管理多份索引。
  - title: 人确认后才发布
    details: 所有评论默认草稿；行级 Discussion 单条/批量发布、一键 Approve、MR 总评论，均为两步确认防误触。
---
