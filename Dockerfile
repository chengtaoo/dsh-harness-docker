# DeepSeek Harness (dsh) — licence-gated, offline-deployable image.
#
#   build:  docker build -t dsh-harness:0.1.5-rc.1 .
#   run:    docker run -d -p 8080:8080 -v dsh-data:/data -v /srv/code:/workspace dsh-harness
#
# Layout inside the image:
#   /app/node_modules  the published @deepseek-ai/dsh release, installed from npm
#   /app/auth          the licence gateway and its admin CLI
#   /data              persistent state (SQLite licence DB, dsh home, logs)
#   /workspace         the agent's working directory — mount your code here
#
# `dsh web` listens on loopback only; the gateway on 8080 is the sole public
# surface and enforces the licence check.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE}

# Pinned so a rebuild reproduces the same harness.
ARG DSH_VERSION=0.1.5-rc.1

LABEL org.opencontainers.image.title="DeepSeek Harness (dsh)" \
      org.opencontainers.image.description="dsh agent harness with a licence gateway, built for offline intranets" \
      org.opencontainers.image.version="${DSH_VERSION}" \
      org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive

# The toolchain a coding agent expects to find, plus tini for signal handling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      git-lfs \
      jq \
      less \
      openssh-client \
      procps \
      python3 \
      python3-pip \
      python3-venv \
      ripgrep \
      tini \
      unzip \
      xz-utils \
 && rm -rf /var/lib/apt/lists/*

# System-wide git identity. Each user's HOME is isolated, so without this an
# agent's first `git commit` fails on a missing user.email.
RUN git config --system user.name "DeepSeek Harness" \
 && git config --system user.email "dsh@intranet.local" \
 && git config --system init.defaultBranch main \
 && git config --system --add safe.directory '*'

WORKDIR /app

# Install the released harness. Everything the CLI needs — including the web
# frontend bundle and the Linux native addon — arrives through this one tree.
RUN npm init -y >/dev/null \
 && npm install --omit=dev "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force \
 && test -f /app/node_modules/@deepseek-ai/dsh/lib/bin.js

COPY auth/ /app/auth/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Licence administration, runnable while the container is up:
#   docker exec -it dsh dsh-license add --label "张三" --days 365
RUN printf '#!/bin/sh\nexec node /app/auth/admin.mjs "$@"\n' > /usr/local/bin/dsh-license \
 && chmod +x /usr/local/bin/dsh-license

ENV DSH_HOME=/data/dsh-home \
    DSH_LOG_DIR=/data/logs \
    DSH_WORKSPACE=/workspace \
    GATEWAY_PORT=8080 \
    DSH_WEB_PORT=3080 \
    DSH_UPSTREAM_HOST=127.0.0.1 \
    DSH_TELEMETRY_DISABLED=1 \
    HOME=/root

RUN mkdir -p /data/dsh-home /data/logs /workspace

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/__auth/healthz" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
