import { findProduct } from '../catalog/catalog';
import type { AppConfig } from '../config/env.config';
import type { Order, OrdersRepository } from '../db/orders.repository';
import type { EmailProvider } from '../email/email-provider';
import { renderDeliveryEmail } from '../email/templates/delivery';
import { logger } from '../logger';
import { signDownloadToken } from '../tokens/download-token';

/**
 * Livraison d'une commande payée.
 *
 * Séparé de la route webhook pour rester testable sans simuler une requête
 * HTTP signée, et pour qu'un futur renvoi manuel puisse réutiliser exactement
 * le même chemin.
 */
export class DeliveryService {
  constructor(
    private readonly deps: {
      orders: OrdersRepository;
      email: EmailProvider;
      config: AppConfig;
    },
  ) {}

  async deliver(order: Order): Promise<void> {
    const { orders, email, config } = this.deps;

    const produit = findProduct(order.productId);
    if (!produit) {
      // Un produit retiré du catalogue alors qu'une commande le référence : le
      // signaler bruyamment plutôt qu'envoyer un email sans lien exploitable.
      orders.markDeliveryFailed(order.checkoutSessionId);
      throw new Error(
        `Produit ${order.productId} absent du catalogue, commande ${order.checkoutSessionId} non livrée.`,
      );
    }

    const token = signDownloadToken(
      order.checkoutSessionId,
      config.downloadTokenSecret,
      config.downloadTokenTtlDays,
    );
    const message = renderDeliveryEmail({
      productName: produit.name,
      downloadUrl: `${config.publicBaseUrl}/api/download/${token}`,
      ttlDays: config.downloadTokenTtlDays,
    });

    try {
      await email.send({ to: { email: order.email }, ...message });
    } catch (error) {
      orders.markDeliveryFailed(order.checkoutSessionId);
      logger.error('Livraison échouée', {
        sessionId: order.checkoutSessionId,
        productId: produit.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    orders.markDelivered(order.checkoutSessionId);
    // L'adresse de l'acheteur reste hors du log : le sessionId suffit à
    // retrouver la commande dans Stripe comme en base.
    logger.info('Email envoyé', {
      sessionId: order.checkoutSessionId,
      productId: produit.id,
      provider: email.name,
    });
  }
}
