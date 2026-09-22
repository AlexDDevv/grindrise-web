# Conception — tunnel de vente d'ebooks

Date : 2026-09-17

> **Paiement remplacé par PayPlug le 2026-09-22.** Pour tout ce qui concerne le
> paiement (flow, modèle de données, idempotence, routes, procédure de test),
> [`2026-09-22-migration-payplug.md`](2026-09-22-migration-payplug.md) fait foi.
> Ce document reste la référence pour le reste du tunnel.

Périmètre : la mécanique technique du funnel, de l'appui sur le bouton d'achat
jusqu'au téléchargement du PDF. Hors périmètre : le design réel, le contenu des
ebooks, la landing page Grindrise, toute notion de compte utilisateur.

---

## 1. Décisions structurantes

### Fastify plutôt que NestJS

Le funnel compte cinq routes. NestJS apporterait injection de dépendances,
modules et décorateurs à un service qui tient en une dizaine de fichiers.
`grindrise-notifications` montre par ailleurs que la convention maison est déjà
« TypeScript nu, Node natif, pas de framework superflu » — Brevo y est appelé en
`fetch` direct plutôt que par son SDK. Fastify n'ajoute que ce qui manque à
`node:http` : routing typé, service de fichiers statiques, et un parser de corps
brut configurable par route, indispensable à la vérification de signature Stripe.

### Node 24 plutôt que Node 22

`grindrise-notifications` tourne sur `node:22-alpine`. Ce service utilise Node 24
pour `node:sqlite`, encore expérimental en 22 et stable en 24. C'est ce qui rend
le stockage des commandes possible sans aucune dépendance base de données.

### Livraison par lien signé, pas par pièce jointe

Trois raisons :

1. Brevo plafonne le payload d'envoi autour de 10 Mo en base64. Un ebook mis en
   page avec des visuels dépasse vite ce seuil — et l'échec surviendrait *après*
   l'encaissement, au pire moment.
2. Un téléchargement passant par un endpoint est traçable ; une pièce jointe
   partie est invisible. Le log « téléchargement effectué » en dépend.
3. Un PDF en pièce jointe dégrade la délivrabilité, précisément le risque à ne
   pas prendre sur un email post-paiement.

### SQLite plutôt qu'un fichier JSON

L'idempotence repose sur une contrainte d'unicité appliquée de façon atomique.
Stripe peut livrer deux fois le même événement, et deux webhooks concurrents
liraient le même fichier JSON avant que l'un n'écrive — deux livraisons pour un
paiement. `INSERT … ON CONFLICT DO NOTHING` rend ce scénario impossible.

---

## 2. Flow nominal

```
Navigateur                 Ce service                Stripe          Brevo
    │                          │                       │              │
    │ POST /api/checkout ─────>│                       │              │
    │                          │ create session ──────>│              │
    │<──── url de redirection ─│<──────────────────────│              │
    │                          │                       │              │
    │ ───────────── paiement sur Checkout ────────────>│              │
    │                          │                       │              │
    │                          │<── checkout.session.completed ───────│
    │                          │  vérifie signature    │              │
    │                          │  insère la commande (idempotent)     │
    │                          │  génère le token signé│              │
    │                          │  envoie l'email ────────────────────>│
    │<─── redirection /success │                       │              │
    │                          │                       │              │
    │ GET /api/download/:token │                       │              │
    │<──────── le PDF ─────────│ vérifie et incrémente │              │
```

La livraison est déclenchée par le **webhook**, jamais par la redirection vers
la page de succès : l'acheteur peut fermer son navigateur avant d'y arriver, et
un appel à la page de succès est trivialement falsifiable.

---

## 3. Modèle de données

### `orders`

| Colonne                 | Type    | Rôle                                        |
| ----------------------- | ------- | ------------------------------------------- |
| `checkout_session_id`   | TEXT PK | Identifiant de session Stripe — clé d'idempotence |
| `product_id`            | TEXT    | Référence dans le catalogue                 |
| `email`                 | TEXT    | Collecté par Stripe                         |
| `amount_total`          | INTEGER | En centimes, tel que reçu de Stripe         |
| `currency`              | TEXT    |                                             |
| `status`                | TEXT    | `paid` \| `delivered` \| `delivery_failed`  |
| `download_count`        | INTEGER | Défaut 0, plafonné par `DOWNLOAD_MAX_USES`  |
| `created_at`            | TEXT    | ISO 8601                                    |
| `delivered_at`          | TEXT    | Nullable                                    |

### `processed_events`

| Colonne       | Type    | Rôle                                  |
| ------------- | ------- | ------------------------------------- |
| `event_id`    | TEXT PK | `event.id` Stripe                     |
| `received_at` | TEXT    | ISO 8601                              |

Le catalogue (1-2 ebooks) est un objet TypeScript en dur dans
`src/catalog/` : identifiant, nom, prix en centimes, nom du fichier PDF. Pas de
table produit — un catalogue de deux entrées ne justifie pas une migration à
chaque changement de prix.

---

## 4. Idempotence

Deux verrous complémentaires, parce qu'aucun ne suffit seul :

- **Au niveau événement** : `processed_events` a `event_id` en clé primaire. Un
  rejeu du même événement Stripe sort en 200 sans effet de bord. Couvre le cas
  « Stripe retente parce que notre 200 s'est perdu ».
