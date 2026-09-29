/**
 * Email de livraison.
 *
 * Mise en page en tableaux et styles en ligne : c'est la seule forme que les
 * clients de messagerie rendent de façon fiable. Aucune image, la marque est du
 * texte — beaucoup de clients bloquent les images par défaut, et un email de
 * livraison ne peut pas se permettre d'arriver vide.
 *
 * Le fond sombre est forcé par `bgcolor` autant que par CSS : les clients qui
 * inversent les couleurs produisent une version claire, elle aussi lisible,
 * puisque tout le texte est clair sur fond sombre.
 *
 * Un lien par ebook plutôt qu'une archive : le pack en contient deux, et
 * dézipper sur un téléphone est précisément le frein à éviter juste après un
 * paiement. La version texte reste complète : sans elle, un client qui bloque
 * le HTML afficherait un message vide, sans moyen de télécharger.
 */
function escapeHtml(valeur: string): string {
  return valeur
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export type DeliveryLink = { title: string; url: string };

export type DeliveryEmailInput = {
  productName: string;
  links: readonly DeliveryLink[];
  ttlDays: number;
  maxUses: number;
  /** Sert aux liens légaux du pied de page. */
  baseUrl: string;
};

const POLICE_TITRE = "Grenze,Georgia,'Times New Roman',serif";
const POLICE_TEXTE = "'IBM Plex Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const POLICE_MONO = "'JetBrains Mono',Menlo,Consolas,monospace";

/** Un bloc par fichier acheté : titre de l'ebook, puis son bouton. */
function blocEbook(lien: DeliveryLink): string {
  return `              <tr>
                <td style="padding:0 0 12px 0;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #4a423b;background-color:#1b1514;" bgcolor="#1b1514">
                    <tr>
                      <td style="padding:20px 20px 8px 20px;font-family:${POLICE_TITRE};font-size:24px;line-height:28px;font-weight:700;color:#f3e7d3;">${escapeHtml(lien.title)}</td>
                    </tr>
                    <tr>
                      <td style="padding:8px 20px 20px 20px;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                          <tr>
                            <td bgcolor="#c08a34" style="background-color:#c08a34;">
                              <a href="${escapeHtml(lien.url)}" style="display:inline-block;padding:15px 24px;font-family:${POLICE_TEXTE};font-size:16px;line-height:20px;font-weight:600;color:#1c1206;text-decoration:none;">Télécharger le PDF</a>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>`;
}

export function renderDeliveryEmail(input: DeliveryEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const pluriel = input.links.length > 1;
  const validite = `valable${pluriel ? 's' : ''} ${input.ttlDays} jours, ${input.maxUses} téléchargements`;
  const legal = input.baseUrl.replace(/\/+$/, '');

  const html = `<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>Tes ebooks GrindRise</title>
<style>
  :root{color-scheme:dark light;supported-color-schemes:dark light}
  body{margin:0!important;padding:0!important;width:100%!important}
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
  @media (max-width:620px){.px{padding-left:20px!important;padding-right:20px!important}}
</style>
</head>
<body style="margin:0;padding:0;background-color:#120f0d;" bgcolor="#120f0d">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Tes liens de téléchargement : ${validite}.&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#120f0d" style="background-color:#120f0d;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr>
          <td class="px" style="padding:12px 32px 20px 32px;border-bottom:1px solid #3a332d;font-family:${POLICE_TITRE};font-size:20px;line-height:24px;font-weight:700;letter-spacing:3px;color:#f3e7d3;">GRINDRISE</td>
        </tr>
        <tr>
          <td class="px" style="padding:32px 32px 8px 32px;font-family:${POLICE_MONO};font-size:12px;line-height:16px;letter-spacing:2px;text-transform:uppercase;color:#e0b26a;">Paiement confirmé</td>
        </tr>
        <tr>
          <td class="px" style="padding:0 32px 16px 32px;font-family:${POLICE_TITRE};font-size:34px;line-height:38px;font-weight:700;color:#f3e7d3;">${pluriel ? 'Tes ebooks sont prêts' : 'Ton ebook est prêt'}</td>
        </tr>
        <tr>
          <td class="px" style="padding:0 32px 24px 32px;font-family:${POLICE_TEXTE};font-size:16px;line-height:26px;color:#ddd5c8;">Merci pour ton achat de <strong style="color:#f3e7d3;">${escapeHtml(input.productName)}</strong>. ${pluriel ? 'Voici un lien par ebook.' : 'Voici ton lien de téléchargement.'} Chaque lien est <strong style="color:#f3e7d3;">${validite}</strong> : enregistre le fichier sur ton appareil dès maintenant.</td>
        </tr>
        <tr>
          <td class="px" style="padding:0 32px 12px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${input.links.map(blocEbook).join('\n')}
            </table>
          </td>
        </tr>
        <tr>
          <td class="px" style="padding:12px 32px 0 32px;font-family:${POLICE_TEXTE};font-size:15px;line-height:24px;color:#ddd5c8;"><strong style="color:#f3e7d3;">Un problème ?</strong> Lien expiré, fichier illisible, rien ne s’ouvre : réponds simplement à cet email, on te répond et on renvoie les liens.</td>
        </tr>
        <tr>
          <td class="px" style="padding:24px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #3a332d;font-size:0;line-height:0;">&nbsp;</td></tr></table>
          </td>
        </tr>
        <tr>
          <td class="px" style="padding:16px 32px 0 32px;font-family:${POLICE_TEXTE};font-size:13px;line-height:21px;color:#b3aa9d;">Rappel : avant le paiement, tu as accepté les conditions de vente et renoncé à ton droit de rétractation dès l’accès aux fichiers (article L221-28 13° du Code de la consommation).</td>
        </tr>
        <tr>
          <td class="px" style="padding:16px 32px 8px 32px;font-family:${POLICE_TEXTE};font-size:13px;line-height:21px;color:#b3aa9d;">
            <a href="${legal}/legal/cgv" style="color:#e0b26a;text-decoration:underline;">Conditions de vente</a> &nbsp;·&nbsp;
            <a href="${legal}/legal/confidentialite" style="color:#e0b26a;text-decoration:underline;">Confidentialité</a> &nbsp;·&nbsp;
            <a href="${legal}/legal/mentions-legales" style="color:#e0b26a;text-decoration:underline;">Mentions légales</a>
          </td>
        </tr>
        <tr>
          <td class="px" style="padding:8px 32px 24px 32px;font-family:${POLICE_TEXTE};font-size:13px;line-height:21px;color:#b3aa9d;">GrindRise · grindrise.fr</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    'GRINDRISE',
    '=========',
    '',
    `Paiement confirmé — ${pluriel ? 'tes ebooks sont prêts' : 'ton ebook est prêt'}.`,
    '',
    `Merci pour ton achat de ${input.productName}.`,
    `Chaque lien est ${validite} :`,
    'enregistre le fichier sur ton appareil dès maintenant.',
    '',
    ...input.links.flatMap((lien) => ['--', lien.title, lien.url, '']),
    '--',
    '',
    'Un problème ? Lien expiré, fichier illisible, rien ne s’ouvre :',
    'réponds simplement à cet email, on te répond et on renvoie les liens.',
    '',
    'Rappel : avant le paiement, tu as accepté les conditions de vente',
    'et renoncé à ton droit de rétractation dès l’accès aux fichiers',
    '(article L221-28 13° du Code de la consommation).',
    '',
    `Conditions de vente : ${legal}/legal/cgv`,
    `Confidentialité     : ${legal}/legal/confidentialite`,
    `Mentions légales    : ${legal}/legal/mentions-legales`,
    '',
    'GrindRise · grindrise.fr',
  ].join('\n');

  return {
    subject: pluriel
      ? `Vos ebooks : ${input.productName}`
      : `Votre ebook : ${input.productName}`,
    html,
    text,
  };
}
