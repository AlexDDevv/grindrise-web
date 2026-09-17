import { DatabaseSync } from 'node:sqlite';

import type { AppConfig } from './config/env.config';
import { applySchema } from './db/database';
import { OrdersRepository } from './db/orders.repository';
import type { EmailProvider } from './email/email-provider';
import { buildServer, type ServerDeps } from './server';

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

  return { config, db, orders: new OrdersRepository(db), email, stripe: {} as never };
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

  it('sert les pages de retour de paiement', async () => {
    const app = await buildServer(deps());

    for (const chemin of ['/success', '/cancel']) {
      const reponse = await app.inject({ method: 'GET', url: chemin });
      expect(reponse.statusCode).toBe(200);
    }
    await app.close();
  });
});
