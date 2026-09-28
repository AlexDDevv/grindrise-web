import { DatabaseSync } from 'node:sqlite';

import Fastify from 'fastify';

import { CATALOG } from '../catalog/catalog';
import type { AppConfig } from '../config/env.config';
import { applySchema } from '../db/database';
import { OrdersRepository } from '../db/orders.repository';
import type { CreatePaymentParams, PayPlugPayment } from '../payment/payplug.client';
import { checkoutRoutes } from './checkout.routes';

const config = { publicBaseUrl: 'https://exemple.fr' } as AppConfig;

/** Typé sur les paramètres réels du client : sans annotation, TypeScript infère
 *  une fonction sans argument et `mock.calls[0][0]` n'existe pas, alors que
 *  c'est précisément ce que les tests du prix et du metadata inspectent. */
type CreatePaymentMock = jest.Mock<Promise<PayPlugPayment>, [CreatePaymentParams]>;

const paiement: PayPlugPayment = {
  id: 'pay_test_1',
  object: 'payment',
  is_live: false,
  is_paid: false,
  amount: CATALOG[0].priceCents,
  currency: 'EUR',
  failure: null,
  hosted_payment: { payment_url: 'https://secure.payplug.com/pay/x' },
  metadata: null,
};

function contexte(createPayment: CreatePaymentMock = jest.fn(async (_params) => paiement)) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const orders = new OrdersRepository(db);
  const app = Fastify();
  app.register(checkoutRoutes, { config, payplug: { createPayment }, orders });
  return { app, db, orders, createPayment };
}

const achat = { productId: CATALOG[0].id, email: 'acheteur@example.com', waiveWithdrawal: true };

describe('POST /api/checkout', () => {
  it('crée un paiement PayPlug et renvoie son URL de paiement', async () => {
    const { app, db } = contexte();

    const reponse = await app.inject({ method: 'POST', url: '/api/checkout', payload: achat });

    expect(reponse.statusCode).toBe(200);
    expect(reponse.json()).toEqual({ url: 'https://secure.payplug.com/pay/x' });
    await app.close();
    db.close();
  });

  it('transmet le prix du catalogue, jamais un prix reçu du client', async () => {
    // Faire confiance à un montant envoyé par le navigateur laisserait
    // n'importe qui acheter l'ebook à 1 centime.
    const { app, db, createPayment } = contexte();

    await app.inject({
      method: 'POST',
      url: '/api/checkout',
      payload: { ...achat, priceCents: 1 },
    });

    const args = createPayment.mock.calls[0][0];
    expect(args.amount).toBe(CATALOG[0].priceCents);
    expect(args.currency).toBe('EUR');
    await app.close();
    db.close();
  });

  it('enregistre la commande en attente et la relie au paiement par metadata', async () => {
    // La notification PayPlug ne porte que l'id du paiement : sans order_id en
    // metadata et sans la commande en base, impossible de savoir quoi livrer.
    const { app, db, orders, createPayment } = contexte();

    await app.inject({ method: 'POST', url: '/api/checkout', payload: achat });

    const args = createPayment.mock.calls[0][0];
    const commande = orders.findById(args.metadata.order_id);
    expect(commande).toMatchObject({
      status: 'pending',
      paymentId: 'pay_test_1',
      productId: CATALOG[0].id,
      email: 'acheteur@example.com',
      amountTotal: CATALOG[0].priceCents,
    });
    expect(args.billing.email).toBe('acheteur@example.com');
    expect(args.notification_url).toBe('https://exemple.fr/api/payplug/notification');
    expect(args.hosted_payment).toEqual({
      return_url: 'https://exemple.fr/ebooks/success',
      cancel_url: 'https://exemple.fr/ebooks/cancel',
    });
    await app.close();
    db.close();
  });

  it('refuse un produit inconnu en 404 sans appeler PayPlug', async () => {
    const { app, db, createPayment } = contexte();

    const reponse = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      payload: { ...achat, productId: 'nexiste-pas' },
    });

    expect(reponse.statusCode).toBe(404);
    expect(createPayment).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });

  it('refuse une requête sans productId en 400', async () => {
    const { app, db } = contexte();

    const reponse = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      payload: { email: achat.email },
    });

    expect(reponse.statusCode).toBe(400);
    await app.close();
    db.close();
  });

  it('refuse un email absent ou mal formé en 400 sans appeler PayPlug', async () => {
    // Sans adresse exploitable, le paiement serait encaissé sans aucun moyen
    // de livrer l'ebook.
    const { app, db, createPayment } = contexte();

    for (const email of [undefined, '', 'pas-un-email', 'a@b']) {
      const reponse = await app.inject({
        method: 'POST',
        url: '/api/checkout',
        payload: { productId: achat.productId, email },
      });
      expect(reponse.statusCode).toBe(400);
    }
    expect(createPayment).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });

  it('refuse une commande sans renoncement au droit de rétractation', async () => {
    // Sans cet accord exprès recueilli avant le paiement, l'exception au droit
    // de rétractation des contenus numériques ne s'applique pas : l'acheteur
    // pourrait exiger le remboursement d'un ebook déjà téléchargé.
    const { app, db, createPayment, orders } = contexte();

    for (const waiveWithdrawal of [undefined, false, 'oui', 1]) {
      const reponse = await app.inject({
        method: 'POST',
        url: '/api/checkout',
        payload: { productId: achat.productId, email: achat.email, waiveWithdrawal },
      });
      expect(reponse.statusCode).toBe(400);
    }

    expect(createPayment).not.toHaveBeenCalled();
    expect(orders.listEvents('ord_1')).toEqual([]);
    await app.close();
    db.close();
  });

  it('horodate le renoncement dans le journal, avant le paiement', async () => {
    const { app, db, orders, createPayment } = contexte();

    await app.inject({ method: 'POST', url: '/api/checkout', payload: achat });

    const orderId = createPayment.mock.calls[0][0].metadata.order_id;
    const types = orders.listEvents(orderId).map((e) => e.type);
    expect(types).toEqual(['order_created', 'withdrawal_waived', 'payment_created']);
    await app.close();
    db.close();
  });

  it('renvoie 502 si PayPlug échoue', async () => {
    // PayPlug injoignable n'est pas une erreur du client : le distinguer d'un
    // 400 évite de chercher le bug du mauvais côté.
    const silence = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, db } = contexte(
      jest.fn(async (_params) => {
        throw new Error('réseau');
      }),
    );

    const reponse = await app.inject({ method: 'POST', url: '/api/checkout', payload: achat });
    silence.mockRestore();

    expect(reponse.statusCode).toBe(502);
    await app.close();
    db.close();
  });
});
