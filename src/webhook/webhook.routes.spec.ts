import { DatabaseSync } from 'node:sqlite';

import Fastify from 'fastify';
import type Stripe from 'stripe';

import { CATALOG } from '../catalog/catalog';
import type { AppConfig } from '../config/env.config';
import { applySchema } from '../db/database';
import { OrdersRepository } from '../db/orders.repository';
import { DeliveryService } from '../delivery/delivery.service';
import type { EmailProvider } from '../email/email-provider';
import { webhookRoutes } from './webhook.routes';

const config = {
  publicBaseUrl: 'https://exemple.fr',
  stripeWebhookSecret: 'whsec_123',
  downloadTokenSecret: 'secret-de-test',
  downloadTokenTtlDays: 7,
} as AppConfig;

function evenement(sessionOverrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        payment_status: 'paid',
        amount_total: CATALOG[0].priceCents,
        currency: CATALOG[0].currency,
        customer_details: { email: 'acheteur@example.com' },
        metadata: { productId: CATALOG[0].id },
        ...sessionOverrides,
      },
    },
  };
}

function contexte(construit: () => unknown, envoi?: EmailProvider['send']) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const orders = new OrdersRepository(db);
  const send = jest.fn(envoi ?? (async () => undefined));
  const email: EmailProvider = { name: 'fake', send };
  const delivery = new DeliveryService({ orders, email, config });
  const stripe = { webhooks: { constructEvent: jest.fn(construit) } } as unknown as Stripe;

  const app = Fastify();
  app.register(webhookRoutes, { config, stripe, orders, delivery });

  return { app, db, orders, send };
}

const requete = {
  method: 'POST' as const,
  url: '/api/stripe/webhook',
  headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_test' },
  payload: JSON.stringify(evenement()),
};

describe('POST /api/stripe/webhook', () => {
  it('livre une session payée et répond 200', async () => {
    const { app, db, send, orders } = contexte(() => evenement());

    const reponse = await app.inject(requete);

    expect(reponse.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(orders.findById('cs_test_1')?.status).toBe('delivered');
    await app.close();
    db.close();
  });

  it('ne livre pas deux fois le même événement rejoué', async () => {
    // C'est le scénario que Stripe produit spontanément quand notre 200 se
    // perd : sans ce verrou, l'acheteur reçoit deux emails.
    const { app, db, send } = contexte(() => evenement());

    await app.inject(requete);
    await app.inject(requete);

    expect(send).toHaveBeenCalledTimes(1);
    await app.close();
    db.close();
  });

  it('ne livre pas deux fois pour deux événements portant la même session', async () => {
    // Le verrou par event_id ne couvre pas ce cas : seule la clé primaire sur
    // checkout_session_id l'attrape.
    let compteur = 0;
    const { app, db, send } = contexte(() => ({ ...evenement(), id: `evt_${++compteur}` }));

    await app.inject(requete);
    await app.inject(requete);

    expect(send).toHaveBeenCalledTimes(1);
    await app.close();
    db.close();
  });

  it('ignore une session non payée sans rien livrer', async () => {
    // checkout.session.completed arrive aussi en `unpaid` sur les moyens de
    // paiement différés : livrer là serait offrir l'ebook.
    const { app, db, send, orders } = contexte(() => evenement({ payment_status: 'unpaid' }));

    const reponse = await app.inject(requete);

    expect(reponse.statusCode).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect(orders.findById('cs_test_1')).toBeUndefined();
    await app.close();
    db.close();
  });

  it('refuse une signature invalide en 400 sans rien enregistrer', async () => {
    const { app, db, send, orders } = contexte(() => {
      throw new Error('signature invalide');
    });

    const reponse = await app.inject(requete);

    expect(reponse.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect(orders.findById('cs_test_1')).toBeUndefined();
    await app.close();
    db.close();
  });

  it("répond 200 même si l'envoi d'email échoue", async () => {
    // Un 500 ferait retenter Stripe alors que le paiement, lui, est bien
    // enregistré — et chaque retry retenterait un envoi déjà en échec.
    // L'échec journalise en error : le museler garde la sortie de test lisible.
    const silence = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, db, orders } = contexte(
      () => evenement(),
      async () => {
        throw new Error('Brevo HS');
      },
    );

    const reponse = await app.inject(requete);
    silence.mockRestore();

    expect(reponse.statusCode).toBe(200);
    expect(orders.findById('cs_test_1')?.status).toBe('delivery_failed');
    await app.close();
    db.close();
  });

  it("ignore un type d'événement non géré", async () => {
    const { app, db, send } = contexte(() => ({
      ...evenement(),
      type: 'payment_intent.created',
    }));

    const reponse = await app.inject(requete);

    expect(reponse.statusCode).toBe(200);
    expect(send).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });
});
