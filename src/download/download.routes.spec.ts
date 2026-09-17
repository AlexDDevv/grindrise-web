import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import Fastify from 'fastify';

import { CATALOG } from '../catalog/catalog';
import type { AppConfig } from '../config/env.config';
import { applySchema } from '../db/database';
import { OrdersRepository } from '../db/orders.repository';
import { signDownloadToken } from '../tokens/download-token';
import { DOWNLOAD_MAX_PARAM_LENGTH, downloadRoutes } from './download.routes';

const SECRET = 'secret-de-test';

function contexte(maxUses = 5) {
  const dataDir = mkdtempSync(join(tmpdir(), 'grindrise-'));
  mkdirSync(join(dataDir, 'ebooks'), { recursive: true });
  writeFileSync(join(dataDir, 'ebooks', CATALOG[0].fileName), '%PDF-1.4 contenu de test');

  const config = {
    dataDir,
    downloadTokenSecret: SECRET,
    downloadTokenTtlDays: 7,
    downloadMaxUses: maxUses,
  } as AppConfig;

  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const orders = new OrdersRepository(db);
  orders.insertPaidOrder({
    checkoutSessionId: 'cs_test_1',
    productId: CATALOG[0].id,
    email: 'acheteur@example.com',
    amountTotal: CATALOG[0].priceCents,
    currency: CATALOG[0].currency,
  });

  const app = Fastify({ routerOptions: { maxParamLength: DOWNLOAD_MAX_PARAM_LENGTH } });
  app.register(downloadRoutes, { config, orders });

  return { app, db, orders, config, dataDir };
}

describe('GET /api/download/:token', () => {
  it('sert le PDF pour un token valide', async () => {
    const { app, db, dataDir } = contexte();
    const token = signDownloadToken('cs_test_1', SECRET, 7);

    const reponse = await app.inject({ method: 'GET', url: `/api/download/${token}` });

    expect(reponse.statusCode).toBe(200);
    expect(reponse.headers['content-type']).toContain('application/pdf');
    expect(reponse.rawPayload.toString()).toContain('%PDF');
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuse un token signé avec un autre secret', async () => {
    const { app, db, dataDir } = contexte();
    const token = signDownloadToken('cs_test_1', 'mauvais-secret', 7);

    const reponse = await app.inject({ method: 'GET', url: `/api/download/${token}` });

    expect(reponse.statusCode).toBe(403);
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuse un token expiré', async () => {
    const { app, db, dataDir } = contexte();
    const token = signDownloadToken('cs_test_1', SECRET, 7, new Date('2020-01-01T00:00:00Z'));

    const reponse = await app.inject({ method: 'GET', url: `/api/download/${token}` });

    expect(reponse.statusCode).toBe(403);
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuse au-delà du quota de téléchargements', async () => {
    // C'est ce qui empêche un lien partagé de servir indéfiniment.
    const { app, db, dataDir } = contexte(2);
    const token = signDownloadToken('cs_test_1', SECRET, 7);
    const url = `/api/download/${token}`;

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(410);
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuse un token valide pointant vers une commande inconnue', async () => {
    const silence = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, db, dataDir } = contexte();
    const token = signDownloadToken('cs_inexistante', SECRET, 7);

    const reponse = await app.inject({ method: 'GET', url: `/api/download/${token}` });

    expect(reponse.statusCode).toBe(403);
    silence.mockRestore();
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('ne consomme pas le quota quand le fichier est introuvable', async () => {
    // Un PDF absent du volume est notre panne, pas celle de l'acheteur :
    // décrémenter ses téléchargements restants serait une double peine.
    const silence = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, db, orders, config, dataDir } = contexte();
    rmSync(join(config.dataDir, 'ebooks', CATALOG[0].fileName));
    const token = signDownloadToken('cs_test_1', SECRET, 7);

    const reponse = await app.inject({ method: 'GET', url: `/api/download/${token}` });

    expect(reponse.statusCode).toBe(500);
    expect(orders.findById('cs_test_1')?.downloadCount).toBe(0);
    silence.mockRestore();
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
