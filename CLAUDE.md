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
   (catalogue en dur : trois ebooks à l'unité et un pack des trois), jamais du
   client. Crée la commande `pending`, puis le
   paiement PayPlug avec `metadata.order_id`, puis y rattache le `payment_id`.
2. **Notification IPN** (`notification/`) : PayPlug **ne signe pas** ses
   notifications. Le corps ne sert qu'à extraire un `pay_…` ; toute décision repose
   sur la relecture du paiement via l'API (`payment/payplug.client.ts`, `fetch`
   direct, pas de SDK). Contrôles : payé, commande trouvée, paiement rattaché,
   montant et devise identiques.
3. **Idempotence** : `orders.markPaid` est le verrou — seule la transition
   `pending → paid` déclenche la livraison. Ne jamais contourner ce passage.
4. **Livraison** (`delivery/delivery.service.ts`) : signe un token HMAC
   (`tokens/`), envoie l'email étiqueté avec l'`orderId` ; échec → `delivery_failed`,
   rattrapage manuel. La route répond 200 quand même pour éviter les renvois
   inutiles de PayPlug.
   `email_sent` ne prouve que l'acceptation par Brevo. La remise réelle arrive
   par webhook (`email/brevo.webhook.routes.ts`) : `email_delivered`, ou
   `email_failed` et retour en `delivery_failed` sur échec définitif. Brevo ne
   signe pas ses appels, l'origine est prouvée par `BREVO_WEBHOOK_SECRET` en
   Bearer, et les ouvertures et clics sont ignorés (aucun traceur annoncé).
5. **Téléchargement** (`download/`) : vérifie token, expiration et quota
   (`DOWNLOAD_MAX_USES`), le fichier existe avant de consommer le quota. Les PDF
   sont dans `${DATA_DIR}/ebooks/`, déposés à la main, hors dépôt.

**Produits multi-fichiers** : `Product.files` liste les ebooks d'une offre (le
pack en a deux). L'email contient un lien signé par fichier, jamais d'archive.
Le token porte `{ orderId, fileIndex }` et le quota est compté par fichier dans
`order_downloads`. **L'ordre de `files` est structurant** : il est gravé dans
les tokens déjà envoyés, donc on ajoute en fin de liste, on n'insère pas au
milieu.

**Renoncement au droit de rétractation** : `/api/checkout` refuse une commande
sans `waiveWithdrawal: true` (contenu numérique livré immédiatement, article
L221-28 13° du Code de la consommation). Le consentement est horodaté dans le
journal (`withdrawal_waived`) avant la création du paiement, et rappelé dans
l'email de livraison. Les pages légales sont dans `public/legal/`, servies sous
`/legal/…`, et décrivent le comportement réel du code (quota, durée des liens,
conservation 10 ans) : les garder synchronisées.

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
- **Page d'achat et catalogue** : `public/ebooks/index.html` répète prix et
  titres à la main ; `src/catalog/catalog.spec.ts` verrouille la cohérence
  (identifiants, prix affiché = prix facturé, titres) et la validité du script
  inline. Tout changement de prix ou de titre touche les deux fichiers.
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
- Les pages de `public/` portent la DA GrindRise (piste « Le registre »), venue
  du projet de design claude.ai. `public/styles.css` est la feuille unique :
  tokens en tête, puis primitives (`.btn`, `.card`, `.prose`, `.offer`…) et
  effets CSS (`.fx-halo`, `.fx-grain`, `.reveal`). Aucun build, aucune requête
  tierce, polices auto-hébergées dans `public/fonts/`. Le gabarit d'email suit
  la même DA, en tableaux et styles en ligne.
- Le tunnel de vente est servi sous `/ebooks` (`public/ebooks/`), la racine est
  réservée à la future landing GrindRise : `/success` et `/cancel` n'existent
  plus, les URL de retour envoyées à PayPlug sont `/ebooks/success` et
  `/ebooks/cancel`. Les pages légales sont sous `/legal/`.
