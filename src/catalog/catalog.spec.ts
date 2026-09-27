import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
      for (const ebook of produit.files) {
        expect(ebook.fileName).toMatch(/^[\w.-]+\.pdf$/);
      }
    }
  });

  it('livre au moins un fichier par offre', () => {
    // Une offre sans fichier encaisserait un paiement sans rien à livrer.
    for (const produit of CATALOG) {
      expect(produit.files.length).toBeGreaterThan(0);
    }
  });

  it('propose le pack moins cher que la somme de ses ebooks', () => {
    // C'est la seule raison d'exister du pack : si l'inégalité s'inverse après
    // un changement de prix, l'offre devient mensongère.
    const pack = findProduct('pack-complet')!;
    const separement = pack.files
      .map(
        (ebook) =>
          CATALOG.find((p) => p.files.length === 1 && p.files[0].fileName === ebook.fileName)!,
      )
      .reduce((total, produit) => total + produit.priceCents, 0);

    expect(pack.priceCents).toBeLessThan(separement);
  });

  it('vend chaque ebook du pack aussi à l’unité', () => {
    const pack = findProduct('pack-complet')!;

    for (const ebook of pack.files) {
      const unitaire = CATALOG.find(
        (p) => p.files.length === 1 && p.files[0].fileName === ebook.fileName,
      );
      expect(unitaire).toBeDefined();
    }
  });

  describe("cohérence avec la page d'achat", () => {
    // La page est statique : ses prix et ses identifiants sont saisis à la
    // main. Ce test est le garde-fou contre la dérive — un identifiant erroné
    // donnerait un 404 au clic, un prix erroné ferait payer autre chose que
    // l'affiché.
    const page = readFileSync(
      join(__dirname, '..', '..', 'public', 'ebooks', 'index.html'),
      'utf8',
    );
    const offresDeLaPage = [...page.matchAll(/name="productId" value="([^"]+)"/g)].map(
      (m) => m[1],
    );

    it('ne propose que des offres existantes', () => {
      expect(offresDeLaPage.length).toBeGreaterThan(0);
      for (const id of offresDeLaPage) {
        expect(findProduct(id)).toBeDefined();
      }
    });

    it('propose toutes les offres du catalogue, une seule fois chacune', () => {
      expect([...offresDeLaPage].sort()).toEqual(CATALOG.map((p) => p.id).sort());
    });

    it('affiche le prix réellement facturé', () => {
      for (const produit of CATALOG) {
        const affiche = `${(produit.priceCents / 100).toFixed(2).replace('.', ',')} €`;
        expect(page).toContain(affiche);
      }
    });

    it('embarque un script syntaxiquement valide', () => {
      // La page n'est couverte par aucun outil de build : une apostrophe
      // typographique glissée dans une chaîne JavaScript casserait le bouton
      // d'achat sans que rien ne le signale.
      const script = /<script>([\s\S]*?)<\/script>/.exec(page)![1];

      expect(() => new Function(script)).not.toThrow();
    });

    it('affiche le titre de chaque ebook livré', () => {
      for (const ebook of CATALOG.flatMap((p) => p.files)) {
        expect(page).toContain(ebook.title);
      }
    });
  });
});
