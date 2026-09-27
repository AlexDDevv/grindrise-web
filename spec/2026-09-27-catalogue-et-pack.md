# Catalogue réel, pack de deux ebooks et quota par fichier

Date : 2026-09-27

Complète [`2026-09-22-migration-payplug.md`](2026-09-22-migration-payplug.md) :
le paiement ne change pas, c'est ce qui est vendu et livré qui change.

---

## 1. Ce qui est vendu

| Offre | `id` | Prix | Fichiers livrés |
| ----- | ---- | ---- | --------------- |
| Le corps qui tient | `corps-qui-tient` | 9,90 € | `le-corps-qui-tient.pdf` |
| Ce que l'assiette construit | `assiette` | 9,90 € | `ce-que-lassiette-construit.pdf` |
| Les deux ebooks | `pack-complet` | 14,90 € | les deux |

Les titres affichés sont ceux des PDF eux-mêmes : l'acheteur doit retrouver dans
son fichier ce qu'il a lu sur la page d'achat.

**Rien à créer côté PayPlug.** Chaque paiement est créé à la volée avec son
montant ; leur portail n'a aucun catalogue à tenir. `src/catalog/catalog.ts` est
la seule source de vérité des prix.

---

## 2. Un lien par ebook, pas d'archive

Le pack livre deux fichiers. Deux options se présentaient : une archive ZIP
préparée à la main, ou un lien signé par fichier. Retenu : **un lien par
fichier**.

- Corriger un ebook = remplacer un PDF dans le volume. Avec un ZIP, il faudrait
  le reconstruire à chaque fois, et un oubli livrerait une version périmée.
- Dézipper sur un téléphone est un frein réel, juste après un paiement.
- Le journal d'audit sait quel ebook a été téléchargé, pas seulement « le pack ».
- Le quota s'applique par fichier : 5 téléchargements pour chacun, pas 5 pour
  l'ensemble.

Coût assumé : le modèle porte désormais un indice de fichier, du token jusqu'au
compteur.

---

## 3. Modèle

`Product.files` est une liste de `Ebook` (`title`, `subtitle`, `fileName`).
**L'ordre de cette liste est structurant** : c'est l'indice porté par chaque
token. Réordonner les fichiers d'une offre invaliderait les liens déjà envoyés
— ajouter en fin de liste est sans risque, insérer au milieu ne l'est pas.

Le token de téléchargement porte `{ orderId, fileIndex, exp }`. Un indice
absent, négatif ou fractionnaire est refusé plutôt que ramené à 0 : un token de
l'ancien format ne doit pas livrer le premier fichier par défaut.

### `order_downloads`

| Colonne      | Type    | Rôle                                          |
| ------------ | ------- | --------------------------------------------- |
| `order_id`   | TEXT    | Clé primaire avec `file_index`                |
| `file_index` | INTEGER | Position dans `Product.files`                 |
| `count`      | INTEGER | Téléchargements consommés pour CE fichier     |
| `first_at`   | TEXT    | ISO 8601                                      |
| `last_at`    | TEXT    | ISO 8601                                      |

Le contrôle du quota, l'incrément et la vérification que la commande est payée
tiennent en une seule instruction (`INSERT … SELECT … ON CONFLICT DO UPDATE …
WHERE count < ?`) : les séparer rouvrirait la fenêtre de concurrence que le
verrou d'idempotence ferme ailleurs.

`orders.download_count` subsiste comme total de la commande, redondant mais
pratique pour la question « cette commande a-t-elle été téléchargée ? ».

Le schéma s'ajoute sans migration : `order_downloads` est une table neuve, et
les commandes antérieures n'ont pas de ligne — leur quota repart donc de zéro.
Acceptable, il n'existait que des commandes de test.

---

## 4. Page d'achat

`public/ebooks/index.html` présente les trois offres, avec un champ email unique
et un bouton par offre (`name="productId"`). Les prix y sont saisis à la main :
quatre tests (`src/catalog/catalog.spec.ts`) verrouillent la cohérence avec le
catalogue — identifiants existants, toutes les offres présentes, prix affiché
égal au prix facturé, titres des ebooks présents — et un cinquième vérifie que
le script de la page reste syntaxiquement valide.

---

## 5. Déploiement

Les deux PDF doivent être déposés dans le volume sous les noms exacts du
catalogue :

```
/data/ebooks/le-corps-qui-tient.pdf
/data/ebooks/ce-que-lassiette-construit.pdf
```

Un nom qui ne correspond pas produit un `download_refused` avec
`reason: "file_missing"` et un 500 pour l'acheteur — sans consommer son quota.
