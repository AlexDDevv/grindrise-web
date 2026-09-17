/**
 * Email de livraison.
 *
 * Volontairement sans mise en forme élaborée : le design viendra avec le reste.
 * Ce qui compte ici, c'est que le lien soit trouvable dans les deux versions et
 * que sa durée de validité soit annoncée — un acheteur qui découvre un lien
 * mort sans avoir été prévenu écrit au support.
 */
function escapeHtml(valeur: string): string {
  return valeur
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderDeliveryEmail(input: {
  productName: string;
  downloadUrl: string;
  ttlDays: number;
}): { subject: string; html: string; text: string } {
  const nom = escapeHtml(input.productName);
  const lien = escapeHtml(input.downloadUrl);

  return {
    subject: `Votre ebook : ${input.productName}`,
    html: [
      `<p>Merci pour votre achat de <strong>${nom}</strong>.</p>`,
      `<p><a href="${lien}">Télécharger votre ebook</a></p>`,
      `<p>Ce lien reste valable ${input.ttlDays} jours.</p>`,
      `<p>Un problème pour télécharger ? Répondez simplement à cet email.</p>`,
    ].join('\n'),
    text: [
      `Merci pour votre achat de ${input.productName}.`,
      '',
      'Télécharger votre ebook :',
      input.downloadUrl,
      '',
      `Ce lien reste valable ${input.ttlDays} jours.`,
      '',
      'Un problème pour télécharger ? Répondez simplement à cet email.',
    ].join('\n'),
  };
}
