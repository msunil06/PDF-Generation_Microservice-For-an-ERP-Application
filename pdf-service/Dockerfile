FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev --ignore-scripts

FROM node:20-bookworm-slim AS production

RUN apt-get update && apt-get install -y \
    chromium \
    chromium-sandbox \
    fonts-freefont-ttf \
    fonts-noto \
    fonts-noto-cjk \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules

COPY . .

RUN groupadd -r pdfuser && useradd -r -g pdfuser -d /app pdfuser \
    && chown -R pdfuser:pdfuser /app

USER pdfuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "src/index.js"]
