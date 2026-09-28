/**
 * Email de livraison.
 *
 * Volontairement sans mise en forme élaborée : le design viendra avec le reste.
 * Ce qui compte ici, c'est que les liens soient trouvables dans les deux
 * versions et que leur durée de validité soit annoncée — un acheteur qui
 * découvre un lien mort sans avoir été prévenu écrit au support.
 *
 * Un lien par ebook plutôt qu'une archive : le pack en contient deux, et
 * dézipper sur un téléphone est précisément le frein à éviter juste après un
 * paiement.
 */
function escapeHtml(valeur: string): string {
  return valeur
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export type DeliveryLink = { title: string; url: string };

export function renderDeliveryEmail(input: {
  productName: string;
  links: readonly DeliveryLink[];
  ttlDays: number;
}): { subject: string; html: string; text: string } {
  const pluriel = input.links.length > 1;
  const nom = escapeHtml(input.productName);

  return {
    subject: pluriel
      ? `Vos ebooks : ${input.productName}`
      : `Votre ebook : ${input.productName}`,
    html: [
      `<p>Merci pour votre achat de <strong>${nom}</strong>.</p>`,
      '<ul>',
      ...input.links.map(
        (lien) =>
          `  <li><a href="${escapeHtml(lien.url)}">Télécharger « ${escapeHtml(lien.title)} »</a></li>`,
      ),
      '</ul>',
      `<p>${pluriel ? 'Ces liens restent valables' : 'Ce lien reste valable'} ${input.ttlDays} jours.</p>`,
      // Rappel du consentement donné avant le paiement : la confirmation de
      // commande doit le reprendre (article L221-13 du Code de la consommation).
      `<p>Vous avez demandé la livraison immédiate de ce contenu numérique et reconnu perdre,
         de ce fait, votre droit de rétractation.</p>`,
      `<p>Un problème pour télécharger ? Répondez simplement à cet email.</p>`,
    ].join('\n'),
    text: [
      `Merci pour votre achat de ${input.productName}.`,
      '',
      ...input.links.flatMap((lien) => [`${lien.title} :`, lien.url, '']),
      `${pluriel ? 'Ces liens restent valables' : 'Ce lien reste valable'} ${input.ttlDays} jours.`,
      '',
      'Vous avez demandé la livraison immédiate de ce contenu numérique et reconnu perdre,',
      'de ce fait, votre droit de rétractation.',
      '',
      'Un problème pour télécharger ? Répondez simplement à cet email.',
    ].join('\n'),
  };
}
