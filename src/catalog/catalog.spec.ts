import { CATALOG, findProduct } from './catalog';

describe('catalogue', () => {
  it('expose au moins un produit', () => {
    expect(CATALOG.length).toBeGreaterThan(0);
  });

  it('retrouve un produit par son identifiant', () => {
    const premier = CATALOG[0];

    expect(findProduct(premier.id)).toEqual(premier);
  });

  it('renvoie undefined pour un identifiant inconnu', () => {
    // Un id inconnu vient d'un client qui invente sa requête : il doit être
    // refusé côté route, pas produire un paiement PayPlug fantôme.
    expect(findProduct('nexiste-pas')).toBeUndefined();
  });

  it("n'accepte que des prix entiers en centimes et strictement positifs", () => {
    for (const produit of CATALOG) {
      expect(Number.isInteger(produit.priceCents)).toBe(true);
      expect(produit.priceCents).toBeGreaterThan(0);
    }
  });

  it("n'a aucun identifiant en double", () => {
    const ids = CATALOG.map((p) => p.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ne référence que des noms de fichier sans composant de chemin', () => {
    // Un fileName contenant « ../ » ferait servir un fichier hors de DATA_DIR
    // par la route de téléchargement.
    for (const produit of CATALOG) {
      expect(produit.fileName).toMatch(/^[\w.-]+\.pdf$/);
    }
  });
});
