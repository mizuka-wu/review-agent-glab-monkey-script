#!/bin/bash
# GitLab 测试容器管理
# 用法: ./scripts/gitlab.sh <命令>

COMPOSE_FILE="docker-compose.gitlab.yml"
URL="http://localhost:8929"

case "${1:-help}" in
  start|s)
    docker compose -f "$COMPOSE_FILE" up -d
    echo "等待 GitLab 就绪 (首次启动需 2-5 分钟)..."
    for i in $(seq 1 60); do
      if curl -sf "$URL/-/readiness" > /dev/null 2>&1; then
        echo "✅ GitLab 已就绪 → $URL (root / 5iveRage)"
        exit 0
      fi
      sleep 5
    done
    echo "⚠️  启动超时，查看日志: $0 logs"
    exit 1
    ;;
  stop)
    docker compose -f "$COMPOSE_FILE" down && echo "✅ 已停止"
    ;;
  restart)
    docker compose -f "$COMPOSE_FILE" restart && echo "✅ 已重启"
    ;;
  ps|status)
    docker compose -f "$COMPOSE_FILE" ps
    ;;
  logs)
    docker compose -f "$COMPOSE_FILE" logs -f "${@:2}"
    ;;
  reset)
    echo "⚠️  将删除所有数据卷（项目、MR、用户全部清空）"
    read -p "确认？(y/N) " -n 1 -r; echo
    [[ $REPLY =~ ^[Yy]$ ]] && docker compose -f "$COMPOSE_FILE" down -v && echo "✅ 已重置"
    ;;
  root-password)
    # 重置 root 密码
    NEW_PASS="${2:-5iveRage}"
    docker compose -f "$COMPOSE_FILE" exec -T gitlab gitlab-rake "gitlab:password:reset[root]" <<< "$NEW_PASS
$NEW_PASS" 2>&1 | tail -3
    ;;
  pat)
    # 生成 root PAT (需要 gitlab-rails)
    TOKEN_NAME="${2:-e2e-token}"
    docker compose -f "$COMPOSE_FILE" exec -T gitlab gitlab-rails runner "
      token = User.find_by_username('root').personal_access_tokens.create(scopes: ['api'], name: '$TOKEN_NAME', expires_at: 30.days.from_now)
      token.set_token('glpat-e2e-test-token-1234567890')
      token.save!
      puts 'glpat-e2e-test-token-1234567890'
    " 2>&1 | tail -1
    ;;
  create-project)
    # 创建测试项目
    NAME="${2:-test-project}"
    docker compose -f "$COMPOSE_FILE" exec -T gitlab gitlab-rails runner "
      token = 'glpat-e2e-test-token-1234567890'
      user = User.find_by_username('root')
      project = Projects::CreateService.new(user, name: '$NAME', path: '$NAME', visibility_level: 20, initialize_with_readme: true).execute
      puts project.full_path
    " 2>&1 | tail -1
    ;;
  health)
    curl -sf "$URL/-/readiness" && echo " ✅ healthy" || echo "❌ unhealthy"
    ;;
  url)
    echo "$URL"
    ;;
  help|*)
    cat <<EOF
GitLab 测试容器管理

用法: $0 <命令>

容器管理:
  start, s       启动并等待就绪
  stop           停止容器
  restart        重启容器
  ps, status     查看状态
  logs [args]    查看日志 (可加 -f 实时)
  reset          删除所有数据重置
  health         健康检查

测试辅助:
  root-password [密码]    重置 root 密码 (默认 5iveRage)
  pat [名称]              生成 root PAT (固定: glpat-e2e-test-token-1234567890)
  create-project [名称]   创建测试项目
  url                     打印访问地址

E2E 测试:
  GITLAB_URL=\$($0 url) GITLAB_PAT=glpat-e2e-test-token-1234567890 \\
  GITLAB_MR_URL=\$($0 url)/<project>/-/merge_requests/<id>/diffs \\
  pnpm test:e2e
EOF
    ;;
esac
