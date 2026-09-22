import { PayPlugClient, PayPlugError, payplugModeOf, type CreatePaymentParams } from './payplug.client';

const paiement = {
  id: 'pay_5iHMDxy4ABR4YBVW4UscIn',
  object: 'payment',
  is_live: false,
  is_paid: false,
  amount: 1990,
  currency: 'EUR',
  failure: null,
  hosted_payment: { payment_url: 'https://secure.payplug.com/pay/x' },
  metadata: { order_id: 'ord_1' },
};

const params: CreatePaymentParams = {
  amount: 1990,
  currency: 'EUR',
  billing: { email: 'acheteur@example.com', language: 'fr' },
  shipping: { email: 'acheteur@example.com', language: 'fr', delivery_type: 'DIGITAL_GOODS' },
  hosted_payment: { return_url: 'https://exemple.fr/success', cancel_url: 'https://exemple.fr/cancel' },
  notification_url: 'https://exemple.fr/api/payplug/notification',
  metadata: { order_id: 'ord_1' },
};

function respondWith(status: number, body: unknown = paiement): jest.SpyInstance {
  return jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('payplugModeOf', () => {
  it('reconnaît les préfixes test et live, et rien d’autre', () => {
    expect(payplugModeOf('sk_test_abc')).toBe('test');
    expect(payplugModeOf('sk_live_abc')).toBe('live');
    expect(payplugModeOf('pk_test_abc')).toBeUndefined();
    expect(payplugModeOf('')).toBeUndefined();
  });
});

describe('PayPlugClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refuse d’être construit sans clé exploitable', () => {
    // Échouer ici, au démarrage, plutôt qu'en 401 au premier acheteur.
    expect(() => new PayPlugClient('')).toThrow(/Clé PayPlug/);
    expect(() => new PayPlugClient('une-cle-quelconque')).toThrow(/Clé PayPlug/);
  });

  it('crée un paiement en Bearer, version d’API figée, corps JSON', async () => {
    const fetchSpy = respondWith(201);
    const client = new PayPlugClient('sk_test_123');

    const resultat = await client.createPayment(params);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('https://api.payplug.com/v1/payments');
    expect(init.method).toBe('POST');
    expect(headers.authorization).toBe('Bearer sk_test_123');
    expect(headers['payplug-version']).toBe('2019-08-06');
    expect(JSON.parse(init.body as string)).toEqual(params);
    expect(resultat.hosted_payment?.payment_url).toBe('https://secure.payplug.com/pay/x');
  });

  it('relit un paiement par GET sur son identifiant', async () => {
    const fetchSpy = respondWith(200, { ...paiement, is_paid: true });
    const client = new PayPlugClient('sk_test_123');

    const resultat = await client.retrievePayment(paiement.id);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.payplug.com/v1/payments/${paiement.id}`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(resultat.is_paid).toBe(true);
  });

  it('expose le code HTTP d’un refus PayPlug', async () => {
    respondWith(404, { object: 'error', message: 'Not found' });
    const client = new PayPlugClient('sk_test_123');

    await expect(client.retrievePayment('pay_inconnu')).rejects.toMatchObject({
      name: 'PayPlugError',
      status: 404,
    });
  });

  it('signale une panne réseau sans code HTTP', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const client = new PayPlugClient('sk_test_123');

    const erreur = await client.retrievePayment(paiement.id).catch((e: unknown) => e);

    expect(erreur).toBeInstanceOf(PayPlugError);
    expect((erreur as PayPlugError).status).toBeUndefined();
  });
});
