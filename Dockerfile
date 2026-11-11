# MC Panel + a Java runtime for the Minecraft server, in one container.
# The panel controls the server through tmux, so both must live in the same container.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM eclipse-temurin:25-jre
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY lib ./lib
COPY locales ./locales
COPY public ./public
ENV PORT=8080 MC_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8080 25565
# Language: Arabic by default; set PANEL_LANG=en for English (users can also switch in the UI).
CMD ["node", "server.js"]
