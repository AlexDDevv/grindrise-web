import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';

import type { AppConfig } from '../config/env.config';
import type { OrdersRepository } from '../db/orders.repository';
import type { DeliveryService } from '../delivery/delivery.service';
import { logger } from '../logger';

export type WebhookOptions = {
  config: AppConfig;
  stripe: Stripe;
  orders: OrdersRepository;
  delivery: DeliveryService;
};

export async function webhookRoutes(
  app: FastifyInstance,
  opts: WebhookOptions,
): Promise<void> {
  const { config, stripe, orders, delivery } = opts;

  // Stripe signe les octets exacts du corps. Fastify parse le JSON par défaut,
  // et un corps re-sérialisé (ordre des clés, espaces) invalide la signature.
  // Ce parser est encapsulé dans ce plugin : /api/checkout garde le JSON parsé.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/api/stripe/webhook', async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      return reply.code(400).send({ error: 'Signature absente.' });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        signature,
        config.stripeWebhookSecret,
      );
    } catch (error) {
      // Signature invalide : soit le secret ne correspond pas (confusion entre
      // celui de test et celui de production), soit l'appel n'est pas de Stripe.
      logger.warn('Webhook refusé', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return reply.code(400).send({ error: 'Signature invalide.' });
    }

    if (event.type !== 'checkout.session.completed') {
      logger.debug('Événement ignoré', { eventId: event.id, type: event.type });
      return reply.send({ received: true });
    }

    // Premier verrou : rejeu du même événement.
    if (!orders.markEventProcessed(event.id)) {
      logger.info('Événement déjà traité, ignoré', { eventId: event.id });
      return reply.send({ received: true });
    }

    const session = event.data.object as Stripe.Checkout.Session;

    if (session.payment_status !== 'paid') {
      logger.info('Paiement non abouti, aucune livraison', {
        sessionId: session.id,
        paymentStatus: session.payment_status,
      });
      return reply.send({ received: true });
    }

    const productId = session.metadata?.productId;
    const email = session.customer_details?.email;
    if (!productId || !email) {
      logger.error('Session inexploitable, livraison impossible', {
        sessionId: session.id,
        hasProductId: Boolean(productId),
        hasEmail: Boolean(email),
      });
      return reply.send({ received: true });
    }

    // Second verrou : deux événements distincts, une seule session.
    const inedite = orders.insertPaidOrder({
      checkoutSessionId: session.id,
      productId,
      email,
      amountTotal: session.amount_total ?? 0,
      currency: session.currency ?? 'eur',
    });

    if (!inedite) {
      logger.info('Commande déjà enregistrée, aucune seconde livraison', {
        sessionId: session.id,
      });
      return reply.send({ received: true });
    }

    logger.info('Paiement reçu', { sessionId: session.id, productId });

    const commande = orders.findById(session.id);
    if (commande) {
      try {
        await delivery.deliver(commande);
      } catch {
        // `deliver` a déjà journalisé et marqué delivery_failed. Répondre 200
        // quand même : le paiement est enregistré, et un 500 ferait retenter
        // Stripe sans corriger la cause. Le rattrapage est manuel.
      }
    }

    return reply.send({ received: true });
  });
}
