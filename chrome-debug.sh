#!/usr/bin/env bash
# 启动一个带调试端口的 Chrome「副本」，供 quota-dashboard「我已授权 · 保存会话」通过 CDP 读取已登录会话。
# 为什么用副本：新版 Chrome 禁止「默认数据目录 + 调试端口」；用独立数据目录即可开调试端口，
# 而登录 cookie 由系统钥匙串（v11）解密，副本里照样能读到你的登录态，不影响日常浏览器。
set -e
PORT="${CHROME_DEBUG_PORT:-9222}"
SRC="$HOME/.config/google-chrome"
DST="${CHROME_DEBUG_PROFILE:-$HOME/.cache/quota-dashboard/chrome-debug}"

if curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "✅ Chrome 调试端口 $PORT 已在运行，直接回看板点「我已授权 · 保存会话」即可。"
  exit 0
fi

echo "正在把当前浏览器会话同步到调试副本 $DST …"
echo "（首次约几十秒，之后每次增量很快；不影响你正在用的 Chrome）"
mkdir -p "$DST"

# 排除大缓存，只同步登录/会话相关数据（Cookies、Preferences 等很小）
rsync -a --delete \
  --exclude 'Cache/' --exclude 'Code Cache/' --exclude 'GPUCache/' \
  --exclude 'Service Worker/' --exclude 'IndexedDB/' \
  --exclude 'Local Storage/' --exclude 'WebStorage/' \
  --exclude 'screen_ai/' --exclude 'component_crx_cache/' \
  --exclude 'optimization_guide_model_store/' \
  --exclude 'Crash Reports/' --exclude 'Singleton*' --exclude '*.log' \
  "$SRC/" "$DST/" 2>/dev/null || cp -a "$SRC/." "$DST/"

echo "启动调试 Chrome（端口 $PORT）…"
nohup google-chrome --user-data-dir="$DST" --remote-debugging-port="$PORT" --remote-allow-origins='*' >/dev/null 2>&1 &
sleep 3

if curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "✅ 调试 Chrome 已启动（端口 $PORT）。回到看板 → 打开对应平台 → 点「我已授权 · 保存会话」。"
else
  echo "⚠️ 自动启动失败，请手动运行："
  echo "   google-chrome --user-data-dir=$DST --remote-debugging-port=$PORT"
fi
