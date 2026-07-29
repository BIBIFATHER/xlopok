# Next.js (standalone) для самохостинга на РФ-хостинге (Timeweb Cloud / Yandex / VPS).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Переменные окружения задаются в панели хостинга и приходят в контейнер
# в рантайме — прокидывать их через ARG не нужно.
# BITRIX24_WEBHOOK_URL сюда НЕ прокидываем через ARG: вебхук даёт полный доступ
# к CRM, а ARG/ENV сохранили бы его в слоях образа (виден в `docker history`).
# Задаётся переменной окружения контейнера в панели хостинга — читается
# в рантайме, в образ не попадает.
# Проверка после деплоя: GET /api/lead → {"bitrix":"configured"}
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
