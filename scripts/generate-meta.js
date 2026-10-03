import { readFileSync, writeFileSync } from 'node:fs';

const USER_JS = 'dist/review-agent-glab-monkey-script.user.js';
const LOCALIZED = [
  '// @description:zh-CN GitLab MR 评审油猴脚本：24 条本地规则零 token 恒运行（无 Key 可用），配置 OpenAI 兼容模型后叠加流式 AI 评审（思考折叠、增量结果、反思自检、分组并发）；OPFS 符号索引支持符号搜索/调用链与全文件扫描；规则包按项目作用域管理；Finding 草稿确认后发布行级 Discussion，另有一键 Approve、总评论、会话回放、多 MCP 扩展与四面板调试工具；无遥测，代码只在你浏览器、你的 GitLab 与你配置的模型端点之间流动。',
  '// @description:en In-page GitLab MR review: 24 local deterministic rules run offline with zero tokens (no API key needed); optional OpenAI-compatible model adds streamed AI review with collapsible thinking, incremental findings, reflection and concurrent per-bundle sub-reviews. OPFS symbol index powers symbol search, call chains and full-file scans; rule packs are project-scoped; findings stay drafts until you publish line-level discussions, plus one-click approve, summary note, session replay, multi-MCP tools and a four-pane debugger. No telemetry: code only travels between your browser, your GitLab and your configured model endpoint.',
];

let src = readFileSync(USER_JS, 'utf8');
if (!src.includes('// @description:zh-CN')) {
  src = src.replace(/(\/\/ @description [^\n]*\n)/, `$1${LOCALIZED.join('\n')}\n`);
  writeFileSync(USER_JS, src);
  console.log('Injected localized descriptions into', USER_JS);
}
const meta = src.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
if (meta) {
  writeFileSync('dist/review-agent-glab-monkey-script.meta.js', meta[0] + '\n');
  console.log('Generated dist/review-agent-glab-monkey-script.meta.js');
} else {
  console.error('Could not find UserScript metadata block');
  process.exit(1);
}
