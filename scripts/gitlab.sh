#!/bin/bash
# GitLab 测试容器管理
# 用法: ./scripts/gitlab.sh [start|stop|ps|logs]

COMPOSE_FILE="docker-compose.gitlab.yml"

case "${1:-start}" in
  start|s)
    echo "启动 GitLab 测试容器..."
    docker compose -f "$COMPOSE_FILE" up -d
    echo "等待 GitLab 就绪 (首次启动需 2-5 分钟)..."
    for i in $(seq 1 60); do
      if curl -sf http://localhost:8929/-/readiness > /dev/null 2>&1; then
        echo "✅ GitLab 已就绪 → http://localhost:8929 (root / 5iveRage)"
        exit 0
      fi
      sleep 5
    done
    echo "⚠️  启动超时，查看日志: $0 logs"
    exit 1
    ;;
  stop|st)
    docker compose -f "$COMPOSE_FILE" down && echo "✅ 已停止" || echo "❌ 停止失败"
    ;;
  ps|status)
    docker compose -f "$COMPOSE_FILE" ps
    ;;
  logs)
    docker compose -f "$COMPOSE_FILE" logs -f
    ;;
  *)
    echo "用法：$0 [start|stop|ps|logs]"
    ;;
esac
