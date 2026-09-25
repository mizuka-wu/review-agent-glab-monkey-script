import { execFileSync } from 'node:child_process';

export default function globalSetup() {
  execFileSync('pnpm', ['build'], { stdio: 'inherit' });
}
