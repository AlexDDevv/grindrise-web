import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import Fastify from 'fastify';

import { findProduct } from '../catalog/catalog';
import type { AppConfig } from '../config/env.config';
import { applySchema } from '../db/database';
import { OrdersRepository } from '../db/orders.repository';
import { signDownloadToken } from '../tokens/download-token';
import { DOWNLOAD_MAX_PARAM_LENGTH, downloadRoutes } from './download.routes';

const SECRET = 'secret-de-test';

/** Le pack : deux fichiers, donc le cas qui distingue les quotas par fichier. */
const PACK = findProduct('pack-complet')!;

function contexte(maxUses = 5) {
  const dataDir = mkdtempSync(join(tmpdir(), 'grindrise-'));
  mkdirSync(join(dataDir, 'ebooks'), { recursive: true });
  // Contenus distincts : c'est ce qui prouve que chaque lien sert SON fichier.
  PACK.files.forEach((ebook, i) => {
    writeFileSync(join(dataDir, 'ebooks', ebook.fileName), `%PDF-1.4 fichier ${i}`);
  });

  const config = {
    dataDir,
    downloadTokenSecret: SECRET,
    downloadTokenTtlDays: 7,
    downloadMaxUses: maxUses,
  } as AppConfig;

  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const orders = new OrdersRepository(db);
  orders.createPending({
    id: 'ord_1',
    productId: PACK.id,
    email: 'acheteur@example.com',
    amountTotal: PACK.priceCents,
    currency: PACK.currency,
  });
  orders.attachPayment('ord_1', 'pay_1');
  orders.markPaid('ord_1', 'pay_1');

  const app = Fastify({ routerOptions: { maxParamLength: DOWNLOAD_MAX_PARAM_LENGTH } });
  app.register(downloadRoutes, { config, orders });

  const lien = (fileIndex: number, secret = SECRET, emis?: Date) =>
    `/api/download/${signDownloadToken({ orderId: 'ord_1', fileIndex }, secret, 7, emis)}`;

  return { app, db, orders, config, dataDir, lien };
}

function nettoie(ctx: { app: { close: () => Promise<unknown> }; db: DatabaseSync; dataDir: string }) {
  return ctx.app.close().then(() => {
    ctx.db.close();
    rmSync(ctx.dataDir, { recursive: true, force: true });
  });
}

describe('GET /api/download/:token', () => {
  it('sert le fichier que le token désigne, et lui seul', async () => {
    const ctx = contexte();

    for (const [fileIndex, ebook] of PACK.files.entries()) {
      const reponse = await ctx.app.inject({ method: 'GET', url: ctx.lien(fileIndex) });

      expect(reponse.statusCode).toBe(200);
      expect(reponse.headers['content-type']).toContain('application/pdf');
      expect(reponse.headers['content-disposition']).toContain(ebook.fileName);
      expect(reponse.rawPayload.toString()).toBe(`%PDF-1.4 fichier ${fileIndex}`);
    }

    await nettoie(ctx);
  });

  it('compte le quota par fichier, pas par commande', async () => {
    // Sans ça, l'acheteur du pack épuiserait sur un seul ebook les
    // téléchargements dus aux deux.
    const ctx = contexte(2);

    expect((await ctx.app.inject({ method: 'GET', url: ctx.lien(0) })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: ctx.lien(0) })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: ctx.lien(0) })).statusCode).toBe(410);

    // Le second ebook garde son quota intact.
    expect((await ctx.app.inject({ method: 'GET', url: ctx.lien(1) })).statusCode).toBe(200);
    expect(ctx.orders.downloadCount('ord_1', 0)).toBe(2);
    expect(ctx.orders.downloadCount('ord_1', 1)).toBe(1);

    await nettoie(ctx);
  });

  it('refuse un token signé avec un autre secret', async () => {
    const ctx = contexte();

    const reponse = await ctx.app.inject({
      method: 'GET',
      url: ctx.lien(0, 'mauvais-secret'),
    });

    expect(reponse.statusCode).toBe(403);
    await nettoie(ctx);
  });

  it('refuse un token expiré', async () => {
    const ctx = contexte();

    const reponse = await ctx.app.inject({
      method: 'GET',
      url: ctx.lien(0, SECRET, new Date('2020-01-01T00:00:00Z')),
    });

    expect(reponse.statusCode).toBe(403);
    await nettoie(ctx);
  });

  it('refuse un indice de fichier que le produit ne contient pas', async () => {
    // Token forgé, ou ordre des fichiers modifié dans le catalogue après
    // l'envoi du lien : dans les deux cas, ne rien servir.
    const silence = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = contexte();

    const reponse = await ctx.app.inject({ method: 'GET', url: ctx.lien(9) });

    expect(reponse.statusCode).toBe(403);
    expect(ctx.orders.downloadCount('ord_1', 9)).toBe(0);
    silence.mockRestore();
    await nettoie(ctx);
  });

  it('refuse un token valide pointant vers une commande inconnue', async () => {
    const silence = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = contexte();
    const token = signDownloadToken({ orderId: 'ord_inexistante', fileIndex: 0 }, SECRET, 7);

    const reponse = await ctx.app.inject({ method: 'GET', url: `/api/download/${token}` });

    expect(reponse.statusCode).toBe(403);
    silence.mockRestore();
    await nettoie(ctx);
  });

  it('ne consomme pas le quota quand le fichier est introuvable', async () => {
    // Un PDF absent du volume est notre panne, pas celle de l'acheteur :
    // décrémenter ses téléchargements restants serait une double peine.
    const silence = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = contexte();
    rmSync(join(ctx.config.dataDir, 'ebooks', PACK.files[0].fileName));

    const reponse = await ctx.app.inject({ method: 'GET', url: ctx.lien(0) });

    expect(reponse.statusCode).toBe(500);
    expect(ctx.orders.downloadCount('ord_1', 0)).toBe(0);
    silence.mockRestore();
    await nettoie(ctx);
  });
});
