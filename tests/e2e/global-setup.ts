import { execFileSync } from 'node:child_process';

export default function globalSetup() {
  const isRealGitlab = Boolean(process.env.GITLAB_URL && process.env.GITLAB_MR_URL);
  console.log(isRealGitlab
    ? `[E2E] 真实 GitLab 模式: ${process.env.GITLAB_MR_URL}`
    : '[E2E] Mock 模式');
  execFileSync('pnpm', ['build'], { stdio: 'inherit' });
}
