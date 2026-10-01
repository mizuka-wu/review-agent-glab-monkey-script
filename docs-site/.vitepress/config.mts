import { defineConfig } from 'vitepress';

const repo = 'https://github.com/mizuka-wu/review-agent-glab-monkey-script';

export default defineConfig({
  base: '/review-agent-glab-monkey-script/',
  lang: 'zh-CN',
  title: 'Review Agent for GitLab',
  description: 'GitLab MR 评审油猴脚本：规则优先 × 模型叠加的技术文档',
  srcDir: '../docs',
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '架构', link: '/02-architecture' },
      { text: '差距分析', link: '/10-opencodereview-gap-analysis' },
      { text: '安装', link: `${repo}/releases/latest` },
    ],
    sidebar: [
      {
        text: '开始',
        items: [
          { text: '文档首页', link: '/' },
          { text: '产品需求与范围', link: '/00-product-brief' },
          { text: '能力边界', link: '/01-capability-boundary' },
        ],
      },
      {
        text: '设计与实现',
        items: [
          { text: '系统架构与数据模型', link: '/02-architecture' },
          { text: '开发计划', link: '/03-development-plan' },
          { text: 'UX 流程与原型', link: '/04-ux-flows-and-prototype' },
          { text: 'GitLab 接入', link: '/05-gitlab-integration' },
          { text: 'Agent Gateway 协议', link: '/06-agent-gateway-contract' },
          { text: '安全与隐私', link: '/07-security-privacy' },
        ],
      },
      {
        text: '质量与对齐',
        items: [
          { text: '测试与验收', link: '/08-testing-acceptance' },
          { text: 'Review Engine 计划', link: '/09-p0-review-engine-plan' },
          { text: '与 OpenCodeReview 差距分析', link: '/10-opencodereview-gap-analysis' },
          { text: 'MCP 桥与 Agent 工具面计划', link: '/11-mcp-bridge-and-agent-surface-plan' },
        ],
      },
    ],
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新' },
    socialLinks: [{ icon: 'github', link: repo }],
  },
});
