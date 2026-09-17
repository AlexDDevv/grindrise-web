import { renderDeliveryEmail } from './delivery';

const entree = {
  productName: "Guide d'entraînement Grindrise",
  downloadUrl: 'https://exemple.fr/api/download/abc.def',
  ttlDays: 7,
};

describe('renderDeliveryEmail', () => {
  it('place le lien de téléchargement dans les deux versions', () => {
    // La version texte n'est pas décorative : sans elle, les clients qui
    // bloquent le HTML affichent un message vide, sans moyen de télécharger.
    const { html, text } = renderDeliveryEmail(entree);

    expect(html).toContain(entree.downloadUrl);
    expect(text).toContain(entree.downloadUrl);
  });

  it('nomme le produit dans le sujet', () => {
    expect(renderDeliveryEmail(entree).subject).toContain("Guide d'entraînement Grindrise");
  });

  it('annonce la durée de validité du lien', () => {
    // L'acheteur doit savoir que le lien expire avant de le découvrir mort.
    const { html, text } = renderDeliveryEmail(entree);

    expect(html).toContain('7');
    expect(text).toContain('7');
  });

  it('échappe le HTML du nom de produit', () => {
    const { html } = renderDeliveryEmail({ ...entree, productName: '<script>alert(1)</script>' });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
