import { validateEnv } from './config/env.config';
import { openDatabase } from './db/database';
import { OrdersRepository } from './db/orders.repository';
import { DeliveryService } from './delivery/delivery.service';
import { BrevoEmailProvider } from './email/brevo.provider';
import { logger } from './logger';
import { PayPlugClient } from './payment/payplug.client';
import { buildServer } from './server';

async function main(): Promise<void> {
  // Échoue au boot si une variable manque : CapRover signale immédiatement un
  // container mal configuré, au lieu d'un échec au premier paiement.
  const config = validateEnv(process.env);

  const db = openDatabase(config.dataDir);
  const orders = new OrdersRepository(db);
  const email = new BrevoEmailProvider(config.brevoApiKey, {
    email: config.brevoSenderEmail,
    name: config.brevoSenderName,
    replyTo: config.brevoReplyTo,
  });
  const delivery = new DeliveryService({ orders, email, config });
  const payplug = new PayPlugClient(config.payplugSecretKey);

  const app = await buildServer({ config, db, orders, email, payplug, delivery });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  // Le mode figure dans chaque démarrage : c'est la première chose à lire
  // quand un paiement réel n'arrive pas, ou qu'un paiement de test livre en prod.
  logger.info('Serveur à l\'écoute', {
    port: config.port,
    baseUrl: config.publicBaseUrl,
    payplugMode: config.payplugMode,
  });

  // Sans arrêt propre, un redéploiement CapRover coupe une requête en cours —
  // potentiellement une notification entre l'enregistrement de la commande et l'envoi
  // de l'email, qui laisserait un acheteur payé sans son fichier.
  const shutdown = (signal: string): void => {
    logger.info('Arrêt demandé', { signal });

    // Garde-fou : au-delà du délai de grâce Docker, un arrêt qui traîne finit
    // en SIGKILL — moins propre qu'une sortie volontaire et journalisée.
    // `unref()` est indispensable : sans lui, ce minuteur empêcherait à lui
    // seul le process de se terminer si l'arrêt réussit avant l'échéance.
    const forceExit = setTimeout(() => {
      logger.error('Arrêt trop long, sortie forcée', { signal });
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    app
      .close()
      .then(() => {
        db.close();
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error('Arrêt en erreur', { reason: String(error) });
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error('Démarrage impossible', {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
