/**
 * Catalogue en dur.
 *
 * Trois offres ne justifient pas une table produit : un changement de prix
 * serait une migration là où c'est une ligne de code et un redéploiement.
 * Le jour où le catalogue grossit ou change sans redéploiement, c'est ce
 * fichier qui devient une table — les consommateurs ne voient que `findProduct`.
 *
 * C'est aussi la SEULE source de vérité des prix : PayPlug ne connaît que le
 * montant qu'on lui envoie, il n'y a aucun catalogue à tenir de leur côté.
 *
 * `fileName` désigne un fichier de `${DATA_DIR}/ebooks/`, déposé manuellement
 * dans le volume CapRover.
 */

/** Un ebook livrable. Le titre est celui du PDF lui-même : l'acheteur doit
 *  retrouver dans son fichier ce qu'il a lu sur la page d'achat. */
export type Ebook = {
  title: string;
  subtitle: string;
  fileName: string;
};

const CORPS_QUI_TIENT: Ebook = {
  title: 'Le corps qui tient',
  subtitle: 'Ce que la science sait vraiment sur l’activité physique',
  fileName: 'le-corps-qui-tient.pdf',
};

const ASSIETTE: Ebook = {
  title: 'Ce que l’assiette construit',
  subtitle: 'Les fondamentaux de la nutrition pour qui s’entraîne',
  fileName: 'ce-que-lassiette-construit.pdf',
};

const PROGRAMME: Ebook = {
  title: 'Le programme qui tient',
  subtitle: 'Adapter l’entraînement à sa vie, et non l’inverse',
  fileName: 'le-programme-qui-tient.pdf',
};

export type Product = {
  id: string;
  name: string;
  description: string;
  /** En centimes : PayPlug raisonne en plus petite unité monétaire. */
  priceCents: number;
  /** PayPlug n'encaisse qu'en euros. */
  currency: 'EUR';
  /**
   * Les fichiers livrés par cette offre. Un par ebook : le pack en contient
   * deux, et l'acheteur reçoit un lien par fichier plutôt qu'une archive à
   * dézipper. L'ordre est celui des liens dans l'email et l'indice porté par
   * chaque token — le changer invaliderait les liens déjà envoyés.
   */
  files: readonly Ebook[];
};

export const CATALOG: readonly Product[] = [
  {
    id: 'corps-qui-tient',
    name: CORPS_QUI_TIENT.title,
    description:
      'Pourquoi bouger vraiment change tout : les mécanismes, les chiffres de mortalité et la psychologie de l’habitude, sans incantation ni programme tout fait.',
    priceCents: 990,
    currency: 'EUR',
    files: [CORPS_QUI_TIENT],
  },
  {
    id: 'assiette',
    name: ASSIETTE.title,
    description:
      'Ce que l’assiette construit : les macronutriments, l’équilibre énergétique et les mythes qui ont la vie dure, sans régime ni chiffre magique.',
    priceCents: 990,
    currency: 'EUR',
    files: [ASSIETTE],
  },
  {
    id: 'programme-qui-tient',
    name: PROGRAMME.title,
    description:
      'Pourquoi les programmes s’arrêtent, et ce qui les fait tenir : fréquence réaliste, progression, récupération et taux de présence, sans injonction à la discipline.',
    priceCents: 990,
    currency: 'EUR',
    files: [PROGRAMME],
  },
  {
    id: 'pack-complet',
    name: 'Les trois ebooks',
    description:
      'L’entraînement, la nutrition et la régularité : les trois volumes réunis, pour 19,90 € au lieu de 29,70 €.',
    priceCents: 1990,
    currency: 'EUR',
    // Le nouveau fichier est ajouté EN FIN de liste : les indices 0 et 1 sont
    // gravés dans les liens déjà envoyés aux acheteurs du pack à deux volumes.
    files: [CORPS_QUI_TIENT, ASSIETTE, PROGRAMME],
  },
];

export function findProduct(id: string): Product | undefined {
  return CATALOG.find((produit) => produit.id === id);
}
