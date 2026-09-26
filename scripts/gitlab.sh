#!/bin/bash
# GitLab 测试容器管理
# 用法: ./scripts/gitlab.sh

COMPOSE_FILE="docker-compose.gitlab.yml"
URL="http://127.0.0.1:8929"
PASS="5iveRage"
PAT="glpat-e2e-test-token-1234567890"

get_status() {
  curl -s --connect-timeout 3 -o /dev/null -w '%{http_code}' "$URL/users/sign_in" 2>/dev/null
}

do_start() {
  local code
  code=$(get_status)
  if [ "$code" = "200" ]; then
    echo "✅ GitLab 已在运行 → $URL"
    return 0
  fi
  docker compose -f "$COMPOSE_FILE" up -d 2>&1 | tail -3
  echo "等待 GitLab 就绪..."
  for i in $(seq 1 180); do
    code=$(get_status)
    if [ "$code" = "200" ]; then
      echo ""
      echo "✅ GitLab 已就绪"
      echo "   地址: $URL"
      echo "   账号: root  （密码选 8 获取）"
      return 0
    fi
    printf "\r  ⏳ %ds (HTTP %s)" $((i*5)) "$code"
    sleep 5
  done
  echo ""
  echo "❌ 超时，查看日志: $0 → 4) 查看日志"
  return 1
}

do_pat() {
  echo "生成 root PAT..."
  docker compose -f "$COMPOSE_FILE" exec -T gitlab gitlab-rails runner "
    u = User.find_by_username('root')
    t = u.personal_access_tokens.create(scopes: ['api'], name: 'e2e', expires_at: 365.days.from_now)
    t.set_token('$PAT')
    t.save!
    puts 'ok'
  " 2>&1 | tail -1
  echo "PAT: $PAT"
}

do_project() {
  local name="${1:-test-project}"
  echo "创建项目 $name ..."
  docker compose -f "$COMPOSE_FILE" exec -T gitlab gitlab-rails runner "
    u = User.find_by_username('root')
    p = Projects::CreateService.new(u, name: '$name', path: '$name', visibility_level: 20, initialize_with_readme: true).execute
    puts p.full_path
  " 2>&1 | tail -1
}

do_reset_password() {
  docker compose -f "$COMPOSE_FILE" exec -T gitlab gitlab-rake "gitlab:password:reset[root]" <<< "$PASS
$PASS" 2>&1 | tail -3
}

do_get_password() {
  echo "获取 root 密码..."
  local pass
  pass=$(docker compose -f "$COMPOSE_FILE" exec -T gitlab cat /etc/gitlab/initial_root_password 2>/dev/null | grep -oP 'Password: \K\S+' | tr -d '\r\n')
  if [ -n "$pass" ]; then
    echo "root 密码: $pass"
    return 0
  fi
  pass=$(docker compose -f "$COMPOSE_FILE" logs 2>&1 | grep -oP 'Password: \K\S+' | tail -1)
  if [ -n "$pass" ]; then
    echo "root 密码: $pass"
    return 0
  fi
  echo "未找到密码，尝试重置..."
  do_reset_password
}

while true; do
  clear
  echo "╔══════════════════════════════════════╗"
  echo "║       GitLab 测试容器管理             ║"
  echo "╚══════════════════════════════════════╝"
  echo
  code=$(get_status)
  if [ "$code" = "200" ]; then
    echo "  状态: ✅ 就绪"
  elif [ "$code" = "000" ]; then
    echo "  状态: ⬛ 未运行"
  else
    echo "  状态: ⏳ 启动中 (HTTP $code)"
  fi
  echo "  地址: $URL"
  echo "  账号: root  （密码选 8 获取）"
  echo "  PAT:  $PAT"
  echo
  echo "  1) 启动 / 等待就绪"
  echo "  2) 停止"
  echo "  3) 重启"
  echo "  4) 查看日志"
  echo "  5) 重置数据"
  echo "  ─────────────────────"
  echo "  6) 生成 PAT"
  echo "  7) 创建项目"
  echo "  8) 获取 root 密码"
  echo "  9) 重置 root 密码"
  echo "  ─────────────────────"
  echo "  10) 显示 E2E 命令"
  echo "  0) 退出"
  echo
  read -p "选择 [0-10]: " c
  case $c in
    1) do_start; read -p "回车继续..." ;;
    2) docker compose -f "$COMPOSE_FILE" down; read -p "回车继续..." ;;
    3) docker compose -f "$COMPOSE_FILE" restart; read -p "回车继续..." ;;
    4) docker compose -f "$COMPOSE_FILE" logs -f ;;
    5) read -p "确认清空数据？(y/N) " -n 1 -r; echo
       [[ $REPLY =~ ^[Yy]$ ]] && docker compose -f "$COMPOSE_FILE" down -v
       read -p "回车继续..." ;;
    6) do_pat; read -p "回车继续..." ;;
    7) read -p "项目名 (默认 test-project): " n
       do_project "${n:-test-project}"; read -p "回车继续..." ;;
    8) do_get_password; read -p "回车继续..." ;;
    9) do_reset_password; read -p "回车继续..." ;;
    10) echo
       echo "GITLAB_URL=$URL \\"
       echo "GITLAB_MR_URL=$URL/<项目>/-/merge_requests/<id>/diffs \\"
       echo "pnpm test:e2e"
       echo ""
       echo "（通过浏览器 Cookie 认证，无需 PAT）"
       read -p "回车继续..." ;;
    0) exit 0 ;;
  esac
done
