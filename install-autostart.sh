#!/usr/bin/env bash
# 一键安装/卸载「开机自启」：把看板注册为 systemd 用户服务
#
#   ./install-autostart.sh            安装并立即启动（并设置开机自启 + 免登录常驻）
#   ./install-autostart.sh --uninstall  卸载（停止并移除自启）
#
# 说明：
#   - 用「用户级服务」而不是系统服务：看板要以你的身份运行，官网授权时才能弹出你的浏览器窗口
#   - 开启 linger 后，即使没登录桌面也会在开机时自动启动
#   - 服务【绝不删除】data/chrome-profile（授权登录态），重启不会导致授权失效
set -uo pipefail
cd "$(dirname "$0")"
PROJECT_DIR="$PWD"
NODE_BIN="$(command -v node || true)"
SERVICE_NAME="quota-dashboard.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$SERVICE_NAME"
PORT="${QUOTA_PORT:-8899}"

if [ -z "$NODE_BIN" ]; then
  echo "❌ 找不到 node，请先安装 Node.js（建议 v22+）"
  exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl --user daemon-reload 2>/dev/null || true
  loginctl disable-linger "$USER" 2>/dev/null || true
  echo "✅ 已卸载开机自启（$SERVICE_NAME）"
  exit 0
fi

# 停掉手动启动的实例，避免端口冲突
if [ -x "$PROJECT_DIR/run.sh" ]; then
  "$PROJECT_DIR/run.sh" stop >/dev/null 2>&1 || true
fi

mkdir -p "$UNIT_DIR" "$PROJECT_DIR/data"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=AI 套餐余量看板（quota-dashboard）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_BIN server.js
# 官网授权需要弹出本机浏览器窗口，因此带上图形环境变量
Environment=DISPLAY=${DISPLAY:-:0}
Environment=XAUTHORITY=${XAUTHORITY:-/run/user/$(id -u)/gdm/Xauthority}
Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=5
StandardOutput=append:$PROJECT_DIR/data/server.log
StandardError=append:$PROJECT_DIR/data/server.log

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

# 免登录常驻：开机即启动，不依赖桌面登录
loginctl enable-linger "$USER" 2>/dev/null || true

sleep 3
if systemctl --user is-active --quiet "$SERVICE_NAME"; then
  echo "✅ 已启动：http://127.0.0.1:${PORT}"
else
  echo "⚠️ 服务未处于运行状态，最近日志："
  systemctl --user --no-pager status "$SERVICE_NAME" | tail -12
  exit 1
fi

echo
echo "开机自启：$(systemctl --user is-enabled "$SERVICE_NAME" 2>/dev/null || echo unknown)"
echo "常驻模式：$(loginctl show-user "$USER" --property=Linger 2>/dev/null || echo Linger=unknown)"
echo "服务单元：$UNIT_PATH"
echo
echo "常用命令："
echo "  systemctl --user status  quota-dashboard     # 查看状态"
echo "  systemctl --user restart quota-dashboard     # 重启（不影响授权）"
echo "  systemctl --user stop    quota-dashboard     # 停止"
echo "  journalctl --user -u quota-dashboard -f      # 实时日志"
echo "  ./install-autostart.sh --uninstall           # 取消开机自启"
