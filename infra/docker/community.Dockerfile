FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/provably-fair/package.json packages/provably-fair/
COPY services/api-gateway/package.json services/api-gateway/
COPY services/minecraft-bot/package.json services/minecraft-bot/
COPY services/discord-bot/package.json services/discord-bot/
COPY services/community-bot/package.json services/community-bot/tsconfig.json services/community-bot/
RUN npm ci --ignore-scripts
COPY services/community-bot services/community-bot
# Incremental state from the host must never decide what this image emits.
# A .tsbuildinfo that says "already built" makes tsc skip the emit, and dist is not in
# the context to make up for it, so the build silently produces nothing and the next
# workspace fails to resolve it. .dockerignore drops these; this makes the image build
# independent of that file being right.
RUN find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
RUN npm run build --workspace @donut/community-bot

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/provably-fair/package.json packages/provably-fair/
COPY services/api-gateway/package.json services/api-gateway/
COPY services/minecraft-bot/package.json services/minecraft-bot/
COPY services/discord-bot/package.json services/discord-bot/
COPY services/community-bot/package.json services/community-bot/
RUN npm ci --omit=dev --ignore-scripts --workspace @donut/community-bot && npm cache clean --force
COPY --from=build /app/services/community-bot/dist services/community-bot/dist
USER node
CMD ["node", "--enable-source-maps", "services/community-bot/dist/src/server.js"]
