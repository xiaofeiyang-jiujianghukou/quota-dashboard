#!/usr/bin/env bash
# AI 套餐余量看板 —— 安全的启动/停止/重启脚本
#
# 重要：本脚本【绝不删除】data/chrome-profile（授权登录态存放处）。
#       重启采用「SIGTERM 优雅退出」→ 等 Chrome 把 Cookie 落盘 → 再启动，
#       所以重启不会导致授权失效。
#
# 用法：
#   ./run.sh start     启动（后台常驻，日志 data/server.log）
#   ./run.sh stop      优雅停止
#   ./run.sh restart   优雅重启（默认）
#   ./run.sh status    查看状态（含授权配置目录是否保留）
#   ./run.sh log       跟踪日志
set -uo pipefail
cd "$(dirname "$0")"

PORT="${QUOTA_PORT:-8899}"
PROFILE="${QUOTA_CHROME_PROFILE:-$PWD/data/chrome-profile}"
LOG="$PWD/data/server.log"

pid_on_port() {
  ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | head -1
}

do_start() {
  if [ -n "$(pid_on_port)" ]; then
    echo "已在运行（PID $(pid_on_port)，端口 ${PORT}）"
    return 0
  fi
  mkdir -p data
  setsid nohup node server.js >> "$LOG" 2>&1 &
  sleep 3
  if [ -n "$(pid_on_port)" ]; then
    echo "✅ 已启动：http://127.0.0.1:${PORT}  (PID $(pid_on_port))"
  else
    echo "❌ 启动失败，请看日志：tail -20 $LOG"
    return 1
  fi
}

do_stop() {
  local pid; pid="$(pid_on_port)"
  if [ -z "$pid" ]; then
    echo "未在运行"
    return 0
  fi
  # 优雅退出：服务会先关闭授权浏览器（保存登录态），再退出
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 20); do
    [ -z "$(pid_on_port)" ] && break
    sleep 0.5
  done
  if [ -n "$(pid_on_port)" ]; then
    echo "⚠️ 优雅退出超时，强制结束（授权配置仍不会删除）"
    kill -9 "$(pid_on_port)" 2>/dev/null
  fi
  echo "已停止"
}

do_status() {
  local pid; pid="$(pid_on_port)"
  echo "服务端口 ${PORT}: ${pid:-未运行}"
  if [ -d "$PROFILE" ]; then
    echo "授权配置目录: $PROFILE （存在 ✔ 登录态保留）"
    echo "  最近修改: $(date -r "$PROFILE" '+%F %T' 2>/dev/null || echo '-')"
  else
    echo "授权配置目录: $PROFILE （尚未创建，首次授权时自动建立）"
  fi
}

case "${1:-restart}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  log)     tail -f "$LOG" ;;
  *) echo "用法: $0 {start|stop|restart|status|log}"; exit 1 ;;
esac
