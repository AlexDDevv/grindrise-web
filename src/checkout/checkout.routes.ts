import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { findProduct } from '../catalog/catalog';
import type { AppConfig } from '../config/env.config';
import type { OrdersRepository } from '../db/orders.repository';
import { logger } from '../logger';
import type { PayPlugClient } from '../payment/payplug.client';

export type CheckoutOptions = {
  config: AppConfig;
  payplug: Pick<PayPlugClient, 'createPayment'>;
  orders: OrdersRepository;
};

/** Contrôle de forme seulement : la vraie preuve qu'une adresse existe, c'est
 * l'email de livraison qui arrive. 255 = limite du champ côté PayPlug. */
function parseEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim();
  return email.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

export async function checkoutRoutes(
  app: FastifyInstance,
  opts: CheckoutOptions,
): Promise<void> {
  const { config, payplug, orders } = opts;

  app.post('/api/checkout', async (request, reply) => {
    const body = request.body as { productId?: unknown; email?: unknown } | undefined;
    const productId = typeof body?.productId === 'string' ? body.productId : undefined;

    if (!productId) {
      return reply.code(400).send({ error: 'productId requis.' });
    }

    // Contrairement à Stripe Checkout, la page hébergée PayPlug ne demande pas
    // l'email : c'est notre page qui le collecte, et c'est là que partira l'ebook.
    const email = parseEmail(body?.email);
    if (!email) {
      return reply.code(400).send({ error: 'Adresse email invalide.' });
    }

    // Le prix vient TOUJOURS du catalogue serveur. Un montant transmis par le
    // client serait un prix négociable par quiconque sait ouvrir un devtools.
    const produit = findProduct(productId);
    if (!produit) {
      return reply.code(404).send({ error: 'Produit inconnu.' });
    }

    const orderId = `ord_${randomUUID()}`;
    orders.createPending({
      id: orderId,
      productId: produit.id,
      email,
      amountTotal: produit.priceCents,
      currency: produit.currency,
    });

    try {
      const paiement = await payplug.createPayment({
        amount: produit.priceCents,
        currency: produit.currency,
        billing: { email, language: 'fr' },
        shipping: { email, language: 'fr', delivery_type: 'DIGITAL_GOODS' },
        hosted_payment: {
          return_url: `${config.publicBaseUrl}/success`,
          cancel_url: `${config.publicBaseUrl}/cancel`,
        },
        notification_url: `${config.publicBaseUrl}/api/payplug/notification`,
        // La notification ne porte que l'identifiant du paiement : c'est ce
        // metadata, relu côté PayPlug, qui mène à la commande à livrer.
        metadata: { order_id: orderId },
      });

      const paymentUrl = paiement.hosted_payment?.payment_url;
      if (!paymentUrl) {
        throw new Error(`Paiement ${paiement.id} créé sans payment_url.`);
      }

      orders.attachPayment(orderId, paiement.id);
      logger.info('Paiement créé', { orderId, paymentId: paiement.id, productId: produit.id });
      return reply.send({ url: paymentUrl });
    } catch (error) {
      // La commande reste en `pending` sans paiement : inoffensive, et utile
      // pour mesurer les échecs de création.
      logger.error('Création du paiement impossible', {
        orderId,
        productId: produit.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return reply.code(502).send({ error: 'Paiement indisponible, réessayez.' });
    }
  });
}
