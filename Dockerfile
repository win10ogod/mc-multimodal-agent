FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json README.md soul.md ./
COPY src ./src
COPY data ./data
COPY blueprints ./blueprints
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    OPENAI_API_MODE=chat \
    OPENAI_STRUCTURED_OUTPUTS=true \
    OPENAI_REQUEST_TIMEOUT_MS=180000 \
    OPENAI_MAX_RETRIES=6 \
    AGENTBEATS_HOST=0.0.0.0 \
    AGENTBEATS_PORT=9019

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/data ./data
COPY --from=build /app/blueprints ./blueprints
COPY soul.md README.md ./

EXPOSE 9019
ENTRYPOINT ["node", "dist/index.js", "agentbeats"]
CMD ["--host", "0.0.0.0", "--port", "9019"]
