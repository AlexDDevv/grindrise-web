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

## 6. Le suivi des ouvertures et des clics

Brevo insère un pixel de mesure dans nos emails de livraison et fait passer
leurs liens par un redirecteur. Ses statistiques le confirment : les événements
`opened` et `clicks` existent sur nos envois.

**Ce suivi ne peut pas être désactivé depuis l'interface** pour les emails
transactionnels. Brevo l'a confirmé publiquement en mai 2024 : « Disabling
tracking is not planned, for security reasons », avec une ouverture réservée
aux plans Enterprise. La seule voie est une demande à leur support, traitée au
cas par cas.

Décision du 2026-10-01 : **le mentionner plutôt que le combattre**. La
politique de confidentialité décrit désormais ce pixel, son utilité — vérifier
qu'une commande payée a bien été reçue — et la limite que nous nous imposons :
seul l'état de remise entre dans notre journal. Le webhook ignore
explicitement `opened`, `click` et leurs variantes, et aucun test ne doit
autoriser leur enregistrement.

Une demande de désactivation reste à adresser au support Brevo. Si elle
aboutit, le texte de la politique devra être repris.
