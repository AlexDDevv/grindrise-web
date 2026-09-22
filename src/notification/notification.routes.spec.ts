import { DatabaseSync } from 'node:sqlite';

import Fastify from 'fastify';

import { CATALOG } from '../catalog/catalog';
import type { AppConfig } from '../config/env.config';
import { applySchema } from '../db/database';
import { OrdersRepository } from '../db/orders.repository';
import { DeliveryService } from '../delivery/delivery.service';
import type { EmailProvider } from '../email/email-provider';
import { PayPlugError, type PayPlugPayment } from '../payment/payplug.client';
import { notificationRoutes } from './notification.routes';

const config = {
  publicBaseUrl: 'https://exemple.fr',
  payplugMode: 'test',
  downloadTokenSecret: 'secret-de-test',
  downloadTokenTtlDays: 7,
} as AppConfig;

const PAYMENT_ID = 'pay_5iHMDxy4ABR4YBVW4UscIn';

function paiement(overrides: Partial<PayPlugPayment> = {}): PayPlugPayment {
  return {
    id: PAYMENT_ID,
    object: 'payment',
    is_live: false,
    is_paid: true,
    amount: CATALOG[0].priceCents,
    currency: 'EUR',
    failure: null,
    hosted_payment: { payment_url: 'https://secure.payplug.com/pay/x' },
    metadata: { order_id: 'ord_1' },
    ...overrides,
  };
}

function contexte(
  relecture: () => Promise<PayPlugPayment> = async () => paiement(),
  envoi?: EmailProvider['send'],
) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const orders = new OrdersRepository(db);
  orders.createPending({
    id: 'ord_1',
    productId: CATALOG[0].id,
    email: 'acheteur@example.com',
    amountTotal: CATALOG[0].priceCents,
    currency: 'EUR',
  });
  orders.attachPayment('ord_1', PAYMENT_ID);

  const send = jest.fn(envoi ?? (async () => undefined));
  const email: EmailProvider = { name: 'fake', send };
  const delivery = new DeliveryService({ orders, email, config });
  const retrievePayment = jest.fn(relecture);

  const app = Fastify();
  app.register(notificationRoutes, { config, payplug: { retrievePayment }, orders, delivery });

  return { app, db, orders, send, retrievePayment };
}

function notification(corps: Record<string, unknown> = {}) {
  return {
    method: 'POST' as const,
    url: '/api/payplug/notification',
    payload: { id: PAYMENT_ID, object: 'payment', is_live: false, ...corps },
  };
}

