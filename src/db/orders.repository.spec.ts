import { DatabaseSync } from 'node:sqlite';

import { applySchema } from './database';
import { OrdersRepository } from './orders.repository';

const commande = {
  checkoutSessionId: 'cs_test_1',
  productId: 'entrainement',
  email: 'acheteur@example.com',
  amountTotal: 1990,
  currency: 'eur',
};

describe('OrdersRepository', () => {
  let db: DatabaseSync;
  let depot: OrdersRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    applySchema(db);
    depot = new OrdersRepository(db);
  });

  afterEach(() => db.close());

  describe('idempotence au niveau événement', () => {
    it('signale un événement inédit comme nouveau', () => {
      expect(depot.markEventProcessed('evt_1')).toBe(true);
    });

    it('signale un rejeu du même événement comme déjà traité', () => {
      depot.markEventProcessed('evt_1');

      expect(depot.markEventProcessed('evt_1')).toBe(false);
    });
  });

  describe('idempotence au niveau commande', () => {
    it('enregistre une commande inédite', () => {
      expect(depot.insertPaidOrder(commande)).toBe(true);
      expect(depot.findById('cs_test_1')).toMatchObject({ status: 'paid', downloadCount: 0 });
    });

    it('refuse une seconde commande pour la même session Stripe', () => {
      // Deux événements Stripe DIFFÉRENTS peuvent porter la même session :
      // le verrou par event_id ne suffit pas à empêcher la double livraison.
      depot.insertPaidOrder(commande);

      expect(depot.insertPaidOrder(commande)).toBe(false);
    });
  });

  describe('suivi de la livraison', () => {
    it('marque la commande livrée et horodate', () => {
      depot.insertPaidOrder(commande);
      depot.markDelivered('cs_test_1');

      const ordre = depot.findById('cs_test_1');
      expect(ordre?.status).toBe('delivered');
      expect(ordre?.deliveredAt).not.toBeNull();
    });

    it('marque un échec de livraison sans perdre la commande', () => {
      // Le paiement est encaissé : la commande doit rester consultable pour
      // permettre un renvoi manuel.
      depot.insertPaidOrder(commande);
      depot.markDeliveryFailed('cs_test_1');

      expect(depot.findById('cs_test_1')?.status).toBe('delivery_failed');
    });
  });

  describe('quota de téléchargement', () => {
    it("autorise tant que le quota n'est pas atteint, puis refuse", () => {
      depot.insertPaidOrder(commande);

      expect(depot.claimDownload('cs_test_1', 2)).toBe(true);
      expect(depot.claimDownload('cs_test_1', 2)).toBe(true);
      expect(depot.claimDownload('cs_test_1', 2)).toBe(false);
      expect(depot.findById('cs_test_1')?.downloadCount).toBe(2);
    });

    it('refuse pour une commande inexistante', () => {
      expect(depot.claimDownload('cs_inconnue', 5)).toBe(false);
    });
  });
});
