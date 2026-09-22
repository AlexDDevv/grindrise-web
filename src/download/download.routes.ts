import { createReadStream, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { findProduct } from '../catalog/catalog';
import type { AppConfig } from '../config/env.config';
import type { OrdersRepository } from '../db/orders.repository';
import { logger } from '../logger';
import { verifyDownloadToken } from '../tokens/download-token';

export type DownloadOptions = { config: AppConfig; orders: OrdersRepository };

/**
 * Longueur maximale d'un paramètre d'URL, à passer dans `routerOptions`.
 *
 * Fastify plafonne à 100 caractères par défaut et répond 414 au-delà. Un token
 * de téléchargement porte un identifiant de commande (`ord_` + UUID, 40
 * caractères), une date d'expiration et une signature HMAC en base64url : il
 * dépasse les 100 caractères. Sans ce relèvement, AUCUN lien de livraison ne
 * fonctionne.
 */
export const DOWNLOAD_MAX_PARAM_LENGTH = 512;

export async function downloadRoutes(
  app: FastifyInstance,
  opts: DownloadOptions,
): Promise<void> {
  const { config, orders } = opts;

  app.get<{ Params: { token: string } }>('/api/download/:token', async (request, reply) => {
    const orderId = verifyDownloadToken(request.params.token, config.downloadTokenSecret);
    if (!orderId) {
      logger.warn('Téléchargement refusé : token invalide ou expiré');
      return reply.code(403).send({ error: 'Lien invalide ou expiré.' });
    }

    const commande = orders.findById(orderId);
    if (!commande) {
      // Token signé mais commande absente : base restaurée, ou secret réutilisé
      // entre deux environnements. Anormal, donc journalisé.
      logger.error('Token valide sans commande correspondante', { orderId });
      return reply.code(403).send({ error: 'Lien invalide ou expiré.' });
    }

    const produit = findProduct(commande.productId);
    if (!produit) {
      logger.error('Produit absent du catalogue', {
        orderId,
        productId: commande.productId,
      });
      return reply.code(500).send({ error: 'Fichier indisponible.' });
    }

    // basename neutralise tout composant de chemin : même avec un catalogue
    // mal rempli, la lecture ne peut pas sortir de DATA_DIR/ebooks.
    const chemin = join(config.dataDir, 'ebooks', basename(produit.fileName));

    // Le fichier est vérifié AVANT de consommer le quota : un PDF manquant est
    // notre panne, elle ne doit pas coûter un téléchargement à l'acheteur.
    if (!existsSync(chemin)) {
      logger.error('PDF introuvable dans le volume', { orderId, chemin });
      return reply.code(500).send({ error: 'Fichier indisponible.' });
    }

    if (!orders.claimDownload(orderId, config.downloadMaxUses)) {
      logger.warn('Téléchargement refusé : quota atteint', {
        orderId,
        maxUses: config.downloadMaxUses,
      });
      return reply.code(410).send({ error: 'Nombre de téléchargements atteint.' });
    }

    logger.info('Téléchargement effectué', {
      orderId,
      productId: produit.id,
      count: commande.downloadCount + 1,
    });

    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${produit.fileName}"`)
      .send(createReadStream(chemin));
  });
}
