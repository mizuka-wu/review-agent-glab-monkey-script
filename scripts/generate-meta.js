import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('dist/review-agent-glab-monkey-script.user.js', 'utf8');
const meta = src.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
if (meta) {
  writeFileSync('dist/review-agent-glab-monkey-script.meta.js', meta[0] + '\n');
  console.log('Generated dist/review-agent-glab-monkey-script.meta.js');
} else {
  console.error('Could not find UserScript metadata block');
  process.exit(1);
}
