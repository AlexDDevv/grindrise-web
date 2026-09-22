# Migration Stripe → PayPlug

Date : 2026-09-22

Remplace, pour tout ce qui touche au paiement, les sections 2 (flow), 3
(modèle de données), 4 (idempotence), 6 (routes) et 7 (test) de
[`2026-09-17-tunnel-vente-ebooks-design.md`](2026-09-17-tunnel-vente-ebooks-design.md).
Le reste — catalogue, livraison Brevo par lien signé, tokens de téléchargement,
quota — est inchangé.

---

## 1. Décision

PayPlug plutôt que Stripe : entreprise française privilégiée, en acceptant des
frais légèrement supérieurs et l'absence de SDK Node officiel.

Deux différences dictent l'implémentation :

1. **Pas de SDK Node.** Les paquets npm communautaires reposent sur une
   authentification par session abandonnée par l'API. `src/payment/payplug.client.ts`
   est un client REST maison : `fetch` natif, clé secrète en `Bearer`, en-tête
   `PayPlug-Version: 2019-08-06` figé. Deux appels seulement — créer et relire
   un paiement.
2. **Notifications non signées.** N'importe qui peut POSTer sur l'URL de
   notification. Le corps n'est lu que pour y prendre un identifiant `pay_…` ;
   la décision de livrer repose **uniquement** sur un `GET /v1/payments/{id}`
   authentifié par notre clé. Plus de secret de webhook.

Conséquence produit : la page hébergée PayPlug ne collecte pas l'email de
l'acheteur, alors que Stripe Checkout le faisait. La page d'achat le demande
désormais, le transmet à PayPlug (`billing.email`) et l'enregistre avec la
commande.

---

## 2. Flow nominal

```
Navigateur                 Ce service                PayPlug         Brevo
    │                          │                       │               │
    │ POST /api/checkout ─────>│ commande `pending`    │               │
    │   {productId, email}     │ POST /v1/payments ───>│               │
    │                          │   metadata.order_id   │               │
    │<──────── payment_url ────│<──────────────────────│               │
    │                          │                       │               │
    │ ───────────── paiement sur la page PayPlug ─────>│               │
    │<──────────── redirection /success ou /cancel ────│               │
    │                          │                       │               │
    │                          │<── IPN {id: pay_…} ───│               │
    │                          │ GET /v1/payments/id ─>│  (seule source│
    │                          │<── is_paid, metadata ─│   de vérité)  │
    │                          │ pending → paid (atomique)             │
    │                          │ génère le token, envoie l'email ─────>│
    │                          │                       │               │
    │ GET /api/download/:token │                       │               │
    │<──────── le PDF ─────────│                       │               │
```

La livraison n'est déclenchée que par la notification vérifiée, jamais par le
retour sur `/success` : l'acheteur peut fermer l'onglet avant, et cette URL est
triviale à appeler sans payer.

À la réception d'une notification, dans l'ordre :

| Contrôle                                              | Échec →                              |
| ----------------------------------------------------- | ------------------------------------ |
| `object === 'payment'` (sinon : remboursement…)       | 200, ignorée                         |
| `id` au format `pay_[A-Za-z0-9]+`                     | 400, PayPlug n'est pas appelé        |
| `GET /v1/payments/{id}` répond                        | 404 → 400 ; réseau/5xx/401 → 502     |
| `is_paid` vrai **dans la réponse relue**              | 200, rien livré                      |
| `metadata.order_id` mène à une commande               | 200, log error (rattrapage manuel)   |
| le `payment_id` de la commande est bien ce paiement   | 200, log error                       |
| montant et devise relus = ceux de la commande         | 200, log error                       |
| transition `pending → paid` effectuée par CET appel   | 200, déjà traité                     |

Le 502 laisse PayPlug renvoyer la notification quand on n'a pas pu savoir si le
paiement a réussi.

---

## 3. Modèle de données

La commande est créée **avant** le paiement, avec le prix, le produit et l'email
fixés côté serveur. L'ancienne table `processed_events` disparaît : les
notifications PayPlug n'ont pas d'identifiant d'événement.

| Colonne          | Type        | Rôle                                                  |
| ---------------- | ----------- | ----------------------------------------------------- |
| `id`             | TEXT PK     | `ord_<uuid>`, transmis dans `metadata.order_id`       |
| `payment_id`     | TEXT UNIQUE | `pay_…`, rattaché dès la création du paiement         |
| `product_id`     | TEXT        | Référence dans le catalogue                           |
| `email`          | TEXT        | Saisi sur notre page d'achat                          |
| `amount_total`   | INTEGER     | En centimes, depuis le catalogue                      |
| `currency`       | TEXT        | `EUR`                                                 |
| `status`         | TEXT        | `pending` \| `paid` \| `delivered` \| `delivery_failed` |
| `download_count` | INTEGER     | Refusé tant que la commande est `pending`             |
| `created_at`     | TEXT        | ISO 8601                                              |
| `paid_at`        | TEXT        | Nullable                                              |
| `delivered_at`   | TEXT        | Nullable                                              |

