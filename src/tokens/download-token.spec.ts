import { signDownloadToken, verifyDownloadToken } from './download-token';

const SECRET = 'secret-de-test';

describe('tokens de téléchargement', () => {
  it("vérifie un token qu'il vient de signer", () => {
    const token = signDownloadToken('cs_test_1', SECRET, 7);

    expect(verifyDownloadToken(token, SECRET)).toBe('cs_test_1');
  });

  it('rejette un token signé avec un autre secret', () => {
    // C'est ce qui empêche un acheteur de forger un lien vers la commande d'un
    // autre en devinant le format.
    const token = signDownloadToken('cs_test_1', SECRET, 7);

    expect(verifyDownloadToken(token, 'mauvais-secret')).toBeNull();
  });

  it('rejette un token dont la charge utile a été modifiée', () => {
    const token = signDownloadToken('cs_test_1', SECRET, 7);
    const [, signature] = token.split('.');
    const charge = Buffer.from(
      JSON.stringify({ orderId: 'cs_autre', exp: 99999999999 }),
    ).toString('base64url');

    expect(verifyDownloadToken(`${charge}.${signature}`, SECRET)).toBeNull();
  });

  it('rejette un token expiré', () => {
    const emis = new Date('2026-01-01T00:00:00Z');
    const token = signDownloadToken('cs_test_1', SECRET, 7, emis);

    expect(verifyDownloadToken(token, SECRET, new Date('2026-01-09T00:00:00Z'))).toBeNull();
  });

  it('accepte un token encore dans sa fenêtre de validité', () => {
    const emis = new Date('2026-01-01T00:00:00Z');
    const token = signDownloadToken('cs_test_1', SECRET, 7, emis);

    expect(verifyDownloadToken(token, SECRET, new Date('2026-01-05T00:00:00Z'))).toBe('cs_test_1');
  });

  it("rejette une chaîne malformée sans lever d'exception", () => {
    // La route de téléchargement passe une valeur d'URL arbitraire : un token
    // illisible doit produire un refus, pas un 500.
    for (const invalide of ['', 'nimportequoi', 'a.b.c', '...', 'AAAA.BBBB']) {
      expect(verifyDownloadToken(invalide, SECRET)).toBeNull();
    }
  });
});
