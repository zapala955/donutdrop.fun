FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/provably-fair/package.json packages/provably-fair/
COPY services/api-gateway/package.json services/api-gateway/
COPY services/minecraft-bot/package.json services/minecraft-bot/tsconfig.json services/minecraft-bot/
COPY services/discord-bot/package.json services/discord-bot/tsconfig.json services/discord-bot/
RUN npm ci --ignore-scripts
COPY services/discord-bot services/discord-bot
RUN npm run build --workspace @donut/discord-bot

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/provably-fair/package.json packages/provably-fair/
COPY services/api-gateway/package.json services/api-gateway/
COPY services/minecraft-bot/package.json services/minecraft-bot/
COPY services/discord-bot/package.json services/discord-bot/
RUN npm ci --omit=dev --ignore-scripts --workspace @donut/discord-bot && npm cache clean --force
COPY --from=build /app/services/discord-bot/dist services/discord-bot/dist
USER node
CMD ["node", "--enable-source-maps", "services/discord-bot/dist/src/server.js"]
