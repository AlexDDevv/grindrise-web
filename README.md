# grindrise-web

Tunnel de vente d'ebooks : page de paiement PayPlug en entrée, livraison automatique par
email avec lien de téléchargement signé en sortie.

Projet **indépendant** du monorepo GrindRise et de `grindrise-notifications`.
L'intégration Brevo y est dupliquée volontairement plutôt que partagée : ce
service doit pouvoir être déployé, cassé et redéployé sans toucher au reste.

> Design et UI réels : chantier suivant. Les pages servies ici sont des
> placeholders non designés, le temps de prouver le flow de paiement.

## Stack

- **Fastify** + TypeScript, compilé en CommonJS (mêmes conventions que
  `grindrise-notifications`)
- **PayPlug**, page de paiement hébergée, appelé en `fetch` direct (aucun SDK
  Node officiel) — aucun compte utilisateur : notre page collecte l'email de
  l'acheteur. Les notifications IPN n'étant pas signées, chaque paiement est
  relu auprès de l'API PayPlug avant toute livraison
- **SQLite** via `node:sqlite`, le module natif de Node 24 — zéro dépendance
  base de données. PayPlug reste la source de vérité des paiements ; la base
  trace les commandes, garantit l'idempotence et suit les livraisons
- **Brevo** pour l'email transactionnel, appelé en `fetch` direct (pas de SDK)
- **CapRover**, une seule app servant l'API et les pages statiques

## Démarrage local

```bash
pnpm install
cp .env.example .env    # puis remplir les clés (voir ci-dessous)
pnpm dev
```

`pnpm dev` lance le serveur en watch sur `PORT` (3000 par défaut).

| Script           | Effet                                     |
| ---------------- | ----------------------------------------- |
| `pnpm dev`       | Serveur en watch (tsx)                    |
| `pnpm build`     | Compilation TypeScript vers `dist/`       |
| `pnpm start`     | Exécute le build (ce que lance le Docker) |
| `pnpm test`      | Jest                                      |
| `pnpm typecheck` | `tsc --noEmit`, sans écrire de sortie     |

## Variables d'environnement

Toutes sont documentées dans [`.env.example`](.env.example). Les obligatoires :

| Variable                | Rôle                                                  |
| ----------------------- | ----------------------------------------------------- |
| `PAYPLUG_SECRET_KEY`    | Clé secrète PayPlug (`sk_test_…` puis `sk_live_…`)    |
| `BREVO_API_KEY`         | Clé API Brevo                                         |
| `BREVO_SENDER_EMAIL`    | Expéditeur validé côté Brevo                          |
| `DOWNLOAD_TOKEN_SECRET` | Secret HMAC des liens de téléchargement               |
| `PUBLIC_BASE_URL`       | URL publique, sert à bâtir les liens envoyés par mail |

`DATA_DIR` est optionnelle (`./data` par défaut en local, `/data` fixée par le
Dockerfile en production).

Le serveur **refuse de démarrer** si l'une des obligatoires manque : un container mal configuré
doit être signalé par CapRover immédiatement, jamais échouer silencieusement au
premier paiement.

## Données persistantes

`DATA_DIR` contient la base des commandes et les PDF :

```
/data
├── orders.db        base SQLite (commandes et leur paiement PayPlug)
└── ebooks/          les PDF vendus, déposés manuellement
```

En production, c'est un **volume persistant CapRover** monté sur `/data`. Sans
volume, l'historique des commandes disparaît à chaque redéploiement et la
garantie de non-double-livraison tombe avec lui. Les PDF y vivant aussi, en
remplacer un ne demande pas de reconstruire l'image.

## Conception

La conception initiale est dans [`spec/`](spec/) ; le passage à PayPlug —
flow, vérification des notifications, idempotence, procédure de test et bascule
en live — est décrit dans
[`spec/2026-09-22-migration-payplug.md`](spec/2026-09-22-migration-payplug.md),
qui prime sur la conception initiale pour tout ce qui touche au paiement. Les notes de travail produit vivent dans `docs/`, qui n'est
pas versionné.
