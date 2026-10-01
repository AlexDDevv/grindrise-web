import { DatabaseSync } from 'node:sqlite';

import Fastify from 'fastify';

import { CATALOG } from '../catalog/catalog';
import type { AppConfig } from '../config/env.config';
import { applySchema } from '../db/database';
import { OrdersRepository } from '../db/orders.repository';
import { brevoWebhookRoutes } from './brevo.webhook.routes';

const SECRET = 'jeton-de-test';
const config = { brevoWebhookSecret: SECRET } as AppConfig;

function contexte() {
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
  orders.attachPayment('ord_1', 'pay_1');
  orders.markPaid('ord_1', 'pay_1');
  orders.markDelivered('ord_1', { provider: 'brevo' });

  const app = Fastify();
  app.register(brevoWebhookRoutes, { config, orders });

  return { app, db, orders };
}

function evenement(corps: Record<string, unknown>, jeton = SECRET) {
  return {
    method: 'POST' as const,
    url: '/api/brevo/webhook',
    headers: { authorization: `Bearer ${jeton}` },
    payload: { tags: ['ord_1'], 'message-id': '<abc@smtp-relay.mailin.fr>', ...corps },
  };
}

describe('POST /api/brevo/webhook', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('inscrit la remise réelle au journal, sans toucher au statut', async () => {
    const { app, db, orders } = contexte();

    const reponse = await app.inject(evenement({ event: 'delivered' }));

    expect(reponse.statusCode).toBe(200);
    expect(orders.listEvents('ord_1').at(-1)).toMatchObject({
      type: 'email_delivered',
      detail: { event: 'delivered', messageId: '<abc@smtp-relay.mailin.fr>' },
    });
    expect(orders.findById('ord_1')?.status).toBe('delivered');
    await app.close();
    db.close();
  });

  it('repasse la commande à rattraper sur un échec définitif', async () => {
    // Le paiement est encaissé et l'acheteur n'a rien reçu : laisser la
    // commande en « livrée » la ferait disparaître des rattrapages.
    for (const event of ['hard_bounce', 'blocked', 'invalid_email', 'spam', 'error']) {
      const { app, db, orders } = contexte();

      await app.inject(evenement({ event, reason: 'boîte inexistante' }));

      expect(orders.findById('ord_1')?.status).toBe('delivery_failed');
      const journal = orders.listEvents('ord_1').map((e) => e.type);
      expect(journal).toContain('email_failed');
      await app.close();
      db.close();
    }
  });

  it('trace un échec passager sans changer le statut', async () => {
    // Brevo réessaie : la commande n'est pas encore perdue.
    for (const event of ['soft_bounce', 'deferred']) {
      const { app, db, orders } = contexte();

      await app.inject(evenement({ event, reason: 'boîte pleine' }));

      expect(orders.findById('ord_1')?.status).toBe('delivered');
      expect(orders.listEvents('ord_1').at(-1)).toMatchObject({
        type: 'email_failed',
        detail: { event },
      });
      await app.close();
      db.close();
    }
  });

  it('ignore les ouvertures et les clics, et ne les trace jamais', async () => {
    // Savoir qui ouvre son email n'aide pas à livrer un ebook, et la politique
    // de confidentialité annonce l'absence de traceur.
    const { app, db, orders } = contexte();
    const avant = orders.listEvents('ord_1').length;

    for (const event of ['opened', 'unique_opened', 'click', 'proxy_open', 'request']) {
      const reponse = await app.inject(evenement({ event }));
      expect(reponse.statusCode).toBe(200);
    }

    expect(orders.listEvents('ord_1')).toHaveLength(avant);
    await app.close();
    db.close();
  });

  it('refuse un jeton absent, faux ou mal formé', async () => {
    // Brevo ne signe pas ses appels : ce jeton est la seule preuve d'origine.
    const { app, db, orders } = contexte();
    const avant = orders.listEvents('ord_1').length;

    const sansEntete = await app.inject({
      method: 'POST',
      url: '/api/brevo/webhook',
      payload: { event: 'hard_bounce', tags: ['ord_1'] },
    });
    expect(sansEntete.statusCode).toBe(401);

    for (const jeton of ['', 'mauvais-jeton', `${SECRET} `, SECRET.slice(0, -1)]) {
      const reponse = await app.inject(evenement({ event: 'hard_bounce' }, jeton));
      expect(reponse.statusCode).toBe(401);
    }

    expect(orders.findById('ord_1')?.status).toBe('delivered');
    expect(orders.listEvents('ord_1')).toHaveLength(avant);
    await app.close();
    db.close();
  });

  it('ignore un événement dont l’étiquette ne mène à aucune commande', async () => {
    const { app, db, orders } = contexte();
    const avant = orders.listEvents('ord_1').length;

    for (const corps of [{ tags: [] }, { tags: ['ord_inexistante'] }, { tags: ['marketing'] }]) {
      const reponse = await app.inject(evenement({ event: 'hard_bounce', ...corps }));
      expect(reponse.statusCode).toBe(200);
    }

    expect(orders.listEvents('ord_1')).toHaveLength(avant);
    await app.close();
    db.close();
  });

  it('accepte l’étiquette au singulier, telle que Brevo l’envoie parfois', async () => {
    const { app, db, orders } = contexte();

    await app.inject(
      evenement({ event: 'delivered', tags: undefined, tag: 'ord_1' }),
    );

    expect(orders.listEvents('ord_1').at(-1)?.type).toBe('email_delivered');
    await app.close();
    db.close();
  });

  it('n’écrit jamais l’adresse de l’acheteur dans le journal', async () => {
    // Invariant du projet : l'email n'existe qu'une fois, dans orders.
    const { app, db, orders } = contexte();

    await app.inject(
      evenement({ event: 'hard_bounce', email: 'acheteur@example.com', subject: 'Votre ebook' }),
    );

    expect(JSON.stringify(orders.listEvents('ord_1'))).not.toContain('acheteur@example.com');
    await app.close();
    db.close();
  });

  it('refuse un corps sans événement', async () => {
    const { app, db } = contexte();

    const reponse = await app.inject(evenement({}));

    expect(reponse.statusCode).toBe(400);
    await app.close();
    db.close();
  });
});
