import { defineConfig, devices } from '@playwright/test';

const testMode = process.env.TEST_MODE || 'mock';
const isLocalGitlab = testMode === 'local-gitlab';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: isLocalGitlab
    ? './tests/e2e/local-gitlab-setup.ts'
    : './tests/e2e/global-setup.ts',
  timeout: isLocalGitlab ? 60_000 : 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
