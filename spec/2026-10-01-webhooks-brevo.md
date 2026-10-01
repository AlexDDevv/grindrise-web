# Webhooks Brevo : savoir si l'email est vraiment arrivé

Date : 2026-10-01

## 1. Le problème constaté

Le 2026-10-01, deux acheteurs de test n'ont jamais reçu leurs liens. Pourtant :

- le serveur avait inscrit `email_sent` au journal et passé les commandes en
  `delivered` ;
- Brevo avait bien accepté les deux messages (événement `requests`) ;
- mais aucun événement `delivered` n'a suivi, ni rebond, ni rejet : les messages
  sont restés immobilisés dans la file de Brevo.

`email_sent` ne prouvait donc que l'acceptation par Brevo. Pour un acheteur
réel, la commande serait restée marquée livrée, sans aucun signal.

## 2. Ce que fait le webhook

Route `POST /api/brevo/webhook` (`src/email/brevo.webhook.routes.ts`).

| Événement Brevo | Effet |
| --- | --- |
| `delivered` | `email_delivered` au journal ; le statut ne bouge pas |
| `soft_bounce`, `deferred` | `email_failed` ; statut inchangé, Brevo réessaie |
| `hard_bounce`, `blocked`, `invalid_email`, `spam`, `error` | `email_failed` **et** retour en `delivery_failed` |
| `opened`, `click`, `proxy_open`, `unsubscribed`, `request` | ignorés, jamais inscrits |

Un échec définitif fait réapparaître la commande dans les rattrapages : le
paiement est encaissé et l'acheteur n'a rien reçu.

Les ouvertures et les clics sont écartés volontairement : savoir qui ouvre son
email n'aide pas à livrer un ebook, et la politique de confidentialité annonce
l'absence de traceur.

## 3. Rattachement à la commande

L'email est envoyé avec l'`orderId` en **étiquette** (`tags: [order.id]`), que
Brevo renvoie tel quel. Le webhook ne lit donc jamais l'adresse de l'acheteur
pour retrouver sa commande : l'invariant « l'email n'existe qu'une fois, dans
`orders` » tient. Seuls l'événement, sa raison et l'identifiant technique du
message entrent au journal.

Brevo envoie `tags` (tableau) et parfois `tag` (chaîne) : les deux sont lus.

## 4. Authentification

**Brevo ne signe pas ses webhooks.** L'origine est prouvée par un jeton en
`Authorization: Bearer`, comparé à `BREVO_WEBHOOK_SECRET` à temps constant.
Brevo accepte trois mécanismes sur un webhook sortant : identifiants dans
l'URL, jeton Bearer, en-têtes personnalisés. Le Bearer est retenu : un secret
placé dans l'URL finirait dans les journaux d'accès du proxy.

Sans jeton valide : `401`, et rien n'est inscrit. Un faux événement ne peut donc
pas faire passer une commande livrée en `delivery_failed`.

## 5. Mise en place

1. Générer le jeton :
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
2. Le déclarer dans CapRover (`BREVO_WEBHOOK_SECRET`) **avant** de déployer :
   le serveur refuse de démarrer sans lui.
3. Déployer.
4. Déclarer le webhook côté Brevo, avec le même jeton :

```bash
curl -X POST https://api.brevo.com/v3/webhooks \
  -H "api-key: $BREVO_API_KEY" -H 'content-type: application/json' \
  -d '{"url":"https://grindrise.fr/api/brevo/webhook",
       "description":"Livraison des ebooks",
       "type":"transactional",
       "events":["delivered","hard_bounce","soft_bounce","blocked","spam","invalid_email","deferred","error"],
       "auth":{"type":"bearer","token":"<JETON>"}}'
```

5. Vérifier après un achat de test : le journal de la commande doit contenir
   `email_sent` **puis** `email_delivered`.

## 6. Reste à décider

Brevo enregistre aujourd'hui les ouvertures et les clics de nos emails de
livraison : ses statistiques montrent des événements `opened` et `clicks`. Deux
conséquences :

- un pixel de suivi est inséré dans un email dont la politique de
  confidentialité ne mentionne aucun traceur ;
- le suivi des clics réécrit les liens, donc le lien de téléchargement signé
  passe par un redirecteur Brevo.

Les deux se désactivent dans les réglages transactionnels de Brevo. Décision à
prendre avant l'ouverture des ventes.
