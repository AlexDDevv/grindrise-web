import { PermanentEmailError, TransientEmailError, type EmailMessage } from './email-provider';
import { BrevoEmailProvider } from './brevo.provider';
import { logger } from '../logger';

const message: EmailMessage = {
  to: { email: 'joueur@exemple.fr', name: 'Ferrum' },
  subject: 'Niveau 5 atteint',
  html: '<p>Bravo</p>',
  text: 'Bravo',
};

function respondWith(status: number, body = '{}'): jest.SpyInstance {
  return jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(body, { status }));
}

describe('BrevoEmailProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it("appelle l'API transactionnelle avec la clé en en-tête", async () => {
    const fetchSpy = respondWith(201, '{"messageId":"<abc@brevo>"}');
    const provider = new BrevoEmailProvider('xkeysib-test', {
      email: 'expediteur@exemple.fr',
      name: 'Grindrise',
    });

    await provider.send(message);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test');
  });

  it('envoie un corps conforme au format Brevo', async () => {
    const fetchSpy = respondWith(201);
    const provider = new BrevoEmailProvider('xkeysib-test', {
      email: 'expediteur@exemple.fr',
      name: 'Grindrise',
    });

    await provider.send(message);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { email: 'expediteur@exemple.fr', name: 'Grindrise' },
      to: [{ email: 'joueur@exemple.fr', name: 'Ferrum' }],
      subject: 'Niveau 5 atteint',
      htmlContent: '<p>Bravo</p>',
      textContent: 'Bravo',
    });
  });

  it("n'ajoute replyTo que s'il est configuré", async () => {
    const fetchSpy = respondWith(201);
    const provider = new BrevoEmailProvider('xkeysib-test', {
      email: 'expediteur@exemple.fr',
      name: 'Grindrise',
      replyTo: 'contact@exemple.fr',
    });

    await provider.send(message);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).replyTo).toEqual({ email: 'contact@exemple.fr' });
  });

  it.each([400, 401, 403])('traite %i comme un échec définitif', async (status) => {
    // Une clé invalide ou un expéditeur non validé ne guérira pas en cinq
    // tentatives : il faut que ça remonte tout de suite.
    respondWith(status, '{"message":"Key not found"}');
    const provider = new BrevoEmailProvider('mauvaise-cle', {
      email: 'expediteur@exemple.fr',
      name: 'Grindrise',
    });

    await expect(provider.send(message)).rejects.toBeInstanceOf(PermanentEmailError);
  });

  it.each([429, 500, 503])('traite %i comme un échec passager', async (status) => {
    // 429 (quota) comme 5xx (panne fournisseur) sont traités comme passagers :
    // Une erreur passagère laisse la commande en delivery_failed, consultable
    // pour un renvoi manuel —
    // il ne se rattrape pas tout seul « au lendemain ».
    respondWith(status, '{"message":"Too many requests"}');
    const provider = new BrevoEmailProvider('xkeysib-test', {
      email: 'expediteur@exemple.fr',
      name: 'Grindrise',
    });

    await expect(provider.send(message)).rejects.toBeInstanceOf(TransientEmailError);
  });

  it('traite une panne réseau comme un échec passager', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const provider = new BrevoEmailProvider('xkeysib-test', {
      email: 'expediteur@exemple.fr',
      name: 'Grindrise',
    });

    await expect(provider.send(message)).rejects.toBeInstanceOf(TransientEmailError);
  });

  it('assortit l\'appel Brevo d\'un délai d\'expiration', async () => {
    const fetchSpy = respondWith(201);
    const provider = new BrevoEmailProvider('xkeysib-test', {
      email: 'expediteur@exemple.fr',
      name: 'Grindrise',
    });

    await provider.send(message);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('traite un dépassement de délai comme un échec passager, à rejouer', async () => {
    // C'est exactement ce que produit `AbortSignal.timeout` quand il se
    // déclenche : une `DOMException` nommée `TimeoutError`. Undici attend
    // 300 s par défaut sans timeout — sans reprise possible, un slot de
    // traitement resterait immobilisé cinq minutes.
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    const provider = new BrevoEmailProvider('xkeysib-test', {
      email: 'expediteur@exemple.fr',
      name: 'Grindrise',
    });

    const failure = provider.send(message);

    await expect(failure).rejects.toBeInstanceOf(TransientEmailError);
    await expect(failure).rejects.not.toBeInstanceOf(PermanentEmailError);
  });

  it("ne met jamais le corps de la réponse Brevo dans le message d'erreur", async () => {
    // Les réponses 400 de Brevo pour destinataire invalide ou bloqué
    // contiennent l'adresse email — le seul chemin par lequel une donnée
    // personnelle pourrait entrer dans les logs (`reason: error.message`
    // par l'appelant). Le message d'erreur doit rester générique : le code
    // HTTP suffit à diagnostiquer, le détail complet reste disponible en
    // debug, jamais en warn/error.
    const emailInBody = 'joueur@exemple.fr';
    respondWith(400, `{"code":"invalid_parameter","message":"${emailInBody} n'est pas valide"}`);
    const provider = new BrevoEmailProvider('xkeysib-test', {
      email: 'expediteur@exemple.fr',
      name: 'Grindrise',
    });

    let caught: unknown;
    try {
      await provider.send(message);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PermanentEmailError);
    const err = caught as Error;
    expect(err.message).not.toContain(emailInBody);
    expect(err.message).toContain('400');
  });

  it("ne journalise jamais une adresse email au niveau warn ou error, même si Brevo la renvoie", async () => {
    const emailInBody = 'joueur@exemple.fr';
    respondWith(400, `{"message":"${emailInBody} bloqué"}`);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const provider = new BrevoEmailProvider('xkeysib-test', {
      email: 'expediteur@exemple.fr',
      name: 'Grindrise',
    });

    await provider.send(message).catch(() => undefined);

    const loggedTexts = [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((call) =>
      JSON.stringify(call),
    );
    expect(loggedTexts.some((text) => text.includes(emailInBody))).toBe(false);
  });
});
