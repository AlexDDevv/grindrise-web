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
 * caractères), l'indice du fichier, une date d'expiration et une signature HMAC
 * en base64url : il dépasse les 100 caractères. Sans ce relèvement, AUCUN lien
 * de livraison ne fonctionne.
 */
export const DOWNLOAD_MAX_PARAM_LENGTH = 512;

export async function downloadRoutes(
  app: FastifyInstance,
  opts: DownloadOptions,
): Promise<void> {
  const { config, orders } = opts;

  app.get<{ Params: { token: string } }>('/api/download/:token', async (request, reply) => {
    const claim = verifyDownloadToken(request.params.token, config.downloadTokenSecret);
    if (!claim) {
      logger.warn('Téléchargement refusé : token invalide ou expiré');
      return reply.code(403).send({ error: 'Lien invalide ou expiré.' });
    }

    const { orderId, fileIndex } = claim;

    const commande = orders.findById(orderId);
    if (!commande) {
      // Token signé mais commande absente : base restaurée, ou secret réutilisé
      // entre deux environnements. Anormal, donc journalisé.
      orders.recordEvent({
        type: 'download_refused',
        orderId,
        detail: { fileIndex, reason: 'order_not_found' },
      });
      logger.error('Token valide sans commande correspondante', { orderId });
      return reply.code(403).send({ error: 'Lien invalide ou expiré.' });
    }

    const produit = findProduct(commande.productId);
    if (!produit) {
      orders.recordEvent({
        type: 'download_refused',
        orderId,
        detail: { fileIndex, reason: 'product_not_in_catalog' },
      });
      logger.error('Produit absent du catalogue', {
        orderId,
        productId: commande.productId,
      });
      return reply.code(500).send({ error: 'Fichier indisponible.' });
    }

    // Le token désigne une position dans `files`. Un indice hors bornes signe
    // un token forgé, ou un catalogue dont l'ordre des fichiers a changé après
    // l'envoi du lien — les deux méritent un refus explicite.
    const ebook = produit.files[fileIndex];
    if (!ebook) {
      orders.recordEvent({
        type: 'download_refused',
        orderId,
        detail: { fileIndex, reason: 'unknown_file_index', files: produit.files.length },
      });
      logger.error('Fichier inconnu pour ce produit', {
        orderId,
        productId: produit.id,
        fileIndex,
      });
      return reply.code(403).send({ error: 'Lien invalide ou expiré.' });
    }

    // basename neutralise tout composant de chemin : même avec un catalogue
    // mal rempli, la lecture ne peut pas sortir de DATA_DIR/ebooks.
    const chemin = join(config.dataDir, 'ebooks', basename(ebook.fileName));

    // Le fichier est vérifié AVANT de consommer le quota : un PDF manquant est
    // notre panne, elle ne doit pas coûter un téléchargement à l'acheteur.
    if (!existsSync(chemin)) {
      orders.recordEvent({
        type: 'download_refused',
        orderId,
        detail: { fileIndex, reason: 'file_missing' },
      });
      logger.error('PDF introuvable dans le volume', { orderId, chemin });
      return reply.code(500).send({ error: 'Fichier indisponible.' });
    }

    if (!orders.claimDownload(orderId, fileIndex, config.downloadMaxUses)) {
      logger.warn('Téléchargement refusé : quota atteint', {
        orderId,
        fileIndex,
        maxUses: config.downloadMaxUses,
      });
      return reply.code(410).send({ error: 'Nombre de téléchargements atteint.' });
    }

    logger.info('Téléchargement effectué', {
      orderId,
      productId: produit.id,
      fileIndex,
      count: orders.downloadCount(orderId, fileIndex),
    });

    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${ebook.fileName}"`)
      .send(createReadStream(chemin));
  });
}
