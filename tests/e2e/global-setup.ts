import { execFileSync } from 'node:child_process';

export default function globalSetup() {
  const testMode = process.env.TEST_MODE || 'mock';

  if (testMode === 'local-gitlab') {
    console.log('[E2E] 使用真实 GitLab 容器（TEST_MODE=local-gitlab）');
    execFileSync('pnpm', ['build'], { stdio: 'inherit' });
    return;
  }

  console.log('[E2E] 使用 Mock GitLab 响应（TEST_MODE=mock）');
  execFileSync('pnpm', ['build'], { stdio: 'inherit' });
}
