import { DatabaseSync } from 'node:sqlite';

import { CATALOG, findProduct } from '../catalog/catalog';
import type { AppConfig } from '../config/env.config';
import { applySchema } from '../db/database';
import { OrdersRepository } from '../db/orders.repository';
import type { EmailProvider } from '../email/email-provider';
import { verifyDownloadToken } from '../tokens/download-token';
import { DeliveryService } from './delivery.service';

const config = {
  publicBaseUrl: 'https://exemple.fr',
  downloadTokenSecret: 'secret-de-test',
  downloadTokenTtlDays: 7,
  downloadMaxUses: 5,
} as AppConfig;

/** Le pack : deux fichiers, donc deux liens à vérifier. */
const PACK = findProduct('pack-complet')!;

function contexte(productId: string = CATALOG[0].id) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const orders = new OrdersRepository(db);
  const send = jest.fn(async (_message: unknown) => undefined);
  const email: EmailProvider = { name: 'fake', send };

  orders.createPending({
    id: 'ord_1',
    productId,
    email: 'acheteur@example.com',
    amountTotal: CATALOG[0].priceCents,
    currency: CATALOG[0].currency,
  });
  orders.attachPayment('ord_1', 'pay_1');
  orders.markPaid('ord_1', 'pay_1');

  return { db, orders, send, service: new DeliveryService({ orders, email, config }) };
}

describe('DeliveryService', () => {
  it('envoie un email contenant un lien vérifiable vers la commande', async () => {
    const { orders, send, service, db } = contexte();

    await service.deliver(orders.findById('ord_1')!);

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0] as { to: { email: string }; text: string };
    expect(message.to.email).toBe('acheteur@example.com');

    const lien = message.text.match(/https:\/\/\S+/)![0];
    const token = lien.split('/').pop()!;
    expect(verifyDownloadToken(token, config.downloadTokenSecret)).toEqual({
      orderId: 'ord_1',
      fileIndex: 0,
    });
    db.close();
  });

  it('envoie un lien par ebook pour le pack, chacun désignant son fichier', async () => {
    // Un seul lien pour deux ebooks, ou deux liens vers le même fichier :
    // l'acheteur aurait payé 14,90 € pour un seul livre.
    const { orders, send, service, db } = contexte(PACK.id);

    await service.deliver(orders.findById('ord_1')!);

    const message = send.mock.calls[0][0] as { text: string };
    const tokens = [...message.text.matchAll(/https:\/\/\S+\/api\/download\/(\S+)/g)].map(
      (m) => m[1],
    );

    expect(tokens).toHaveLength(PACK.files.length);
    expect(tokens.map((t) => verifyDownloadToken(t, config.downloadTokenSecret))).toEqual([
      { orderId: 'ord_1', fileIndex: 0 },
      { orderId: 'ord_1', fileIndex: 1 },
    ]);
    for (const ebook of PACK.files) {
      expect(message.text).toContain(ebook.title);
    }
    db.close();
  });

  it('marque la commande livrée après un envoi réussi', async () => {
    const { orders, service, db } = contexte();

    await service.deliver(orders.findById('ord_1')!);

    expect(orders.findById('ord_1')?.status).toBe('delivered');
    db.close();
  });

  it("marque delivery_failed et propage si l'envoi échoue", async () => {
    // Le paiement est encaissé : perdre la trace de l'échec rendrait le
    // rattrapage manuel impossible.
    const { orders, db } = contexte();
    const casse = new DeliveryService({
      orders,
      email: {
        name: 'fake',
        send: jest.fn(async () => {
          throw new Error('Brevo HS');
        }),
      },
      config,
    });

    await expect(casse.deliver(orders.findById('ord_1')!)).rejects.toThrow('Brevo HS');
    expect(orders.findById('ord_1')?.status).toBe('delivery_failed');
    db.close();
  });

  it('refuse de livrer une commande dont le produit a disparu du catalogue', async () => {
    const { orders, send, service, db } = contexte();
    const orpheline = { ...orders.findById('ord_1')!, productId: 'supprime-du-catalogue' };

    await expect(service.deliver(orpheline)).rejects.toThrow(/catalogue/i);
    expect(send).not.toHaveBeenCalled();
    db.close();
  });
});
