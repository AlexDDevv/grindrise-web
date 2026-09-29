import { renderDeliveryEmail } from './delivery';

const unEbook = {
  productName: 'Le corps qui tient',
  links: [{ title: 'Le corps qui tient', url: 'https://exemple.fr/api/download/abc.def' }],
  ttlDays: 7,
  maxUses: 5,
  baseUrl: 'https://exemple.fr',
};

const pack = {
  productName: 'Les deux ebooks',
  links: [
    { title: 'Le corps qui tient', url: 'https://exemple.fr/api/download/un.aaa' },
    { title: 'Ce que l’assiette construit', url: 'https://exemple.fr/api/download/deux.bbb' },
  ],
  ttlDays: 7,
  maxUses: 5,
  baseUrl: 'https://exemple.fr',
};

describe('renderDeliveryEmail', () => {
  it('place le lien de téléchargement dans les deux versions', () => {
    // La version texte n'est pas décorative : sans elle, les clients qui
    // bloquent le HTML affichent un message vide, sans moyen de télécharger.
    const { html, text } = renderDeliveryEmail(unEbook);

    expect(html).toContain(unEbook.links[0].url);
    expect(text).toContain(unEbook.links[0].url);
  });

  it('place un lien par ebook pour le pack, dans les deux versions', () => {
    // Un lien manquant, c'est un ebook payé et non livré.
    const { html, text } = renderDeliveryEmail(pack);

    for (const lien of pack.links) {
      expect(html).toContain(lien.url);
      expect(text).toContain(lien.url);
    }
  });

  it('nomme chaque ebook à côté de son lien', () => {
    // Deux liens nus seraient indiscernables : l'acheteur doit savoir lequel
    // ouvre quel ebook.
    const { html, text } = renderDeliveryEmail(pack);

    expect(html).toContain('Ce que l’assiette construit');
    expect(text).toContain('Le corps qui tient');
  });

  it('nomme le produit dans le sujet, au bon nombre', () => {
    expect(renderDeliveryEmail(unEbook).subject).toBe('Votre ebook : Le corps qui tient');
    expect(renderDeliveryEmail(pack).subject).toBe('Vos ebooks : Les deux ebooks');
  });

  it('renvoie vers les pages légales du site', () => {
    // Le pied de l'email doit rester opposable : les liens suivent l'URL
    // publique configurée, jamais un domaine écrit en dur.
    const { html, text } = renderDeliveryEmail(unEbook);

    expect(html).toContain('https://exemple.fr/legal/cgv');
    expect(text).toContain('https://exemple.fr/legal/mentions-legales');
  });

  it('annonce le quota de téléchargements', () => {
    const { html, text } = renderDeliveryEmail(unEbook);

    expect(html).toContain('5 téléchargements');
    expect(text).toContain('5 téléchargements');
  });

  it('annonce la durée de validité des liens', () => {
    // L'acheteur doit savoir que le lien expire avant de le découvrir mort.
    const { html, text } = renderDeliveryEmail(unEbook);

    expect(html).toContain('7');
    expect(text).toContain('7');
  });

  it('rappelle le renoncement au droit de rétractation', () => {
    // La confirmation de commande doit reprendre le consentement donné avant
    // le paiement (article L221-13 du Code de la consommation).
    const { html, text } = renderDeliveryEmail(unEbook);

    expect(html).toContain('droit de rétractation');
    expect(text).toContain('droit de rétractation');
  });

  it('échappe le HTML du nom de produit et des titres', () => {
    const { html } = renderDeliveryEmail({
      ...unEbook,
      productName: '<script>alert(1)</script>',
      links: [{ title: '<img src=x>', url: 'https://exemple.fr/api/download/a.b' }],
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;');
  });
});
