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

# --- Étape 3 : image d'exécution --------------------------------------------
FROM node:24-alpine AS runner
WORKDIR /app

# tini comme PID 1 : sans lui, Node ignore SIGTERM et CapRover tue le container
# de force à chaque redéploiement, coupant une livraison en cours.
RUN apk add --no-cache tini

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY public ./public

# Le volume CapRover se monte ici : base SQLite des commandes et PDF des ebooks.
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
CMD ["node", "dist/main.js"]
