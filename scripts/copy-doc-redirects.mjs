import { copyFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve(import.meta.dirname, '../docs-site/public');
const target = resolve(import.meta.dirname, '../docs-site/.vitepress/dist');
if (!existsSync(target)) mkdirSync(target, { recursive: true });
let count = 0;
for (const file of readdirSync(source)) {
  if (!file.endsWith('.html')) continue;
  copyFileSync(resolve(source, file), resolve(target, file));
  count += 1;
}
console.log(`Copied ${count} redirect page(s) into docs dist`);
