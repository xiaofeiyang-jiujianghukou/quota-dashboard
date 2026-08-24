# AI 套餐余量看板 — 零客户端依赖
# 基础镜像用 debian-slim（wecom-cli 的 linux-x64 二进制是 glibc，alpine/musl 跑不了）
FROM node:22-bookworm-slim

# wecom-cli（Rust 二进制）需要系统 CA 证书，否则 TLS 初始化直接 panic
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 微信提醒所需的 wecom-cli（企业微信机器人通道）；装失败不影响看板主体
RUN npm install -g @wecom/cli 2>/dev/null || echo "wecom-cli 安装失败（微信提醒不可用，其余功能正常）"

# 应用代码
COPY package.json ./
COPY lib ./lib
COPY providers ./providers
COPY public ./public
COPY server.js ./
COPY config.example.json ./

# 运行时状态目录（提醒去重状态等）
RUN mkdir -p /app/data

ENV HOST=0.0.0.0
ENV TZ=Asia/Shanghai
EXPOSE 8899

CMD ["node", "server.js"]
