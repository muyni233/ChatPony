FROM oven/bun:1.3.14 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN bun run build

FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/chatpony.db \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/.next ./.next
COPY --from=build --chown=bun:bun /app/public ./public
COPY --from=build --chown=bun:bun /app/package.json /app/bun.lock /app/next.config.ts /app/tsconfig.json ./
COPY --from=build --chown=bun:bun /app/src/lib ./src/lib
COPY --from=build --chown=bun:bun /app/scripts ./scripts
RUN mkdir -p /app/data /app/.next/cache && chown -R bun:bun /app/data /app/.next/cache
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "const response = await fetch('http://127.0.0.1:3000/api/bootstrap'); process.exit(response.ok ? 0 : 1)"
CMD ["bun", "--bun", "next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
