/**
 * Local GitLab Setup for E2E Testing
 * 
 * This script starts a GitLab Docker container if:
 * 1. TEST_MODE=local-gitlab is set
 * 2. GitLab is not already running on port 8443
 * 
 * Usage:
 *   TEST_MODE=local-gitlab pnpm test:e2e
 * 
 * Commands:
 *   docker-compose -f .gitlab-test-docker-compose.yml up -d  # 启动
 *   docker-compose -f .gitlab-test-docker-compose.yml down    # 关闭
 *   docker-compose -f .gitlab-test-docker-compose.yml logs -f  # 查看日志
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const GITLAB_COMPOSE = resolve(process.cwd(), 'docker-compose.gitlab.yml');
const LOCAL_TEST_URL = 'http://localhost:8929';

export default function globalSetup() {
  const testMode = process.env.TEST_MODE;
  
  // 只在 local-gitlab 模式下启动
  if (testMode !== 'local-gitlab') {
    console.log('[Local GitLab] 跳过（TEST_MODE !== local-gitlab）');
    return;
  }

  // 检查配置
  if (!existsSync(GITLAB_COMPOSE)) {
    throw new Error(`[Local GitLab] 找不到 ${GITLAB_COMPOSE}`);
  }
  
  // 检查是否已运行
  try {
    execSync(`curl -f -s ${LOCAL_TEST_URL}/health > /dev/null 2>&1`, { 
      stdio: 'ignore' 
    });
    console.log('[Local GitLab] 已检测到运行中的 GitLab 实例');
    console.log(`[Local GitLab] 访问地址：${LOCAL_TEST_URL}`);
    console.log(`[Local GitLab] 默认登录：root / 5iveRage`);
    return;
  } catch (e) {
    // GitLab 未运行，继续启动流程
  }

  console.log('[Local GitLab] 启动 GitLab 容器...');
  
  try {
    execSync(`docker-compose -f ${GITLAB_COMPOSE} up -d`, {
      stdio: 'inherit',
      env: { ...process.env, GITLAB_LICENSE: '' }
    });
    
    // 等待健康检查
    console.log('[Local GitLab] 等待容器就绪（可能需要 1-3 分钟）...');
    await waitForHealth(LOCAL_TEST_URL, 180);
    
    console.log('\n✅ [Local GitLab] GitLab 测试实例已就绪');
    console.log(`   访问：${LOCAL_TEST_URL}`);
    console.log('   默认账户：root / 5iveRage');
    console.log('   关闭：docker-compose -f .gitlab-test-docker-compose.yml down\n');
    
  } catch (error) {
    console.error('[Local GitLab] 启动失败:', error);
    throw new Error('Failed to start GitLab container');
  }
}

async function waitForHealth(url: string, maxAttempts: number = 180) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execSync(`curl -f -s ${url}/health > /dev/null 2>&1`, {
        stdio: 'ignore'
      });
      return;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('GitLab health check timeout');
}

export async function teardown() {
  const testMode = process.env.TEST_MODE;
  if (testMode === 'local-gitlab') {
    try {
      console.log('\n[Local GitLab] 清理容器...');
      execSync(`docker-compose -f ${GITLAB_COMPOSE} down`, {
        stdio: 'inherit'
      });
      console.log('[Local GitLab] 已清理\n');
    } catch (e) {
      console.warn('[Local GitLab] 清理失败:', e);
    }
  }
}
