import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Lien de téléchargement signé.
 *
 * Le token porte lui-même le fichier visé, sa date d'expiration et sa
 * signature : aucune table de tokens à maintenir. Il ne porte AUCUN droit à lui
 * seul — la route de téléchargement croise sa validité avec le quota stocké en
 * base. Sans ce second contrôle, un lien partagé fonctionnerait pour tout le
 * monde jusqu'à son expiration.
 *
 * `fileIndex` désigne une position dans `Product.files` : le pack livre deux
 * ebooks, donc deux liens, chacun avec son propre quota.
 */
type Payload = { orderId: string; fileIndex: number; exp: number };

/** Ce que le token désigne, une fois sa signature vérifiée. */
export type DownloadClaim = { orderId: string; fileIndex: number };

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signDownloadToken(
  claim: DownloadClaim,
  secret: string,
  ttlDays: number,
  now: Date = new Date(),
): string {
  const payload: Payload = {
    orderId: claim.orderId,
    fileIndex: claim.fileIndex,
    exp: now.getTime() + ttlDays * 24 * 60 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyDownloadToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): DownloadClaim | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  const attendue = sign(encoded, secret);

  // timingSafeEqual exige des longueurs égales et lève sinon : d'où la
  // comparaison de longueur d'abord. Une comparaison naïve par `===` fuiterait,
  // par son temps de retour, le nombre de caractères devinés correctement.
  const recue = Buffer.from(signature);
  const calculee = Buffer.from(attendue);
  if (recue.length !== calculee.length || !timingSafeEqual(recue, calculee)) return null;

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Payload;
  } catch {
    return null;
  }

  if (typeof payload?.orderId !== 'string' || typeof payload?.exp !== 'number') return null;
  // Un indice absent, négatif ou fractionnaire ne peut venir que d'un token
  // forgé ou d'une version antérieure du format : refuser plutôt que supposer 0,
  // qui livrerait un fichier que ce lien ne désigne pas.
  if (!Number.isInteger(payload?.fileIndex) || payload.fileIndex < 0) return null;
  if (payload.exp <= now.getTime()) return null;

  return { orderId: payload.orderId, fileIndex: payload.fileIndex };
}