### `order_events` — journal d'audit

`orders` ne garde que l'**état courant** : un échec d'envoi suivi d'un renvoi
réussi n'y laisse que `delivered`. L'historique complet vit dans
`order_events`, une ligne par étape, jamais modifiée ni supprimée.

| Colonne      | Type       | Rôle                                                   |
| ------------ | ---------- | ------------------------------------------------------ |
| `id`         | INTEGER PK | Auto-incrément : l'ordre d'insertion fait foi          |
| `order_id`   | TEXT       | Nullable — une notification peut viser un inconnu      |
| `payment_id` | TEXT       | Nullable — avant la création du paiement               |
| `type`       | TEXT       | Voir ci-dessous                                        |
| `detail`     | TEXT       | JSON : raison, montants, code d'échec…                 |
| `created_at` | TEXT       | ISO 8601                                               |

| Étape                    | Types tracés                                                       |
| ------------------------ | ------------------------------------------------------------------ |
| Checkout                 | `order_created`, `payment_created`, `payment_creation_failed`      |
| Notification             | `notification_received` (champs affirmés), `notification_rejected`, `verification_failed`, `payment_not_paid` (+ code d'échec PayPlug), `payment_mismatch` |
| Idempotence              | `payment_confirmed`, `payment_already_processed`                   |
| Livraison                | `email_sent`, `delivery_failed` (+ raison)                         |
| Téléchargement           | `download_served` (+ compteur), `download_refused` (+ raison)      |

Garanties :

- **Ajout seul, imposé par la base** : deux triggers SQLite rejettent tout
  `UPDATE` ou `DELETE` sur `order_events`.
- **Même transaction** que le changement d'état qu'il décrit : pas d'état sans
  trace, ni de trace d'un changement qui n'a pas eu lieu.
- **Pas de donnée personnelle dupliquée** : l'email reste dans `orders`, une
  seule fois. Aucune adresse IP n'est enregistrée.
- Non tracé en base : les notifications à l'identifiant mal formé et les
  tokens de téléchargement invalides. Ils ne se rattachent à aucune commande
  et pourraient remplir la base à volonté ; ils restent dans les logs.

Historique d'une commande :

```sql
SELECT created_at, type, payment_id, detail FROM order_events
WHERE order_id = 'ord_…'
   OR payment_id = (SELECT payment_id FROM orders WHERE id = 'ord_…')
ORDER BY id;
```

### Durée de conservation

`orders` et `order_events` sont conservées **10 ans**, la durée fixée pour les
pièces justificatives comptables (article L123-22 du Code de commerce), et la
plus longue qui puisse s'appliquer ici. Aucune purge n'est automatisée : la
première échéance tombe en 2036. Une purge devra supprimer explicitement les
triggers d'ajout seul, ce qui la rend délibérée par construction. La durée est
à mentionner dans la politique de confidentialité, puisque l'email de
l'acheteur est conservé aussi longtemps.

Une base créée par la version Stripe (colonne `checkout_session_id`) fait
échouer le démarrage avec un message explicite : l'archiver, puis supprimer
`orders.db`.

---

## 4. Idempotence

Même principe qu'avec Stripe : la décision de livrer découle d'une écriture
atomique, jamais d'un SELECT préalable.

```sql
UPDATE orders SET status = 'paid', paid_at = ?
WHERE id = ? AND payment_id = ? AND status = 'pending'
```

Seule la notification qui modifie une ligne livre. Rejeu, notifications
simultanées, notification arrivant après une livraison échouée : `changes = 0`,
rien ne repart. `payment_id UNIQUE` interdit en plus qu'un paiement soit
rattaché à deux commandes. Un envoi Brevo en échec laisse la commande en
`delivery_failed`, et la notification reçoit quand même 200 ; le rattrapage
reste manuel.

---

## 5. Routes

| Méthode | Chemin                        | Rôle                                                 |
| ------- | ----------------------------- | ---------------------------------------------------- |
| `POST`  | `/api/checkout`               | `{productId, email}` → commande + paiement PayPlug   |
| `POST`  | `/api/payplug/notification`   | IPN : relecture du paiement, puis livraison          |
| `GET`   | `/api/download/:token`        | Inchangée                                            |
| `GET`   | `/health`, `/`, `/success`, `/cancel` | Inchangées                                   |

---

## 6. Clés : test et live

PayPlug sert les deux modes sur **le même endpoint** : seule la clé les
distingue.

|                     | Clé de test (`sk_test_…`)             | Clé live (`sk_live_…`)                     |
| ------------------- | ------------------------------------- | ------------------------------------------ |
| Argent              | Aucun                                 | Vrais débits                               |
| Cartes acceptées    | Cartes de test uniquement             | Vraies cartes uniquement                   |
| Paiements visibles  | Mode TEST du portail                  | Mode LIVE du portail                       |
| Disponible          | Dès la création du compte             | Après activation du compte par PayPlug     |

Un paiement créé avec une clé est **introuvable** avec l'autre : une
notification test reçue par un serveur live (ou l'inverse) aboutit à un 404 à
la relecture, donc à aucune livraison. Le log `Notification d'un autre mode que
la clé configurée` le signale.

Garde-fous dans le code :

- le serveur refuse de démarrer sans `PAYPLUG_SECRET_KEY`, ou si elle ne
  commence ni par `sk_test_` ni par `sk_live_` (la clé publique `pk_…` est
  refusée) ;
- une clé `sk_live_` avec un `PUBLIC_BASE_URL` non https bloque le démarrage :
  c'est le signe d'une configuration locale passée en production ;
- chaque démarrage journalise `payplugMode`.

---

## 7. Tester le flow avec la clé de test

PayPlug doit pouvoir **joindre** l'URL de notification depuis Internet : un
serveur sur `localhost` ne reçoit rien. Il faut un tunnel https, par exemple
`cloudflared` (sans compte) :

```bash
# Terminal 1 — tunnel. Affiche une URL https://<aléatoire>.trycloudflare.com
cloudflared tunnel --url http://localhost:3000

# .env : PAYPLUG_SECRET_KEY=sk_test_…
#        PUBLIC_BASE_URL=https://<aléatoire>.trycloudflare.com

# Terminal 2 — le service. Le log de démarrage doit dire payplugMode: "test".
pnpm dev
```

L'URL du tunnel change à chaque lancement de `cloudflared` : mettre à jour
`PUBLIC_BASE_URL` et relancer `pnpm dev` à chaque fois.

Déposer un PDF dans `./data/ebooks/entrainement.pdf`, puis ouvrir l'URL du
tunnel, saisir une **vraie** adresse email (Brevo envoie réellement, même en
mode test PayPlug), acheter avec `4242 4242 4242 4242`, n'importe quelle date
future, n'importe quel CVC.

À vérifier, dans l'ordre :

1. logs : `Paiement créé`, puis `Notification reçue`, `Paiement confirmé`,
   `Email envoyé` ;
2. le navigateur revient sur `/success` ;
3. l'email arrive, le lien sert le PDF, le log `Téléchargement effectué` sort ;
4. au 6ᵉ téléchargement, le lien répond en erreur ;
5. dans le portail PayPlug, en mode TEST, le paiement apparaît comme payé.

**Idempotence** — PayPlug n'offre pas de bouton de renvoi : rejouer la
notification à la main, avec l'identifiant `pay_…` lu dans les logs.

```bash
curl -i -X POST "$PUBLIC_BASE_URL/api/payplug/notification" \
  -H 'content-type: application/json' \
  -d '{"id":"pay_XXXXXXXX","object":"payment","is_live":false}'
```

Attendu : `200`, log `Paiement déjà traité, aucune seconde livraison`, aucun
second email.

**Notification forgée** — la même commande `curl` sur un paiement abandonné ou
refusé (voir les cartes ci-dessous), même avec `"is_paid": true` ajouté au
corps : `200`, log `Paiement non abouti`, rien n'est livré. Avec un
identifiant inventé (`pay_inexistant`) : `400`.

**Cartes de refus** : `4000 0000 0000 0051` (refusée), `4000 0000 0000 0077`
(fonds insuffisants), `4000 0000 0000 0085` (erreur de traitement),
`5184 6800 0000 0170` (3-D Secure refusé). Aucune livraison ne doit partir.

**Abandon** : cliquer « annuler » sur la page PayPlug ramène sur `/cancel` ; la
commande reste `pending`, sans aucun email.

---

## 8. Passage en live

1. Compte PayPlug activé par PayPlug (justificatifs validés) — sans ça, pas de
   clé live exploitable.
2. En production uniquement : `PAYPLUG_SECRET_KEY=sk_live_…`. Ne jamais mettre
   la clé live dans le `.env` local.
3. `PUBLIC_BASE_URL=https://<domaine réel>` — sinon le démarrage est refusé.
   Aucune URL de notification à déclarer dans le portail : elle est envoyée
   avec chaque paiement.
4. Redéployer, vérifier `payplugMode: "live"` dans le log de démarrage.
5. Premier achat réel à petit montant ; vérifier les cinq points de la section 7,
   puis rembourser depuis le portail si besoin (le remboursement notifie aussi
   le serveur, qui l'ignore).
