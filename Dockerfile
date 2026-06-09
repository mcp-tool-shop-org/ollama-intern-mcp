# syntax=docker/dockerfile:1
#
# ollama-intern-mcp — MCP **stdio** server image.
#
# This server speaks the Model Context Protocol over stdio, so run it
# interactively and point it at an Ollama backend:
#
#   docker run -i --rm \
#     -e OLLAMA_HOST=http://host.docker.internal:11434 \
#     ghcr.io/mcp-tool-shop-org/ollama-intern-mcp
#
# For Ollama Cloud instead of a local Ollama:
#   docker run -i --rm \
#     -e OLLAMA_CLOUD_PRIMARY=1 -e OLLAMA_API_KEY=sk-... \
#     ghcr.io/mcp-tool-shop-org/ollama-intern-mcp
#
# CLI verbs work too (ENTRYPOINT appends args):
#   docker run --rm ghcr.io/mcp-tool-shop-org/ollama-intern-mcp doctor

# ── Build stage ──────────────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app

# Install deps first for layer caching (dev deps needed for tsc).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production stage ─────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# package.json is REQUIRED at runtime: src/version.ts imports it for VERSION.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
# Referenced by the `init` CLI verb (resolved at <bin-dir>/../).
COPY hermes.config.example.yaml ./

# Run as the non-root user that ships with the node image.
USER node

# Sensible default for desktop Docker; override for Linux/remote hosts or cloud.
ENV OLLAMA_HOST=http://host.docker.internal:11434

# ENTRYPOINT (not CMD) so `docker run ... doctor` passes the verb through and
# the default (no args) starts the MCP stdio server.
ENTRYPOINT ["node", "dist/index.js"]
