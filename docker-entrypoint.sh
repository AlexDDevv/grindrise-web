#!/bin/sh
# Démarrage du container : contrôles de la sauvegarde, puis le serveur sous
# Litestream.
#
# Avant de lancer quoi que ce soit : configuration complète ? bucket joignable ?
# base à restaurer ? Ensuite, `litestream replicate -exec` lance le serveur et
# gère l'arrêt dans le bon ordre (vérifié en 0.5.17) : SIGTERM transmis au
# serveur, attente de sa fin, puis dernière synchronisation vers le bucket. Si
# le serveur s'arrête, Litestream s'arrête avec lui, et le container aussi.
#
# Usage : docker-entrypoint.sh <commande du serveur>, par exemple
#         docker-entrypoint.sh node dist/main.js

set -u

CONFIG="${LITESTREAM_CONFIG:-/etc/litestream.yml}"
DATA_DIR="${DATA_DIR:-/data}"
DB="$DATA_DIR/orders.db"
export DATA_DIR

# Même format que src/logger.ts : une ligne JSON, lisible dans le même flux.
log() {
  printf '{"ts":"%s","level":"%s","message":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"
}

# --- 1. Configuration --------------------------------------------------------
# Un serveur de paiement qui tourne sans sauvegarde, c'est un historique
# qu'on croit protégé et qui ne l'est pas : refuser de démarrer.
missing=""
for var in LITESTREAM_BUCKET LITESTREAM_REGION LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY; do
  eval "value=\${$var:-}"
  [ -n "$value" ] || missing="$missing $var"
done
if [ -n "$missing" ]; then
  log error "Sauvegarde non configurée, démarrage refusé. Variables manquantes :$missing"
  exit 1
fi

mkdir -p "$DATA_DIR"

# --- 2. Bucket joignable -----------------------------------------------------
# Sans ce contrôle, un bucket mal nommé ou une clé révoquée ne se verraient que
# dans des logs d'erreur de Litestream, pendant que le serveur encaisse.
# Le timeout est indispensable : face à un endpoint injoignable, Litestream
# réessaie sans fin.
if ! timeout 30 litestream ltx -config "$CONFIG" "$DB" >/dev/null; then
  log error "Bucket de sauvegarde injoignable ou identifiants refusés, démarrage refusé."
  exit 1
fi

# --- 3. Restauration ---------------------------------------------------------
# Volume neuf ou perdu : la base est reconstruite depuis le bucket avant que le
# serveur ne l'ouvre. Premier déploiement (bucket vide) : démarrage à vide.
if [ ! -f "$DB" ]; then
  log warn "Base absente du volume : restauration depuis le bucket si une sauvegarde existe."
  if ! litestream restore -config "$CONFIG" -if-db-not-exists -if-replica-exists "$DB"; then
    log error "Restauration impossible, démarrage refusé."
    exit 1
  fi
  if [ -f "$DB" ]; then
    log info "Base restaurée depuis le bucket."
  else
    log info "Aucune sauvegarde existante : démarrage avec une base neuve."
  fi
fi

# --- 4. Exécution ------------------------------------------------------------
exec litestream replicate -config "$CONFIG" -exec "$*"
