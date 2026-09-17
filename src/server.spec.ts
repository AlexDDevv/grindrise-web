import { DatabaseSync } from 'node:sqlite';

import type { AppConfig } from './config/env.config';
import { applySchema } from './db/database';
import { OrdersRepository } from './db/orders.repository';
import { DeliveryService } from './delivery/delivery.service';
import type { EmailProvider } from './email/email-provider';
import { buildServer, type ServerDeps } from './server';
import { signDownloadToken } from './tokens/download-token';

const config: AppConfig = {
  port: 0,
  publicBaseUrl: 'http://localhost:3000',
  dataDir: './data',
  stripeSecretKey: 'sk_test_123',
  stripeWebhookSecret: 'whsec_123',
  brevoApiKey: 'xkeysib-123',
  brevoSenderEmail: 'contact@example.com',
  brevoSenderName: 'Grindrise',
  downloadTokenSecret: 'secret-de-test',
  downloadTokenTtlDays: 7,
  downloadMaxUses: 5,
};

function deps(): ServerDeps {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const email: EmailProvider = { name: 'fake', send: jest.fn(async () => undefined) };
  const orders = new OrdersRepository(db);

  return {
    config,
    db,
    orders,
    email,
    stripe: {} as never,
    delivery: new DeliveryService({ orders, email, config }),
  };
}

describe('buildServer', () => {
  it('répond 200 sur /health quand la base est ouvrable', async () => {
    const app = await buildServer(deps());

    const reponse = await app.inject({ method: 'GET', url: '/health' });

    expect(reponse.statusCode).toBe(200);
    expect(reponse.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it("répond 503 sur /health quand la base ne répond plus", async () => {
    // Un volume démonté laisserait le serveur debout mais incapable
    // d'enregistrer une commande — donc de livrer. CapRover doit le voir.
    const d = deps();
    d.db.close();

    const app = await buildServer(d);
    const reponse = await app.inject({ method: 'GET', url: '/health' });

    expect(reponse.statusCode).toBe(503);
    await app.close();
  });

  it("sert la page d'accueil", async () => {
    const app = await buildServer(deps());

    const reponse = await app.inject({ method: 'GET', url: '/' });

    expect(reponse.statusCode).toBe(200);
    expect(reponse.headers['content-type']).toContain('text/html');
    await app.close();
  });

  it('accepte un token de téléchargement de longueur réaliste', async () => {
    // Fastify plafonne les paramètres d'URL à 100 caractères et répond 414
    // au-delà. Un token signé sur un vrai identifiant de session Stripe en fait
    // près du double : sans maxParamLength relevé, aucun lien de livraison ne
    // fonctionne en production. Les tests de download/ montent leur propre
    // instance Fastify, ce test verrouille la configuration réelle.
    const app = await buildServer(deps());
    const sessionStripe = `cs_test_${'a1b2c3d4e5'.repeat(6)}`;
    const token = signDownloadToken(sessionStripe, config.downloadTokenSecret, 7);

    const reponse = await app.inject({ method: 'GET', url: `/api/download/${token}` });

    expect(token.length).toBeGreaterThan(100);
    expect(reponse.statusCode).not.toBe(414);
    await app.close();
  });

  it('sert les pages de retour de paiement', async () => {
    const app = await buildServer(deps());

    for (const chemin of ['/success', '/cancel']) {
      const reponse = await app.inject({ method: 'GET', url: chemin });
      expect(reponse.statusCode).toBe(200);
    }
    await app.close();
  });
});
