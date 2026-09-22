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
 * Séparé de la route de notification pour rester testable sans simuler
 * PayPlug, et pour qu'un futur renvoi manuel puisse réutiliser exactement
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
      orders.markDeliveryFailed(order.id, 'product_not_in_catalog');
      throw new Error(
        `Produit ${order.productId} absent du catalogue, commande ${order.id} non livrée.`,
      );
    }

    const token = signDownloadToken(
      order.id,
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
      const reason = error instanceof Error ? error.message : String(error);
      orders.markDeliveryFailed(order.id, reason);
      logger.error('Livraison échouée', { orderId: order.id, productId: produit.id, reason });
      throw error;
    }

    orders.markDelivered(order.id, { provider: email.name });
    // L'adresse de l'acheteur reste hors du log : l'orderId suffit à
    // retrouver la commande en base, et son payment_id dans PayPlug.
    logger.info('Email envoyé', {
      orderId: order.id,
      productId: produit.id,
      provider: email.name,
    });
  }
}
