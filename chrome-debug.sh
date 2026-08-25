#!/usr/bin/env bash
# 启动带调试端口的 Chrome 副本（只复制登录相关的小文件，秒级完成，不影响日常浏览器）
set -u
PORT="${CHROME_DEBUG_PORT:-9222}"
SRC="$HOME/.config/google-chrome"
DST="${CHROME_DEBUG_PROFILE:-$HOME/.cache/quota-dashboard/chrome-debug}"

if curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "✅ 调试端口 $PORT 已在运行，直接回看板点「我已授权 · 保存会话」。"
  exit 0
fi

echo "同步登录会话到副本 $DST …"
mkdir -p "$DST/Default/Network"
for f in \
  'Local State' \
  'Default/Cookies' \
  'Default/Network/Cookies' \
  'Default/Preferences' \
  'Default/Secure Preferences' \
  'Default/Bookmarks' ; do
  if [ -f "$SRC/$f" ]; then
    cp -f "$SRC/$f" "$DST/$f" && echo "  ✓ $f" || echo "  ✗ $f（复制失败）"
  else
    echo "  · $f（源不存在，跳过）"
  fi
done

echo "启动调试 Chrome（端口 $PORT）…"
nohup google-chrome --user-data-dir="$DST" --remote-debugging-port="$PORT" --remote-allow-origins='*' --no-first-run --no-default-browser-check >/tmp/chrome-debug.log 2>&1 &
sleep 4

if curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "✅ 调试 Chrome 已启动（端口 $PORT）。回到看板 → 「我已授权 · 保存会话」。"
else
  echo "⚠️ 启动失败。日志 /tmp/chrome-debug.log 末尾："
  tail -8 /tmp/chrome-debug.log 2>/dev/null || true
  echo ""
  echo "可手动运行：google-chrome --user-data-dir=$DST --remote-debugging-port=$PORT"
fi
