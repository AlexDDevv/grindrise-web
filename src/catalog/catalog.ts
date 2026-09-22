/**
 * Catalogue en dur.
 *
 * Deux ebooks ne justifient pas une table produit : un changement de prix
 * serait une migration là où c'est une ligne de code et un redéploiement.
 * Le jour où le catalogue grossit ou change sans redéploiement, c'est ce
 * fichier qui devient une table — les consommateurs ne voient que `findProduct`.
 *
 * `fileName` désigne un fichier de `${DATA_DIR}/ebooks/`, déposé manuellement
 * dans le volume CapRover.
 */
export type Product = {
  id: string;
  name: string;
  description: string;
  /** En centimes : PayPlug raisonne en plus petite unité monétaire. */
  priceCents: number;
  /** PayPlug n'encaisse qu'en euros. */
  currency: 'EUR';
  fileName: string;
};

export const CATALOG: readonly Product[] = [
  {
    id: 'entrainement',
    name: "Guide d'entraînement Grindrise",
    description: 'Le programme complet pour structurer sa progression.',
    priceCents: 1990,
    currency: 'EUR',
    fileName: 'entrainement.pdf',
  },
];

export function findProduct(id: string): Product | undefined {
  return CATALOG.find((produit) => produit.id === id);
}
