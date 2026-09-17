# grindrise-web

Tunnel de vente d'ebooks : Stripe Checkout en entrée, livraison automatique par
email avec lien de téléchargement signé en sortie.

Projet **indépendant** du monorepo GrindRise et de `grindrise-notifications`.
L'intégration Brevo y est dupliquée volontairement plutôt que partagée : ce
service doit pouvoir être déployé, cassé et redéployé sans toucher au reste.

> Design et UI réels : chantier suivant. Les pages servies ici sont des
> placeholders non designés, le temps de prouver le flow de paiement.

## Stack

- **Fastify** + TypeScript, compilé en CommonJS (mêmes conventions que
  `grindrise-notifications`)
- **Stripe Checkout** en mode paiement unique — aucun compte utilisateur, aucune
  auth : Stripe collecte l'email de l'acheteur
- **SQLite** via `node:sqlite`, le module natif de Node 24 — zéro dépendance
  base de données. Stripe reste la source de vérité des paiements ; la base ne
  sert qu'à garantir l'idempotence et tracer les livraisons
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
| `STRIPE_SECRET_KEY`     | Clé API Stripe (`sk_test_…` puis `sk_live_…`)         |
| `STRIPE_WEBHOOK_SECRET` | Authentifie les appels du webhook — diffère en local  |
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
├── orders.db        base SQLite (commandes, événements traités)
└── ebooks/          les PDF vendus, déposés manuellement
```

En production, c'est un **volume persistant CapRover** monté sur `/data`. Sans
volume, l'historique des commandes disparaît à chaque redéploiement et la
garantie de non-double-livraison tombe avec lui. Les PDF y vivant aussi, en
remplacer un ne demande pas de reconstruire l'image.

## Conception

Le détail du flow, le schéma des tables, la stratégie d'idempotence et la
procédure de test avec les clés Stripe de test sont dans
[`spec/`](spec/). Les notes de travail produit vivent dans `docs/`, qui n'est
pas versionné.
