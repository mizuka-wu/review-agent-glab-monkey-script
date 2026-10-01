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
      { text: '架构', link: '/architecture' },
      { text: 'TODO / Backlog', link: `${repo}/blob/main/TODO.md` },
      { text: '安装', link: `${repo}/releases/latest` },
    ],
    sidebar: [
      {
        text: '开始',
        items: [
          { text: '文档首页', link: '/' },
          { text: '产品需求与范围', link: '/product-brief' },
          { text: '能力边界', link: '/capability-boundary' },
        ],
      },
      {
        text: '设计与实现',
        items: [
          { text: '系统架构与数据模型', link: '/architecture' },
          { text: 'UX 流程与原型', link: '/ux-flows-and-prototype' },
          { text: 'GitLab 接入', link: '/gitlab-integration' },
          { text: 'Agent Gateway 协议', link: '/agent-gateway-contract' },
          { text: '安全与隐私', link: '/security-privacy' },
        ],
      },
    ],
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新' },
    socialLinks: [{ icon: 'github', link: repo }],
  },
});
