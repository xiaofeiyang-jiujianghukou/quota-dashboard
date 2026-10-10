# AI 套餐余量看板 — 零客户端依赖，镜像保持轻量（不打包浏览器）
# 自动登录使用「本机默认浏览器」：本地运行直接开浏览器；
# Docker 部署时用宿主机上的 login-helper.mjs 抓取会话并提交给看板。
FROM node:22-bookworm-slim

# wecom-cli（Rust 二进制）需要系统 CA 证书
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 微信提醒所需的 wecom-cli（企业微信机器人通道）；装失败不影响看板主体
RUN npm install -g @wecom/cli 2>/dev/null || echo "wecom-cli 安装失败（微信提醒不可用，其余功能正常）"

# 应用代码 + 依赖
COPY package.json ./
RUN npm install 2>/dev/null || echo "npm install 失败（其余功能正常）"

# 内置无头浏览器：配置页「官网授权」在面板内完成（实时截图 + 扫码/输入），无需宿主机任何助手
RUN npx playwright install --with-deps chromium 2>/dev/null || echo "chromium 安装失败（面板内授权不可用，可改用手动粘贴）"
ENV QUOTA_LOGIN_MODE=container
COPY lib ./lib
COPY providers ./providers
COPY public ./public
COPY server.js ./
COPY login-helper.mjs ./
COPY config.example.json ./

# 运行时状态目录（提醒去重状态等）
RUN mkdir -p /app/data

ENV HOST=0.0.0.0
ENV TZ=Asia/Shanghai
EXPOSE 8899

CMD ["node", "server.js"]
