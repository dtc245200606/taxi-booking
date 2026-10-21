# ---- Stage 1: cài thư viện ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && node -e "require('express'); require('pg'); require('prom-client')" \
 && npm cache clean --force

# ---- Stage 2: image chạy thật (nhỏ gọn, không chạy bằng root) ----
FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src
COPY --chown=root:root public ./public
# Mã nguồn thuộc root và chỉ đọc; tiến trình chạy bằng user "node" (UID 1000)
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "src/server.js"]
