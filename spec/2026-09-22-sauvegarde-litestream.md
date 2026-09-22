# Sauvegarde de la base — Litestream vers l'Object Storage OVH

Date : 2026-09-22

`orders.db` contient les commandes et leur journal d'audit, à conserver 10 ans.
Sans sauvegarde, ces traces n'existent qu'à un seul endroit : le volume
CapRover du VPS.

---

## 1. Principe

[Litestream](https://litestream.io) (open source, 0.5.17) tourne dans le même
container que le serveur et envoie chaque écriture SQLite vers un bucket S3 OVH
en environ une seconde.

| Élément                | Fichier                          | Rôle                                                       |
| ---------------------- | -------------------------------- | ---------------------------------------------------------- |
| Configuration          | `litestream.yml`                 | Bucket, snapshots quotidiens, aucune suppression distante  |
| Démarrage du container | `docker-entrypoint.sh`           | Contrôles, restauration auto, puis serveur sous Litestream |
| Image                  | `Dockerfile` (étape `litestream`) | Binaire téléchargé, somme SHA-256 vérifiée au build        |
| Droits de la clé       | `ops/ovh/litestream-policy.json` | Lecture et écriture, **aucune suppression**                |
| Rétention              | `ops/ovh/lifecycle.json`         | Détail 30 jours, snapshots quotidiens 10 ans               |

Au démarrage du container, dans l'ordre :

1. les quatre variables `LITESTREAM_*` sont présentes, sinon **refus de démarrer** ;
2. le bucket répond avec ces identifiants (30 s max), sinon **refus de démarrer** ;
3. si `orders.db` est absente du volume, elle est **restaurée depuis le bucket**
   (ou créée neuve si le bucket est vide, au premier déploiement) ;
4. `litestream replicate -exec "node dist/main.js"` : le serveur tourne, la
   réplication aussi.

À l'arrêt (redéploiement), Litestream transmet SIGTERM au serveur, attend qu'il
ait fini ses requêtes, pousse les dernières écritures, puis s'arrête. Si le
serveur plante, Litestream s'arrête avec lui et CapRover voit le container
tomber.

Tout ce qui précède a été vérifié en local avec le binaire 0.5.17 et une
réplique fichier (écriture faite pendant l'arrêt bien répliquée, restauration
d'un volume vidé, crash, bucket injoignable). Le build Docker et l'accès réel à
OVH restent à valider au premier déploiement (section 4).

---

## 2. Rétention et protection

Litestream ne supprime **jamais** rien (`retention.enabled: false`), et sa clé
d'accès **n'en a pas le droit**. Un serveur compromis peut écrire dans le
bucket, pas effacer l'historique. L'expiration est confiée aux règles de cycle
de vie du bucket :

| Préfixe                    | Contenu                                   | Conservé    |
| -------------------------- | ----------------------------------------- | ----------- |
| `orders/ltx/0/` à `ltx/3/` | Écritures fines, compactées par paliers   | 30 jours    |
| `orders/ltx/9/`            | Snapshot complet de la base, un par jour  | **10 ans**  |

Conséquences :

- restauration **à la seconde près** sur les 30 derniers jours ;
- restauration **au jour près** jusqu'à 10 ans en arrière, ce qui couvre la
  durée de conservation du journal d'audit.

En plus, le bucket est créé avec le **versioning** et l'**Object Lock** en mode
GOVERNANCE, 30 jours par défaut. Pendant 30 jours, aucun fichier ne peut être
supprimé ou écrasé, même avec une clé administrateur. Cela protège contre une
erreur de manipulation ou une clé admin compromise, pendant le délai où l'on
s'en aperçoit.

Au-delà de 30 jours, les snapshots sont protégés par l'absence de droit de
suppression de la clé du serveur, pas par un verrou. Un verrou de 10 ans
s'appliquerait à tout le bucket, fichiers fins compris, et ne serait pas
réversible en mode COMPLIANCE.

---

## 3. Mise en place chez OVH (une seule fois)

**Région** : prendre une région **différente** de celle du VPS. Le datacenter
du VPS est indiqué sur sa page dans l'espace client. Un incendie ou une panne
de datacenter ne doit pas emporter le serveur et sa sauvegarde ensemble.
`eu-west-par` (Paris, répartie sur 3 zones) est le choix le plus robuste.

1. **Projet Public Cloud.** L'Object Storage fait partie de Public Cloud, pas
   de l'offre VPS. Espace client OVH → Public Cloud → créer un projet s'il n'y
   en a pas. La facturation est à l'usage.
2. **Bucket.** Dans le projet → Object Storage → créer un conteneur :
   - API **S3**, la région choisie, classe **Standard** ;
   - nom `grindrise-orders-backup`. Si ce nom est pris, en choisir un autre et
     le reporter dans `ops/ovh/litestream-policy.json` ;
   - **activer le versioning et l'Object Lock dès la création**. L'Object Lock
     ne peut pas être ajouté ensuite.
3. **Deux utilisateurs S3** (Object Storage → Utilisateurs S3) :
   - `grindrise-litestream`, pour le serveur. Lui appliquer la politique
     `ops/ovh/litestream-policy.json` (import de politique JSON sur
     l'utilisateur). Noter sa clé d'accès et sa clé secrète : elles iront dans
     CapRover, et nulle part ailleurs ;
   - un utilisateur **administrateur**, pour toi seul, sur ta machine. Il sert
     aux deux commandes ci-dessous et aux tests de restauration. Il ne va
     **jamais** sur le serveur.
4. **Verrou et cycle de vie**, depuis ta machine, avec l'AWS CLI et la clé
   administrateur (`aws configure --profile ovh-admin`, région = code OVH) :

   ```bash
   ENDPOINT=https://s3.<region>.io.cloud.ovh.net
   BUCKET=grindrise-orders-backup

   aws s3api put-object-lock-configuration --profile ovh-admin \
     --endpoint-url "$ENDPOINT" --bucket "$BUCKET" \
     --object-lock-configuration \
     '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Days":30}}}'

   aws s3api put-bucket-lifecycle-configuration --profile ovh-admin \
     --endpoint-url "$ENDPOINT" --bucket "$BUCKET" \
     --lifecycle-configuration file://ops/ovh/lifecycle.json

   # Vérification
   aws s3api get-bucket-lifecycle-configuration --profile ovh-admin \
     --endpoint-url "$ENDPOINT" --bucket "$BUCKET"
   ```

5. **CapRover** → l'app → variables d'environnement :
   `LITESTREAM_BUCKET`, `LITESTREAM_REGION`, `LITESTREAM_ACCESS_KEY_ID`,
   `LITESTREAM_SECRET_ACCESS_KEY` (clé de `grindrise-litestream`). Redéployer.

---

## 4. Vérifications au premier déploiement

Dans les logs CapRover :

- `replicating to` avec le bucket, puis `snapshot complete` peu après ;
- le warning `retention disabled; cloud provider lifecycle policies must handle
  retention` est **normal** : c'est voulu, la rétention est dans le bucket ;
- **aucun** `AccessDenied`. S'il y en a un, Litestream tente une opération que
  la politique n'autorise pas : relever l'action citée et l'ajouter à la
  politique, **sauf s'il s'agit d'une suppression** (`DeleteObject`), à me
  signaler plutôt que d'accorder.

Dans le bucket, après un premier achat de test :

```bash
aws s3 ls --recursive --profile ovh-admin --endpoint-url "$ENDPOINT" \
  "s3://$BUCKET/orders/ltx/"
```

---

## 5. Test de restauration — une fois par trimestre

Une sauvegarde jamais restaurée n'est pas une sauvegarde. Depuis ta machine,
avec le binaire Litestream (même version que le Dockerfile) :

```bash
export DATA_DIR=/data   # sert seulement à résoudre le chemin de litestream.yml
export LITESTREAM_BUCKET=grindrise-orders-backup LITESTREAM_REGION=<region>
export LITESTREAM_ACCESS_KEY_ID=<clé admin> LITESTREAM_SECRET_ACCESS_KEY=<secret admin>

litestream restore -config litestream.yml -o /tmp/verif.db /data/orders.db

node -e "const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/tmp/verif.db',{readOnly:true});
console.log(db.prepare('SELECT count(*) n, max(created_at) derniere FROM orders').get());
console.log(db.prepare('SELECT count(*) n, max(created_at) dernier FROM order_events').get());"
```

Le dernier événement doit dater de la dernière activité du site. Pour un état
passé : ajouter `-timestamp 2026-10-01T12:00:00Z`.

---

## 6. En cas de sinistre

- **Volume perdu ou vidé** : redéployer. Le container voit `orders.db` absente
  et la restaure depuis le bucket avant de démarrer le serveur. Rien d'autre
  à faire.
- **VPS perdu** : nouveau VPS, CapRover, même app, mêmes variables : même
  effet. Redéposer les PDF depuis leurs originaux.
- **Base corrompue ou mauvaise manipulation** (le fichier existe mais son
  contenu est faux) : restaurer localement à un instant antérieur avec
  `-timestamp`, et contrôler le résultat avant de remplacer quoi que ce soit en
  production. Remplacer la base d'un Litestream en service n'est pas anodin :
  consulter la [documentation](https://litestream.io/) de la version en place
  avant de le faire.

---

## 7. Limites connues

- **Panne du bucket en cours de route** : les contrôles ne portent que sur le
  démarrage. Si OVH devient injoignable ensuite, Litestream réessaie et le
  signale dans les logs, mais le serveur continue d'encaisser. Les écritures
  restent sur le volume et partent dès le retour du bucket. Une alerte sur ces
  logs, ou sur les métriques de Litestream, serait l'étape suivante.
- **Architecture** : l'image embarque le binaire `linux-x86_64`, ce qui
  correspond aux VPS OVH actuels. Un serveur ARM demanderait l'archive
  `linux-arm64` et sa propre somme de contrôle.
- **PDF** : hors de cette sauvegarde. Leurs originaux sont conservés hors du
  serveur.
