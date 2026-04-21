# Multi-stage build: the @roamhq/wrtc platform binary is heavy, so we keep
# dev-only tooling out of the final image.
FROM node:20-bookworm-slim AS build
WORKDIR /app
# Native addons that come in through transitive deps (bittorrent-dht bindings,
# wrtc glue, etc.) need a toolchain. Slim image, purged after `npm ci`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json ./
# `--include=optional` is critical: @roamhq/wrtc ships its prebuilt binary via
# an optionalDependency per platform. Without it we get "Could not find wrtc
# binary" at runtime.
RUN npm install --include=optional --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The wrtc addon links against libstdc++ / libc; nothing else to install.
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY index.js ./
# Fly.io sends PORT via env; listen on 0.0.0.0.
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "index.js"]
