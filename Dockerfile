# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY server server
COPY web web
RUN npm run build && npm test && npm run smoke -w @berrie/server

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --no-audit --no-fund -w @berrie/server

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data CONFIG_PATH=/config/berrie.config.json WEB_DIST=/app/web/dist BIND_HOST=0.0.0.0 PORT=4780
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY server/package.json server/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4780
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4780/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/main.js"]
