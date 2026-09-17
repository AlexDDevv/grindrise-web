import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';

import { findProduct } from '../catalog/catalog';
import type { AppConfig } from '../config/env.config';
import { logger } from '../logger';

export type CheckoutOptions = { config: AppConfig; stripe: Stripe };

export async function checkoutRoutes(
  app: FastifyInstance,
  opts: CheckoutOptions,
): Promise<void> {
  const { config, stripe } = opts;

  app.post('/api/checkout', async (request, reply) => {
    const body = request.body as { productId?: unknown } | undefined;
    const productId = typeof body?.productId === 'string' ? body.productId : undefined;

    if (!productId) {
      return reply.code(400).send({ error: 'productId requis.' });
    }

    // Le prix vient TOUJOURS du catalogue serveur. Un montant transmis par le
    // client serait un prix négociable par quiconque sait ouvrir un devtools.
    const produit = findProduct(productId);
    if (!produit) {
      return reply.code(404).send({ error: 'Produit inconnu.' });
    }

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: produit.currency,
              unit_amount: produit.priceCents,
              product_data: { name: produit.name, description: produit.description },
            },
          },
        ],
        // Le webhook ne reçoit que la session : sans ce metadata, impossible de
        // savoir quel PDF livrer.
        metadata: { productId: produit.id },
        success_url: `${config.publicBaseUrl}/success`,
        cancel_url: `${config.publicBaseUrl}/cancel`,
      });

      logger.info('Session de paiement créée', { sessionId: session.id, productId: produit.id });
      return reply.send({ url: session.url });
    } catch (error) {
      logger.error('Création de session impossible', {
        productId: produit.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return reply.code(502).send({ error: 'Paiement indisponible, réessayez.' });
    }
  });
}
