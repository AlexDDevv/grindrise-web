import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../config/env.config';
import type { OrdersRepository } from '../db/orders.repository';
import type { DeliveryService } from '../delivery/delivery.service';
import { logger } from '../logger';
import { PayPlugError, type PayPlugClient, type PayPlugPayment } from '../payment/payplug.client';

export type NotificationOptions = {
  config: AppConfig;
  payplug: Pick<PayPlugClient, 'retrievePayment'>;
  orders: OrdersRepository;
  delivery: DeliveryService;
};

/** Filtre l'identifiant avant de l'insérer dans une URL d'API. */
const PAYMENT_ID = /^pay_[A-Za-z0-9]+$/;

/**
 * Notifications IPN de PayPlug.
 *
 * PayPlug ne signe pas ses notifications : n'importe qui peut POSTer ici un
 * corps affirmant qu'un paiement est réussi. Le corps n'est donc lu que pour y
 * prendre un identifiant de paiement, et TOUTE décision repose sur la relecture
 * de ce paiement auprès de l'API PayPlug, authentifiée par notre clé secrète.
 * Une notification forgée ne peut au pire que déclencher cette relecture.
 */
export async function notificationRoutes(
  app: FastifyInstance,
  opts: NotificationOptions,
): Promise<void> {
  const { config, payplug, orders, delivery } = opts;

  app.post('/api/payplug/notification', async (request, reply) => {
    const body = request.body as { id?: unknown; object?: unknown; is_live?: unknown } | undefined;

    // PayPlug notifie aussi les remboursements (`refund`) : rien à livrer.
    if (body?.object !== 'payment') {
      logger.debug('Notification ignorée', { object: body?.object });
      return reply.send({ received: true });
    }

    const paymentId = typeof body.id === 'string' && PAYMENT_ID.test(body.id) ? body.id : undefined;
    if (!paymentId) {
      logger.warn('Notification refusée : identifiant de paiement absent ou mal formé');
      return reply.code(400).send({ error: 'Identifiant de paiement invalide.' });
    }

    // Purement indicatif (le corps n'est pas fiable), mais c'est le symptôme
    // typique d'une notification_url de production pointée par un compte test,
    // ou l'inverse : la relecture échouera en 404, ce log dit pourquoi.
    if (typeof body.is_live === 'boolean' && body.is_live !== (config.payplugMode === 'live')) {
      logger.warn('Notification d’un autre mode que la clé configurée', {
        paymentId,
        notificationLive: body.is_live,
        keyMode: config.payplugMode,
      });
    }

    // Rattachement provisoire, pour que l'historique de la commande montre
    // aussi les notifications refusées. Le corps n'y gagne aucune confiance :
    // seule la relecture ci-dessous décide de livrer.
    const orderIdConnu = orders.findByPaymentId(paymentId)?.id;
    const tracer = (
      type: Parameters<OrdersRepository['recordEvent']>[0]['type'],
      detail?: Record<string, unknown>,
      orderId = orderIdConnu,
    ): void => orders.recordEvent({ type, orderId, paymentId, detail });

    // Ce que PayPlug (ou un imposteur) a affirmé, archivé champ par champ :
    // stocker le corps entier laisserait n'importe qui remplir la base avec
    // des notifications forgées de plusieurs centaines de Ko.
    tracer('notification_received', { claimed: { id: body.id, object: body.object, is_live: body.is_live } });
    logger.info('Notification reçue', { paymentId });

    let paiement: PayPlugPayment;
    try {
      paiement = await payplug.retrievePayment(paymentId);
    } catch (error) {
      if (error instanceof PayPlugError && error.status === 404) {
        // Inconnu de PayPlug pour NOTRE clé : notification forgée, ou émise
        // dans l'autre mode (test/live). Rien à livrer dans les deux cas.
        tracer('notification_rejected', { reason: 'payment_not_found' });
        logger.warn('Notification pour un paiement introuvable chez PayPlug', { paymentId });
        return reply.code(400).send({ error: 'Paiement inconnu.' });
      }

      // PayPlug injoignable, ou clé refusée (401) : on ne sait pas si le
      // paiement est réussi. Répondre en erreur laisse PayPlug renvoyer la
      // notification ; le log permet sinon un rattrapage manuel.
      const echec = {
        status: error instanceof PayPlugError ? error.status : undefined,
        reason: error instanceof Error ? error.message : String(error),
      };
      tracer('verification_failed', echec);
      logger.error('Vérification du paiement impossible', { paymentId, ...echec });
      return reply.code(502).send({ error: 'Vérification impossible.' });
    }

    // À partir d'ici, seul `paiement` — relu chez PayPlug — fait foi.
    if (!paiement.is_paid) {
      tracer('payment_not_paid', { failure: paiement.failure });
      logger.info('Paiement non abouti, aucune livraison', {
        paymentId,
        failure: paiement.failure?.code,
      });
      return reply.send({ received: true });
    }

    const orderId =
      typeof paiement.metadata?.order_id === 'string' ? paiement.metadata.order_id : undefined;
    const commande = orderId ? orders.findById(orderId) : undefined;
    if (!orderId || !commande) {
      // Payé mais sans commande correspondante : base restaurée, ou paiement
      // créé hors du tunnel. L'argent est encaissé, il faut regarder à la main.
      tracer('payment_mismatch', { reason: 'order_not_found', metadataOrderId: orderId });
      logger.error('Paiement confirmé sans commande correspondante', { paymentId, orderId });
      return reply.send({ received: true });
    }

    if (commande.paymentId !== paiement.id) {
      tracer(
        'payment_mismatch',
        { reason: 'payment_not_attached', expectedPaymentId: commande.paymentId },
        orderId,
      );
      logger.error('Paiement non rattaché à cette commande, aucune livraison', {
        paymentId,
        orderId,
        expectedPaymentId: commande.paymentId,
      });
      return reply.send({ received: true });
    }

    if (paiement.amount !== commande.amountTotal || paiement.currency !== commande.currency) {
      tracer(
        'payment_mismatch',
        {
          reason: 'amount_mismatch',
          paid: { amount: paiement.amount, currency: paiement.currency },
          expected: { amount: commande.amountTotal, currency: commande.currency },
        },
        orderId,
      );
      logger.error('Montant payé différent de la commande, aucune livraison', {
        paymentId,
        orderId,
        paid: `${paiement.amount} ${paiement.currency}`,
        expected: `${commande.amountTotal} ${commande.currency}`,
      });
      return reply.send({ received: true });
    }

    // Verrou d'idempotence : seule la notification qui fait passer la commande
    // de `pending` à `paid` livre. Les rejeux — même simultanés — s'arrêtent ici.
    // markPaid trace lui-même les deux issues (confirmé / déjà traité).
    if (!orders.markPaid(orderId, paiement.id)) {
      logger.info('Paiement déjà traité, aucune seconde livraison', {
        paymentId,
        orderId,
        status: commande.status,
      });
      return reply.send({ received: true });
    }

    logger.info('Paiement confirmé', { orderId, paymentId, productId: commande.productId });

    try {
      await delivery.deliver({ ...commande, status: 'paid' });
    } catch {
      // `deliver` a déjà journalisé et marqué delivery_failed. Répondre 200
      // quand même : le paiement est enregistré, et une erreur ferait renvoyer
      // la notification sans corriger la cause. Le rattrapage est manuel.
    }

    return reply.send({ received: true });
  });
}
