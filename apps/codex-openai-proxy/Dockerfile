FROM node:24-slim AS build

WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/typescript/package.json packages/typescript/package.json
COPY apps/codex-openai-proxy/package.json apps/codex-openai-proxy/package.json

RUN npm ci

COPY packages/typescript packages/typescript
COPY apps/codex-openai-proxy apps/codex-openai-proxy

RUN npm --workspace @usetemi/codex-openai-proxy run build
RUN npm prune --omit=dev

FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production
ENV CODEX_OPENAI_PROXY_HOST=0.0.0.0
ENV CODEX_OPENAI_PROXY_PORT=8080
ENV PATH=/app/node_modules/.bin:$PATH

COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/typescript/package.json packages/typescript/package.json
COPY --from=build /repo/packages/typescript/dist packages/typescript/dist
COPY --from=build /repo/apps/codex-openai-proxy/package.json apps/codex-openai-proxy/package.json
COPY --from=build /repo/apps/codex-openai-proxy/README.md apps/codex-openai-proxy/README.md
COPY --from=build /repo/apps/codex-openai-proxy/dist apps/codex-openai-proxy/dist

WORKDIR /app/apps/codex-openai-proxy
EXPOSE 8080

CMD ["node", "dist/cli.js"]
