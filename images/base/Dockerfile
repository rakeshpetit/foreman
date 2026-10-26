# The base Agent image (ADR 0003): the toolchain every Agent needs, and a non-root user.
FROM node:24-slim

# `curl` is for the checks that run inside a container.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /uvx /usr/local/bin/

# Pinned: a Claude Code upgrade is a deliberate change to this line.
ARG CLAUDE_CODE_VERSION=2.1.310
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

# `--dangerously-skip-permissions` is refused as root (the M3-T01 spike), so Runs use this user.
# It takes uid 1000 in place of the image's own `node` user. Making a mounted worktree writable by it is M3-T04's job.
RUN userdel -r node && useradd --create-home --uid 1000 --shell /bin/bash agent

USER agent
WORKDIR /work
