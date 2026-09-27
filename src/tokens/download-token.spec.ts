import { signDownloadToken, verifyDownloadToken } from './download-token';

const SECRET = 'secret-de-test';

describe('tokens de téléchargement', () => {
  it("vérifie un token qu'il vient de signer", () => {
    const token = signDownloadToken({ orderId: 'ord_1', fileIndex: 0 }, SECRET, 7);

    expect(verifyDownloadToken(token, SECRET)).toEqual({ orderId: 'ord_1', fileIndex: 0 });
  });

  it('rejette un token signé avec un autre secret', () => {
    // C'est ce qui empêche un acheteur de forger un lien vers la commande d'un
    // autre en devinant le format.
    const token = signDownloadToken({ orderId: 'ord_1', fileIndex: 0 }, SECRET, 7);

    expect(verifyDownloadToken(token, 'mauvais-secret')).toBeNull();
  });

  it('rejette un token dont la charge utile a été modifiée', () => {
    const token = signDownloadToken({ orderId: 'ord_1', fileIndex: 0 }, SECRET, 7);
    const [, signature] = token.split('.');
    const charge = Buffer.from(
      JSON.stringify({ orderId: 'ord_autre', fileIndex: 0, exp: 99999999999 }),
    ).toString('base64url');

    expect(verifyDownloadToken(`${charge}.${signature}`, SECRET)).toBeNull();
  });

  it('rejette un token expiré', () => {
    const emis = new Date('2026-01-01T00:00:00Z');
    const token = signDownloadToken({ orderId: 'ord_1', fileIndex: 0 }, SECRET, 7, emis);

    expect(verifyDownloadToken(token, SECRET, new Date('2026-01-09T00:00:00Z'))).toBeNull();
  });

  it('accepte un token encore dans sa fenêtre de validité', () => {
    const emis = new Date('2026-01-01T00:00:00Z');
    const token = signDownloadToken({ orderId: 'ord_1', fileIndex: 0 }, SECRET, 7, emis);

    expect(verifyDownloadToken(token, SECRET, new Date('2026-01-05T00:00:00Z'))).toEqual({
      orderId: 'ord_1',
      fileIndex: 0,
    });
  });

  it('distingue les fichiers d’une même commande', () => {
    // Le pack livre deux ebooks : chaque lien doit désigner le sien, et un
    // seul. Sinon un lien servirait n'importe quel fichier de la commande.
    const premier = signDownloadToken({ orderId: 'ord_1', fileIndex: 0 }, SECRET, 7);
    const second = signDownloadToken({ orderId: 'ord_1', fileIndex: 1 }, SECRET, 7);

    expect(premier).not.toBe(second);
    expect(verifyDownloadToken(second, SECRET)).toEqual({ orderId: 'ord_1', fileIndex: 1 });
  });

  it('rejette un indice de fichier absent, négatif ou fractionnaire', () => {
    // Un token de l'ancien format (sans indice) ou forgé ne doit pas livrer le
    // premier fichier par défaut.
    for (const charge of [
      { orderId: 'ord_1', exp: 99999999999 },
      { orderId: 'ord_1', fileIndex: -1, exp: 99999999999 },
      { orderId: 'ord_1', fileIndex: 0.5, exp: 99999999999 },
      { orderId: 'ord_1', fileIndex: '0', exp: 99999999999 },
    ]) {
      const encode = Buffer.from(JSON.stringify(charge)).toString('base64url');
      const signature = require('node:crypto')
        .createHmac('sha256', SECRET)
        .update(encode)
        .digest('base64url');

      expect(verifyDownloadToken(`${encode}.${signature}`, SECRET)).toBeNull();
    }
  });

  it("rejette une chaîne malformée sans lever d'exception", () => {
    // La route de téléchargement passe une valeur d'URL arbitraire : un token
    // illisible doit produire un refus, pas un 500.
    for (const invalide of ['', 'nimportequoi', 'a.b.c', '...', 'AAAA.BBBB']) {
      expect(verifyDownloadToken(invalide, SECRET)).toBeNull();
    }
  });
});
