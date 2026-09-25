# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Tunnel de vente d'ebooks : paiement PayPlug, puis livraison par email (Brevo) d'un
lien de téléchargement signé. Projet indépendant du monorepo GrindRise et de
`grindrise-notifications` : l'intégration Brevo y est dupliquée volontairement, ne
pas chercher à la mutualiser.

Code, commentaires, logs, messages de commit et specs sont en français.

## Commandes

Node >= 24 obligatoire (`node:sqlite`), pnpm uniquement.

```bash
pnpm dev                                # serveur en watch (tsx), charge .env s'il existe
pnpm test                               # Jest (fichiers src/**/*.spec.ts)
pnpm test -- src/db/orders.repository.spec.ts   # un seul fichier
pnpm test -- -t "nom du test"           # un seul test
pnpm typecheck                          # tsc --noEmit
pnpm build                              # tsc -p tsconfig.build.json → dist/
```

Pas de linter configuré. Le serveur refuse de démarrer si une variable
obligatoire manque (`src/config/env.config.ts`, documentées dans `.env.example`).
En local, PayPlug doit pouvoir joindre `PUBLIC_BASE_URL` : utiliser un tunnel https.

## Architecture

Fastify + TypeScript compilé en CommonJS. `src/main.ts` câble les dépendances à la
main (pas de conteneur d'injection) et les passe à `buildServer` (`src/server.ts`),
qui enregistre chaque groupe de routes comme plugin avec ses options. Les tests
reproduisent ce câblage avec `new DatabaseSync(':memory:')` + `applySchema` et des
mocks typés du client PayPlug / du provider email.

Flux d'une commande :

1. **Checkout** (`checkout/`) : le prix vient toujours de `catalog/catalog.ts`
   (catalogue en dur), jamais du client. Crée la commande `pending`, puis le
   paiement PayPlug avec `metadata.order_id`, puis y rattache le `payment_id`.
2. **Notification IPN** (`notification/`) : PayPlug **ne signe pas** ses
   notifications. Le corps ne sert qu'à extraire un `pay_…` ; toute décision repose
   sur la relecture du paiement via l'API (`payment/payplug.client.ts`, `fetch`
   direct, pas de SDK). Contrôles : payé, commande trouvée, paiement rattaché,
   montant et devise identiques.
3. **Idempotence** : `orders.markPaid` est le verrou — seule la transition
   `pending → paid` déclenche la livraison. Ne jamais contourner ce passage.
4. **Livraison** (`delivery/delivery.service.ts`) : signe un token HMAC
   (`tokens/`), envoie l'email ; échec → `delivery_failed`, rattrapage manuel. La
   route répond 200 quand même pour éviter les renvois inutiles de PayPlug.
5. **Téléchargement** (`download/`) : vérifie token, expiration et quota
   (`DOWNLOAD_MAX_USES`), le fichier existe avant de consommer le quota. Les PDF
   sont dans `${DATA_DIR}/ebooks/`, déposés à la main, hors dépôt.

Statuts : `pending | paid | delivered | delivery_failed`.

## Invariants à respecter

- **Journal d'audit** (`order_events`) : en ajout seul, garanti par des triggers
  SQLite qui bloquent UPDATE/DELETE. Conservation 10 ans. Chaque changement d'état
  de `orders` s'écrit avec sa trace dans la même transaction (`OrdersRepository`).
  Tout nouvel événement passe par `recordEvent` avec un type de `OrderEventType`.
- **Données personnelles** : l'email n'existe qu'une fois, dans `orders`. Jamais
  dans `order_events.detail` ni dans les logs (on journalise `orderId`). Aucune
  adresse IP stockée. Ne pas archiver le corps brut des notifications.
- **Logs** : tout passe par `src/logger.ts` (JSON une ligne), le logger Fastify
  est désactivé. `docker-entrypoint.sh` émet le même format.
- **Schéma** : pas d'outil de migration, `applySchema` fait des
  `CREATE ... IF NOT EXISTS` et refuse de démarrer sur l'ancien schéma Stripe. Un
  changement de colonne sur une base existante doit être traité explicitement.
- **Démarrage strict** : config manquante ou incohérente (clé `sk_live_` sans
  https, sauvegarde absente) → refus de démarrer, jamais d'échec silencieux.

## Production

CapRover, une seule app (API + `public/`). Volume persistant sur `/data`
(`orders.db` + `ebooks/`). Dans le container : tini → `docker-entrypoint.sh` →
`litestream replicate -exec "node dist/main.js"`. L'entrypoint vérifie les
variables `LITESTREAM_*`, la joignabilité du bucket OVH et restaure la base si
elle est absente. Litestream ne supprime rien (rétention confiée aux règles de
cycle de vie OVH, `ops/ovh/`). L'arrêt sur SIGTERM ferme Fastify puis la base
(`main.ts`) ; pour tester les signaux en local, lancer le vrai binaire `node`,
pas le shim Volta.

## Références

- `spec/2026-09-22-migration-payplug.md` : prime sur la conception initiale pour
  tout ce qui touche au paiement (flow, tests, bascule en live).
- `spec/2026-09-22-sauvegarde-litestream.md` : sauvegarde, rétention, restauration.
- `docs/` n'est pas versionné (notes produit).
- Les pages de `public/` sont des placeholders non designés.
