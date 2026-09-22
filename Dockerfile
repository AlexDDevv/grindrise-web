# Build multi-stage : l'image finale ne contient ni sources TS, ni devDependencies.
#
# Node 24 et non 22 comme grindrise-notifications : le stockage des commandes
# utilise `node:sqlite`, module natif encore expérimental en 22 et stable en 24.
# C'est ce qui permet de tracer les achats sans aucune dépendance base de données.

# --- Étape 1 : compilation TypeScript ---------------------------------------
FROM node:24-alpine AS builder
WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# --- Étape 2 : dépendances de production uniquement -------------------------
FROM node:24-alpine AS deps
WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

# --- Étape 3 : Litestream ---------------------------------------------------
# Sauvegarde continue de la base vers l'Object Storage OVH (voir
# litestream.yml). Binaire statique, donc compatible Alpine. La somme SHA-256
# est celle publiée par la release : un binaire altéré aurait accès à toute la
# base des commandes et aux clés du bucket, le build doit échouer.
# Pour monter de version : changer les deux ARG, avec la somme lue dans
# checksums.txt de la release GitHub.
FROM node:24-alpine AS litestream
ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
RUN wget -q -O /tmp/litestream.tar.gz \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz" \
  && echo "${LITESTREAM_SHA256}  /tmp/litestream.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream

# --- Étape 4 : image d'exécution --------------------------------------------
FROM node:24-alpine AS runner
WORKDIR /app

# tini comme PID 1 : sans lui, SIGTERM n'est pas relayé et CapRover tue le
# container de force à chaque redéploiement, coupant une livraison en cours.
# Chaîne à l'arrêt : tini → Litestream → Node, puis dernière synchronisation
# de la sauvegarde une fois Node terminé.
RUN apk add --no-cache tini

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY litestream.yml /etc/litestream.yml
COPY docker-entrypoint.sh ./

# Le volume CapRover se monte ici : base SQLite des commandes, état local de
# Litestream (.orders.db-litestream) et PDF des ebooks.
# Le chown doit précéder le montage — un volume nommé vide hérite des
# permissions du répertoire tel qu'il existe dans l'image. Sans lui, le process
# tourne en `node` et ne peut pas écrire dans un /data appartenant à root.
RUN mkdir -p /data/ebooks && chown -R node:node /data
VOLUME ["/data"]

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# Le script refuse de démarrer sans sauvegarde opérationnelle, restaure la base
# si le volume est vide, puis lance le serveur sous Litestream.
CMD ["./docker-entrypoint.sh", "node", "dist/main.js"]