describe('POST /api/payplug/notification', () => {
  // Les refus journalisent en warn/error : les museler garde la sortie lisible.
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('relit le paiement chez PayPlug, livre, et répond 200', async () => {
    const { app, db, send, orders, retrievePayment } = contexte();

    const reponse = await app.inject(notification());

    expect(reponse.statusCode).toBe(200);
    expect(retrievePayment).toHaveBeenCalledWith(PAYMENT_ID);
    expect(send).toHaveBeenCalledTimes(1);
    expect(orders.findById('ord_1')?.status).toBe('delivered');
    await app.close();
    db.close();
  });

  it('ne livre pas deux fois la même notification rejouée', async () => {
    // Le scénario que PayPlug produit quand notre réponse se perd : sans
    // verrou, l'acheteur reçoit deux emails.
    const { app, db, send } = contexte();

    await app.inject(notification());
    const rejeu = await app.inject(notification());

    expect(rejeu.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    await app.close();
    db.close();
  });

  it('ne livre qu’une fois pour des notifications simultanées', async () => {
    const { app, db, send } = contexte();

    await Promise.all([app.inject(notification()), app.inject(notification())]);

    expect(send).toHaveBeenCalledTimes(1);
    await app.close();
    db.close();
  });

  it('ne croit jamais le corps : un paiement non payé chez PayPlug ne livre rien', async () => {
    // Notification forgée ou paiement refusé : le corps peut dire ce qu'il
    // veut, seule la relecture fait foi.
    const { app, db, send, orders } = contexte(async () =>
      paiement({ is_paid: false, failure: { code: 'card_declined', message: 'Refusée' } }),
    );

    const reponse = await app.inject(notification({ is_paid: true }));

    expect(reponse.statusCode).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect(orders.findById('ord_1')?.status).toBe('pending');
    await app.close();
    db.close();
  });

  it('refuse un paiement inconnu de PayPlug en 400 sans rien livrer', async () => {
    const { app, db, send } = contexte(async () => {
      throw new PayPlugError('PayPlug a répondu 404.', 404);
    });

    const reponse = await app.inject(notification());

    expect(reponse.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });

  it('répond en erreur si PayPlug est injoignable, pour être renotifié', async () => {
    const { app, db, send, orders } = contexte(async () => {
      throw new PayPlugError('PayPlug injoignable : timeout');
    });

    const reponse = await app.inject(notification());

    expect(reponse.statusCode).toBe(502);
    expect(send).not.toHaveBeenCalled();
    expect(orders.findById('ord_1')?.status).toBe('pending');
    await app.close();
    db.close();
  });

  it('refuse un identifiant mal formé sans appeler PayPlug', async () => {
    // L'identifiant finit dans l'URL de l'API : pas de chemin arbitraire.
    const { app, db, retrievePayment } = contexte();

    const reponse = await app.inject(notification({ id: '../v1/refunds' }));

    expect(reponse.statusCode).toBe(400);
    expect(retrievePayment).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });

  it('ignore les notifications de remboursement', async () => {
    const { app, db, retrievePayment } = contexte();

    const reponse = await app.inject(notification({ object: 'refund', id: 're_1' }));

    expect(reponse.statusCode).toBe(200);
    expect(retrievePayment).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });

  it('ne livre pas si le montant payé diffère de la commande', async () => {
    const { app, db, send } = contexte(async () => paiement({ amount: 1 }));

    await app.inject(notification());

    expect(send).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });

  it('ne livre pas une commande à laquelle ce paiement n’est pas rattaché', async () => {
    // Un paiement dont le metadata désigne la commande d'un autre acheteur.
    const autre = 'pay_autrePaiement1';
    const { app, db, send } = contexte(async () => paiement({ id: autre }));

    await app.inject(notification({ id: autre }));

    expect(send).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });

  it('ne livre rien pour un paiement sans commande correspondante', async () => {
    const { app, db, send } = contexte(async () => paiement({ metadata: {} }));

    const reponse = await app.inject(notification());

    expect(reponse.statusCode).toBe(200);
    expect(send).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });

  describe('traçabilité', () => {
    const types = (orders: OrdersRepository) => orders.listEvents('ord_1').map((e) => e.type);

    it('trace le parcours complet d’un paiement réussi puis rejoué', async () => {
      const { app, db, orders } = contexte();

      await app.inject(notification());
      await app.inject(notification());

      expect(types(orders)).toEqual([
        'order_created',
        'payment_created',
        'notification_received',
        'payment_confirmed',
        'email_sent',
        'notification_received',
        'payment_already_processed',
      ]);
      await app.close();
      db.close();
    });

    it('trace une notification forgée : ce qui était affirmé et ce qui a été vérifié', async () => {
      const { app, db, orders } = contexte(async () =>
        paiement({ is_paid: false, failure: { code: 'card_declined', message: 'Refusée' } }),
      );

      await app.inject(notification({ is_paid: true }));

      const [recue, verifiee] = orders.listEvents('ord_1').slice(-2);
      expect(recue).toMatchObject({ type: 'notification_received', paymentId: PAYMENT_ID });
      expect(verifiee).toMatchObject({
        type: 'payment_not_paid',
        detail: { failure: { code: 'card_declined' } },
      });
      await app.close();
      db.close();
    });

    it('trace un écart de montant', async () => {
      const { app, db, orders } = contexte(async () => paiement({ amount: 1 }));

      await app.inject(notification());

      expect(orders.listEvents('ord_1').at(-1)).toMatchObject({
        type: 'payment_mismatch',
        detail: { reason: 'amount_mismatch' },
      });
      await app.close();
      db.close();
    });

    it('trace l’échec de vérification auprès de PayPlug', async () => {
      const { app, db, orders } = contexte(async () => {
        throw new PayPlugError('PayPlug a répondu 503.', 503);
      });

      await app.inject(notification());

      expect(orders.listEvents('ord_1').at(-1)).toMatchObject({
        type: 'verification_failed',
        detail: { status: 503 },
      });
      await app.close();
      db.close();
    });
  });

  it("répond 200 même si l'envoi d'email échoue", async () => {
    // Une erreur ferait renvoyer la notification alors que le paiement, lui,
    // est bien enregistré — et chaque renvoi retenterait un envoi en échec.
    const { app, db, orders } = contexte(undefined, async () => {
      throw new Error('Brevo HS');
    });

    const reponse = await app.inject(notification());

    expect(reponse.statusCode).toBe(200);
    expect(orders.findById('ord_1')?.status).toBe('delivery_failed');
    await app.close();
    db.close();
  });
});
