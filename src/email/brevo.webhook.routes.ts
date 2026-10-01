import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../config/env.config';
import type { OrdersRepository } from '../db/orders.repository';
import { logger } from '../logger';

export type BrevoWebhookOptions = { config: AppConfig; orders: OrdersRepository };

/**
 * Événements de livraison Brevo.
 *
 * `email_sent` ne prouve que l'acceptation du message par Brevo, pas son
 * arrivée. C'est précisément l'écart constaté le 2026-10-01 : deux emails
 * acceptés, jamais remis, et une commande marquée livrée à tort. Ce webhook
 * ferme cet angle mort en inscrivant au journal ce que Brevo fait réellement
 * du message, et en repassant la commande en `delivery_failed` quand l'échec
 * est définitif.
 *
 * Brevo ne signe pas ses appels. L'origine est donc prouvée par un jeton en
 * `Authorization: Bearer`, configuré sur le webhook côté Brevo. Il est préféré
 * à un secret dans l'URL, qui finirait dans les journaux d'accès du proxy.
 */

/** Échecs définitifs : l'acheteur ne recevra pas ce message. */
const ECHECS_DEFINITIFS = new Set(['hard_bounce', 'blocked', 'invalid_email', 'spam', 'error']);

/** Échecs passagers : Brevo réessaie, la commande reste en l'état. */
const ECHECS_PASSAGERS = new Set(['soft_bounce', 'deferred']);

/**
 * Ouvertures et clics : volontairement ignorés, et jamais inscrits au journal.
 * Savoir qui ouvre son email n'aide en rien à livrer un ebook, et notre
 * politique de confidentialité annonce l'absence de traceur.
 */
const COMPORTEMENT = new Set([
  'opened',
  'unique_opened',
  'click',
  'proxy_open',
  'unique_proxy_open',
  'unsubscribed',
  'request',
]);

function jetonValide(entete: string | undefined, attendu: string): boolean {
  if (typeof entete !== 'string' || !entete.startsWith('Bearer ')) return false;

  // Comparaison à temps constant : une comparaison naïve fuiterait, par son
  // temps de retour, le nombre de caractères devinés correctement.
  const recu = Buffer.from(entete.slice('Bearer '.length));
  const bon = Buffer.from(attendu);

  return recu.length === bon.length && timingSafeEqual(recu, bon);
}

/** L'identifiant de commande voyage en étiquette, posée à l'envoi. */
function orderIdDe(corps: { tags?: unknown; tag?: unknown }): string | undefined {
  const etiquettes = [
    ...(Array.isArray(corps.tags) ? corps.tags : []),
    ...(typeof corps.tag === 'string' ? [corps.tag] : []),
  ];

  return etiquettes.find(
    (etiquette): etiquette is string =>
      typeof etiquette === 'string' && etiquette.startsWith('ord_'),
  );
}

export async function brevoWebhookRoutes(
  app: FastifyInstance,
  opts: BrevoWebhookOptions,
): Promise<void> {
  const { config, orders } = opts;

  app.post('/api/brevo/webhook', async (request, reply) => {
    if (!jetonValide(request.headers.authorization, config.brevoWebhookSecret)) {
      logger.warn('Webhook Brevo refusé : jeton absent ou invalide');
      return reply.code(401).send({ error: 'Non autorisé.' });
    }

    const corps = request.body as
      | { event?: unknown; tags?: unknown; tag?: unknown; reason?: unknown; 'message-id'?: unknown }
      | undefined;
    const evenement = typeof corps?.event === 'string' ? corps.event : undefined;
    if (!evenement) {
      return reply.code(400).send({ error: 'Événement absent.' });
    }

    if (COMPORTEMENT.has(evenement)) {
      logger.debug('Événement Brevo ignoré', { event: evenement });
      return reply.send({ received: true });
    }

    const orderId = orderIdDe(corps ?? {});
    if (!orderId || !orders.findById(orderId)) {
      // Sans commande, rien à tracer : le journal ne doit pas se remplir
      // d'événements que personne ne pourra rattacher.
      logger.warn('Événement Brevo sans commande correspondante', { event: evenement, orderId });
      return reply.send({ received: true });
    }

    // Ni l'email ni le sujet ne sont repris : seuls l'événement, sa raison et
    // l'identifiant technique du message entrent au journal.
    const detail = {
      event: evenement,
      reason: typeof corps?.reason === 'string' ? corps.reason : undefined,
      messageId: typeof corps?.['message-id'] === 'string' ? corps['message-id'] : undefined,
    };

    if (evenement === 'delivered') {
      orders.recordEvent({ type: 'email_delivered', orderId, detail });
      logger.info('Email remis au destinataire', { orderId });
      return reply.send({ received: true });
    }

    if (ECHECS_PASSAGERS.has(evenement)) {
      orders.recordEvent({ type: 'email_failed', orderId, detail });
      logger.warn('Remise de l’email différée par Brevo', { orderId, event: evenement });
      return reply.send({ received: true });
    }

    if (ECHECS_DEFINITIFS.has(evenement)) {
      orders.recordEvent({ type: 'email_failed', orderId, detail });
      // Le paiement est encaissé et l'acheteur n'a rien : la commande doit
      // réapparaître dans les rattrapages, pas rester « livrée ».
      orders.markDeliveryFailed(orderId, `brevo:${evenement}`);
      logger.error('Email jamais remis, commande à rattraper', {
        orderId,
        event: evenement,
        reason: detail.reason,
      });
      return reply.send({ received: true });
    }

    logger.debug('Événement Brevo inconnu', { event: evenement, orderId });
    return reply.send({ received: true });
  });
}
