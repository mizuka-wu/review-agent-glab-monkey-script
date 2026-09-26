#!/bin/bash
# GitLab 测试容器管理

COMPOSE_FILE="docker-compose.gitlab.yml"

case "${1:-start}" in
  start|s)
    docker-compose -f "$COMPOSE_FILE" up -d && echo "✅ GitLab 容器已启动 (http://localhost:8929)" || echo "❌ 启动失败"
    ;;
  stop|st)
    docker-compose -f "$COMPOSE_FILE" down && echo "✅ GitLab 容器已停止" || echo "❌ 停止失败"
    ;;
  ps|status)
    docker-compose -f "$COMPOSE_FILE" ps
    ;;
  logs)
    docker-compose -f "$COMPOSE_FILE" logs -f
    ;;
  *)
    echo "用法：$0 [start|stop|ps|logs]"
    ;;
esac
