import Fastify from 'fastify';
import type Stripe from 'stripe';

import { CATALOG } from '../catalog/catalog';
import type { AppConfig } from '../config/env.config';
import { checkoutRoutes } from './checkout.routes';

const config = { publicBaseUrl: 'https://exemple.fr' } as AppConfig;

/** Le mock est typé sur les paramètres réels de Stripe : sans annotation,
 *  TypeScript infère une fonction sans argument et `mock.calls[0][0]` n'existe
 *  pas, alors que c'est précisément ce que le test du prix doit inspecter. */
type CreateSessionMock = jest.Mock<
  Promise<{ id: string; url: string }>,
  [Stripe.Checkout.SessionCreateParams]
>;

function buildApp(create: jest.Mock) {
  const app = Fastify();
  const stripe = { checkout: { sessions: { create } } } as unknown as Stripe;
  app.register(checkoutRoutes, { config, stripe });
  return app;
}

const session = { id: 'cs_test_1', url: 'https://checkout.stripe.com/x' };

describe('POST /api/checkout', () => {
  it('crée une session Stripe et renvoie son URL', async () => {
    const create = jest.fn(async () => session);
    const app = buildApp(create);

    const reponse = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      payload: { productId: CATALOG[0].id },
    });

    expect(reponse.statusCode).toBe(200);
    expect(reponse.json()).toEqual({ url: session.url });
    await app.close();
  });

  it('transmet le prix du catalogue, jamais un prix reçu du client', async () => {
    // Faire confiance à un montant envoyé par le navigateur laisserait
    // n'importe qui acheter l'ebook à 1 centime.
    const create: CreateSessionMock = jest.fn(async (_params) => session);
    const app = buildApp(create);

    await app.inject({
      method: 'POST',
      url: '/api/checkout',
      payload: { productId: CATALOG[0].id, priceCents: 1 },
    });

    const args = create.mock.calls[0][0];
    expect(args.line_items?.[0].price_data?.unit_amount).toBe(CATALOG[0].priceCents);
    expect(args.mode).toBe('payment');
    expect(args.metadata?.productId).toBe(CATALOG[0].id);
    await app.close();
  });

  it('refuse un produit inconnu en 404 sans appeler Stripe', async () => {
    const create = jest.fn();
    const app = buildApp(create);

    const reponse = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      payload: { productId: 'nexiste-pas' },
    });

    expect(reponse.statusCode).toBe(404);
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuse une requête sans productId en 400', async () => {
    const app = buildApp(jest.fn());

    const reponse = await app.inject({ method: 'POST', url: '/api/checkout', payload: {} });

    expect(reponse.statusCode).toBe(400);
    await app.close();
  });

  it('renvoie 502 si Stripe échoue', async () => {
    // Stripe injoignable n'est pas une erreur du client : le distinguer d'un
    // 400 évite de chercher le bug du mauvais côté.
    const create = jest.fn(async () => {
      throw new Error('réseau');
    });
    const app = buildApp(create);

    const reponse = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      payload: { productId: CATALOG[0].id },
    });

    expect(reponse.statusCode).toBe(502);
    await app.close();
  });
});
