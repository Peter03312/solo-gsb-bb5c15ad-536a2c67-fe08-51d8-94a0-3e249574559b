# 听证会逐字稿网页校订台 —— Docker 镜像
# better-sqlite3 为原生模块：此处从源码编译（需 python3/make/g++），
# 运行镜像仅保留最小运行时，数据库落在挂载卷中。

FROM node:20-bookworm-slim AS build
WORKDIR /app

# 原生模块编译工具链
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --build-from-source better-sqlite3

# ---------- 运行镜像 ----------
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV HOST=0.0.0.0
ENV PORT=3000

# 非 root 用户运行；数据目录可挂载
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -u 10001 appuser \
  && mkdir -p /data && chown -R appuser:appuser /data

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY sample-transcript.txt ./

# 容器启动时 openDb() 会幂等建表并写入种子账户；数据落在 /data 卷中

USER appuser
VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
