#!/usr/bin/env bash
# 用 --remote-debugging-port=9222 启动 Chrome
# quota-dashboard「我已授权 · 保存会话」通过 Chrome DevTools 协议读取本机已登录会话，
# 因此需要 Chrome 以调试端口启动（一次性；之后每次点保存会话都能直接读取）。
set -e
PORT="${CHROME_DEBUG_PORT:-9222}"

if curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "✅ Chrome 调试端口 $PORT 已在运行，直接回到看板点「我已授权 · 保存会话」即可。"
  exit 0
fi

echo "将要关闭现有 Chrome 窗口并用调试端口 $PORT 重启（请先保存浏览器里未完成的工作）。"
read -r -p "继续？(y/N) " ans
case "$ans" in
  y|Y) ;;
  *) echo "已取消。"; exit 0 ;;
esac

# 关闭现有 Chrome（仅桌面 Chrome；不会动其它程序）
pkill -f 'google-chrome' 2>/dev/null || true
sleep 2

nohup google-chrome --remote-debugging-port="$PORT" >/dev/null 2>&1 &
sleep 3

if curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "✅ Chrome 已用调试端口 $PORT 启动。回到看板，打开你要登录的平台 → 点「我已授权 · 保存会话」。"
else
  echo "⚠️ 自动启动似乎失败，请手动运行：google-chrome --remote-debugging-port=$PORT"
fi
