import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  payplugSecretKey: 'sk_test_123',
  payplugMode: 'test',
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
    payplug: {} as never,
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

  it("sert la page d'accueil provisoire, distincte du tunnel de vente", async () => {
    const app = await buildServer(deps());

    const reponse = await app.inject({ method: 'GET', url: '/' });

    expect(reponse.statusCode).toBe(200);
    expect(reponse.headers['content-type']).toContain('text/html');
    expect(reponse.body).not.toContain('Acheter');
    await app.close();
  });

  it('sert la page d’achat sur /ebooks, sans slash final', async () => {
    // @fastify/static ne répond sur un répertoire qu'avec le slash final : sans
    // route explicite, le lien /ebooks donné aux acheteurs serait en 404.
    const app = await buildServer(deps());

    const reponse = await app.inject({ method: 'GET', url: '/ebooks' });

    expect(reponse.statusCode).toBe(200);
    expect(reponse.body).toContain('Acheter');
    await app.close();
  });

  it('accepte un token de téléchargement de longueur réaliste', async () => {
    // Fastify plafonne les paramètres d'URL à 100 caractères et répond 414
    // au-delà. Un token signé sur un vrai identifiant de commande dépasse ce
    // plafond : sans maxParamLength relevé, aucun lien de livraison ne
    // fonctionne en production. Les tests de download/ montent leur propre
    // instance Fastify, ce test verrouille la configuration réelle.
    const app = await buildServer(deps());
    const commande = `ord_${randomUUID()}`;
    const token = signDownloadToken(
      { orderId: commande, fileIndex: 0 },
      config.downloadTokenSecret,
      7,
    );

    const reponse = await app.inject({ method: 'GET', url: `/api/download/${token}` });

    expect(token.length).toBeGreaterThan(100);
    expect(reponse.statusCode).not.toBe(414);
    await app.close();
  });

  it('sert les pages légales', async () => {
    // Elles doivent être atteignables avant l'achat : c'est ce qui rend les
    // conditions opposables, et les mentions légales sont obligatoires.
    const app = await buildServer(deps());

    for (const chemin of [
      '/legal/mentions-legales',
      '/legal/cgv',
      '/legal/confidentialite',
    ]) {
      const reponse = await app.inject({ method: 'GET', url: chemin });
      expect(reponse.statusCode).toBe(200);
      expect(reponse.headers['content-type']).toContain('text/html');
    }
    await app.close();
  });

  it("ne laisse dans les pages légales que le marqueur du médiateur", () => {
    // Les mentions légales et les CGV sont opposables : un « [À COMPLÉTER » en
    // ligne est au mieux ridicule, au pire une information obligatoire absente.
    // Le médiateur reste le seul toléré tant que l'adhésion n'est pas prise —
    // ce test devra alors ne plus rien tolérer du tout.
    const racine = join(__dirname, '..', 'public', 'legal');
    const restants = readdirSync(racine).flatMap((fichier) =>
      readFileSync(join(racine, fichier), 'utf8')
        .split('\n')
        .filter((ligne) => ligne.includes('À COMPLÉTER') || ligne.includes('[numéro]'))
        .map((ligne) => `${fichier} : ${ligne.trim()}`),
    );

    expect(restants.filter((l) => !/médiateur|numéro/.test(l))).toEqual([]);
  });

  it('sert les pages de retour de paiement', async () => {
    // Ce sont les URL transmises à PayPlug : une 404 ici renverrait l'acheteur
    // sur une page morte juste après avoir payé.
    const app = await buildServer(deps());

    for (const chemin of ['/ebooks/success', '/ebooks/cancel']) {
      const reponse = await app.inject({ method: 'GET', url: chemin });
      expect(reponse.statusCode).toBe(200);
    }
    await app.close();
  });
});
