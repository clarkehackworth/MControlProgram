# build
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY web/package*.json web/
RUN npm ci && npm --prefix web ci
COPY . .
RUN npm run build && npm prune --omit=dev

# run
FROM node:22-bookworm-slim
WORKDIR /app
# ssh-keygen is used for ed25519 key generation in the ssh plugin
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/web/dist web/dist
COPY package.json .
ENV NODE_ENV=production MCONTROLPROGRAM_DATA_DIR=/data MCONTROLPROGRAM_ADMIN_HOST=0.0.0.0 MCONTROLPROGRAM_ADMIN_PORT=7700
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 7700
USER node
CMD ["node", "dist/main.js"]
