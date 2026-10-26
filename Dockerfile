# syntax=docker/dockerfile:1

# ---- Build stage: compile the browser bundle, then discard the toolchain ----
# The bundle is architecture independent and the runtime only needs Node
# builtins, so the build always runs on the builder's own platform even when the
# published runtime image targets another architecture.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app

# Dependencies are installed from the lockfile only, so the image build never
# reaches for a different dependency tree than the repository pins.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: Node, no app dependencies or frontend toolchain ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173
WORKDIR /app

# server.mjs only imports Node builtins and lib/*.mjs, so node_modules is not
# copied and no npm install runs here. Configuration is supplied at runtime.
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node THIRD_PARTY_NOTICES ./

USER node
EXPOSE 5173

# Liveness only: confirms this process serves its own API. It deliberately does
# not require the CPA Manager upstream to be configured or reachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||5173;const c=new AbortController();const t=setTimeout(()=>c.abort(),4000);fetch('http://127.0.0.1:'+p+'/api/health',{signal:c.signal}).then(r=>{clearTimeout(t);process.exit(r.ok?0:1)},()=>process.exit(1))"

CMD ["node", "server.mjs", "--production"]
