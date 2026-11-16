# Stage 1: Build Vue 3 + Vite static bundle
FROM oven/bun:1-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
RUN bun run build

# Stage 2: Build Rust backend & CLI binaries
FROM rust:slim-bookworm AS backend
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/Cargo.toml backend/Cargo.lock ./
# Cache dependencies before copying source
RUN mkdir -p src/bin \
  && echo 'fn main() {}' > src/main.rs \
  && echo 'fn main() {}' > src/bin/create_admin.rs \
  && echo 'fn main() {}' > src/bin/backup.rs \
  && cargo build --release \
  && rm -rf src
COPY backend/ ./
RUN touch src/main.rs src/lib.rs && cargo build --release --bins

# Stage 3: Minimal Debian runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 tzdata wget \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN mkdir -p /app/data /app/static
COPY --from=backend /app/backend/target/release/chatpony /usr/local/bin/chatpony
COPY --from=backend /app/backend/target/release/create-admin /usr/local/bin/create-admin
COPY --from=backend /app/backend/target/release/backup /usr/local/bin/backup
COPY --from=frontend /app/frontend/dist /app/static

ENV HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/chatpony.db \
    CHATPONY_STATIC_DIR=/app/static \
    RUST_LOG=info

EXPOSE 3000
VOLUME ["/app/data"]
CMD ["chatpony"]