- **Au niveau commande** : `orders` a `checkout_session_id` en clé primaire.
  Deux événements *distincts* portant la même session — ça arrive — ne peuvent
  pas livrer deux fois. Couvre ce que le premier verrou laisse passer.

L'insertion se fait en `INSERT … ON CONFLICT DO NOTHING` : zéro ligne écrite
signifie doublon, et la livraison n'est pas déclenchée. La décision de livrer
découle du résultat de l'écriture, jamais d'un `SELECT` préalable, qui rouvrirait
la fenêtre de concurrence que l'on cherche à fermer.

**Paiement non abouti** : `checkout.session.completed` peut arriver avec
`payment_status` à `unpaid` (moyens de paiement différés). La livraison est
conditionnée à `payment_status === 'paid'` ; tout autre état est journalisé et
ignoré.

**Échec d'envoi Brevo** : la commande reste en base avec `status` à
`delivery_failed`, et le webhook répond quand même 200 — un 500 ferait retenter
Stripe alors que le paiement, lui, est bien enregistré. Le rattrapage est
manuel, via un log explicite. Automatiser une file de retry n'est pas justifié
au volume visé.

---

## 5. Tokens de téléchargement

Format : `base64url(payload).base64url(hmac_sha256(payload, DOWNLOAD_TOKEN_SECRET))`,
avec `payload = { orderId, exp }`.

La signature seule ne suffit pas : un token valide reste valide tant qu'il n'est
pas expiré, et un lien partagé fonctionnerait pour tout le monde. La
vérification croise donc trois conditions :

1. signature HMAC valide (comparaison à temps constant, `timingSafeEqual`) ;
2. `exp` non dépassé — `DOWNLOAD_TOKEN_TTL_DAYS`, 7 jours par défaut ;
3. `download_count` sous `DOWNLOAD_MAX_USES` (5 par défaut), lu et incrémenté en
   base.

Le compteur est ce qui empêche un lien de « partir à l'infini une fois connu ».

---

## 6. Routes

| Méthode | Chemin                  | Rôle                                            |
| ------- | ----------------------- | ----------------------------------------------- |
| `GET`   | `/health`               | Sonde : process vivant et base ouvrable         |
| `POST`  | `/api/checkout`         | Crée la session Stripe, renvoie l'URL           |
| `POST`  | `/api/stripe/webhook`   | Corps **brut**, signature vérifiée              |
| `GET`   | `/api/download/:token`  | Vérifie le token, sert le PDF, incrémente       |
| `GET`   | `/`, `/success`, `/cancel` | Pages statiques non designées                |

Le webhook doit recevoir le corps **tel quel** : Fastify parse le JSON par
défaut, et un corps re-sérialisé invalide la signature. Un parser de contenu
spécifique à cette route conserve le `Buffer` d'origine.

---

## 7. Test du flow avec les clés de test

Prérequis : la [CLI Stripe](https://stripe.com/docs/stripe-cli), et un `.env`
rempli avec `sk_test_…`.

```bash
# Terminal 1 — le service
pnpm dev

# Terminal 2 — relaie les webhooks Stripe vers le local.
# Affiche un whsec_… : c'est STRIPE_WEBHOOK_SECRET en local, différent de celui
# de production. Le copier dans .env et relancer pnpm dev.
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Puis, dans un navigateur sur `http://localhost:3000`, acheter avec la carte de
test `4242 4242 4242 4242`, n'importe quelle date future, n'importe quel CVC.

À vérifier, dans l'ordre :

1. le terminal 2 montre `checkout.session.completed` en 200 ;
2. les logs du terminal 1 montrent `paiement reçu` puis `email envoyé` ;
3. l'email arrive (Brevo fonctionne en clés de test Stripe — c'est un vrai
   envoi, utiliser une adresse réelle) ;
4. le lien du mail sert bien le PDF, et le log `téléchargement effectué` sort ;
5. au 6ᵉ téléchargement, le lien répond en erreur.

**Tester l'idempotence** — le point le plus important, et celui qu'on ne voit
jamais en usage normal : dans le terminal 2, `stripe events resend <event_id>`
avec l'identifiant de l'événement déjà traité. Le service doit répondre 200 sans
envoyer de second email. C'est la vérification qui garantit qu'un acheteur ne
recevra pas deux fois sa commande.

**Cartes de test utiles** : `4000 0000 0000 9995` (refusée, fonds
insuffisants) — aucune livraison ne doit partir.

### Passage en clés live

1. Remplacer `STRIPE_SECRET_KEY` par `sk_live_…`.
2. Créer l'endpoint webhook dans le Dashboard Stripe en mode **live**, pointant
   sur `https://<domaine>/api/stripe/webhook`, événement
   `checkout.session.completed`. Son signing secret est **différent** de celui
   du mode test.
3. Renseigner `PUBLIC_BASE_URL` avec le domaine réel — sinon les liens de
   téléchargement partent vers `localhost` dans de vrais emails.
4. Faire un premier achat réel à petit montant et vérifier les cinq points
   ci-dessus en production.

---

## 8. Ce qui est délibérément absent

- **Pas de retry automatique d'email** : au volume visé, un log clair et un
  rattrapage manuel coûtent moins qu'une file de messages à maintenir.
- **Pas de page d'administration** : le Dashboard Stripe fait le travail.
- **Pas de regénération de lien en self-service** : si un acheteur écrit parce
  que son lien a expiré, le renvoi se fait à la main. À revoir si ça devient
  fréquent.
