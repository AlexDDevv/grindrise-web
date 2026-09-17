import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type Stripe from 'stripe';

import type { AppConfig } from './config/env.config';
import type { OrdersRepository } from './db/orders.repository';
import type { EmailProvider } from './email/email-provider';

export type ServerDeps = {
  config: AppConfig;
  db: DatabaseSync;
  orders: OrdersRepository;
  email: EmailProvider;
  stripe: Stripe;
};

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  // Le logger Fastify est désactivé : toute l'observabilité passe par
  // src/logger.ts, pour qu'un incident de livraison se lise dans un seul flux
  // au format unique plutôt que dans deux formats entremêlés.
  const app = Fastify({ logger: false });

  // `..` depuis le répertoire du module : src/ en développement, dist/ une fois
  // compilé. Le Dockerfile copie public/ à côté de dist/, les deux résolvent
  // donc vers la racine du projet.
  await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'public'),
  });

  app.get('/health', async (_request, reply) => {
    // Vérifier que la base répond, pas seulement que le process est vivant :
    // un disque plein ou un volume démonté laisserait le serveur debout mais
    // incapable d'enregistrer une commande — donc de livrer.
    try {
      deps.db.prepare('SELECT 1').get();
      return reply.send({ status: 'ok' });
    } catch (error) {
      return reply.code(503).send({
        status: 'degraded',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get('/success', async (_request, reply) => reply.sendFile('success.html'));
  app.get('/cancel', async (_request, reply) => reply.sendFile('cancel.html'));

  return app;
}
