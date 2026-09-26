#!/bin/bash
# GitLab 测试容器管理

COMPOSE_FILE="docker-compose.gitlab.yml"
URL="http://localhost:8929"

show_status() {
  local status
  status=$(docker compose -f "$COMPOSE_FILE" ps --format "{{.Status}}" 2>/dev/null | head -1)
  if [[ "$status" == *"Up"* ]]; then
    local http_code
    http_code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/-/readiness" 2>/dev/null || echo "000")
    if [ "$http_code" = "200" ]; then
      echo "  状态: ✅ 运行中 · 就绪"
    elif [ "$http_code" = "000" ]; then
      echo "  状态: ⏳ 运行中 · 无法连接"
    else
      echo "  状态: ⏳ 运行中 · 启动中 (HTTP $http_code)"
    fi
  else
    echo "  状态: ⬛ 未运行"
  fi
  echo "  地址: $URL"
}

do_start() {
  docker compose -f "$COMPOSE_FILE" up -d
  echo "等待 GitLab 就绪 (首次启动可能需要 5-10 分钟)..."
  local elapsed=0
  local max_wait=900
  while [ $elapsed -lt $max_wait ]; do
    local http_code
    http_code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/-/readiness" 2>/dev/null || echo "000")
    if [ "$http_code" = "200" ]; then
      echo ""
      echo "✅ GitLab 已就绪 → $URL (root / 5iveRage)"
      return 0
    fi
    printf "\r  ⏳ 启动中... %ds (HTTP %s) " "$elapsed" "$http_code"
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo ""
  echo "⚠️  等待超时 (${max_wait}s)，查看日志: docker compose -f $COMPOSE_FILE logs -f"
  return 1
}

do_pat() {
  echo "生成 root PAT..."
  docker compose -f "$COMPOSE_FILE" exec -T gitlab gitlab-rails runner "
    token = User.find_by_username('root').personal_access_tokens.create(scopes: ['api'], name: 'e2e', expires_at: 30.days.from_now)
    token.set_token('glpat-e2e-test-token-1234567890')
    token.save!
    puts 'glpat-e2e-test-token-1234567890'
  " 2>&1 | tail -1
}

do_create_project() {
  read -p "项目名称 (默认 test-project): " name
  name="${name:-test-project}"
  echo "创建项目 $name ..."
  docker compose -f "$COMPOSE_FILE" exec -T gitlab gitlab-rails runner "
    user = User.find_by_username('root')
    project = Projects::CreateService.new(user, name: '$name', path: '$name', visibility_level: 20, initialize_with_readme: true).execute
    puts project.full_path
  " 2>&1 | tail -1
}

do_root_password() {
  read -p "新密码 (默认 5iveRage): " pass
  pass="${pass:-5iveRage}"
  docker compose -f "$COMPOSE_FILE" exec -T gitlab gitlab-rake "gitlab:password:reset[root]" <<< "$pass
$pass" 2>&1 | tail -3
}

# 主菜单
while true; do
  clear
  echo "╔══════════════════════════════════╗"
  echo "║     GitLab 测试容器管理           ║"
  echo "╚══════════════════════════════════╝"
  echo
  show_status
  echo
  echo "  1) 启动"
  echo "  2) 停止"
  echo "  3) 重启"
  echo "  4) 查看日志"
  echo "  5) 重置数据 (清空全部)"
  echo "  ─────────────────────────"
  echo "  6) 生成 PAT"
  echo "  7) 创建测试项目"
  echo "  8) 重置 root 密码"
  echo "  ─────────────────────────"
  echo "  9) 显示 E2E 测试命令"
  echo "  0) 退出"
  echo
  read -p "选择 [0-9]: " choice

  case $choice in
    1) do_start; read -p "按回车继续..." ;;
    2) docker compose -f "$COMPOSE_FILE" down && echo "✅ 已停止"; read -p "按回车继续..." ;;
    3) docker compose -f "$COMPOSE_FILE" restart && echo "✅ 已重启"; read -p "按回车继续..." ;;
    4) docker compose -f "$COMPOSE_FILE" logs -f; ;;
    5) read -p "确认删除所有数据？(y/N) " -n 1 -r; echo
       [[ $REPLY =~ ^[Yy]$ ]] && docker compose -f "$COMPOSE_FILE" down -v && echo "✅ 已重置"
       read -p "按回车继续..." ;;
    6) do_pat; read -p "按回车继续..." ;;
    7) do_create_project; read -p "按回车继续..." ;;
    8) do_root_password; read -p "按回车继续..." ;;
    9) echo
       echo "GITLAB_URL=$URL \\"
       echo "GITLAB_PAT=glpat-e2e-test-token-1234567890 \\"
       echo "GITLAB_MR_URL=$URL/<project>/-/merge_requests/<id>/diffs \\"
       echo "pnpm test:e2e"
       read -p "按回车继续..." ;;
    0) exit 0 ;;
  esac
done
