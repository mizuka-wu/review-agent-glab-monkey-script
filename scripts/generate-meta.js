import { readFileSync, writeFileSync } from 'node:fs';

const USER_JS = 'dist/review-agent-glab-monkey-script.user.js';
const LOCALIZED = [
  '// @description:zh-CN GitLab MR 评审油猴脚本：规则优先 + 模型叠加，流式思考、符号搜索与调用链、一键行内评论/总评论/Approve。',
  '// @description:en Real GitLab diff review, selection chat, and confirmed discussion publishing.',
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
