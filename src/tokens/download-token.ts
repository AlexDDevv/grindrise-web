import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Lien de téléchargement signé.
 *
 * Le token porte lui-même sa date d'expiration et sa signature : aucune table
 * de tokens à maintenir. Il ne porte AUCUN droit à lui seul — la route de
 * téléchargement croise sa validité avec le quota stocké en base. Sans ce
 * second contrôle, un lien partagé fonctionnerait pour tout le monde jusqu'à
 * son expiration.
 */
type Payload = { orderId: string; exp: number };

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signDownloadToken(
  orderId: string,
  secret: string,
  ttlDays: number,
  now: Date = new Date(),
): string {
  const payload: Payload = {
    orderId,
    exp: now.getTime() + ttlDays * 24 * 60 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyDownloadToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): string | null {
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
  if (payload.exp <= now.getTime()) return null;

  return payload.orderId;
}
