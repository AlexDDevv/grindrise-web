import { DatabaseSync } from 'node:sqlite';

import { applySchema } from './database';
import { OrdersRepository } from './orders.repository';

const commande = {
  id: 'ord_1',
  productId: 'entrainement',
  email: 'acheteur@example.com',
  amountTotal: 1990,
  currency: 'EUR',
};

describe('applySchema', () => {
  it('refuse de démarrer sur une base au format Stripe', () => {
    // Sans ce contrôle, CREATE TABLE IF NOT EXISTS garderait l'ancienne table
    // et l'échec surviendrait au premier paiement, pas au démarrage.
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE orders (checkout_session_id TEXT PRIMARY KEY)');

    expect(() => applySchema(db)).toThrow(/format Stripe/);
    db.close();
  });
});

describe('OrdersRepository', () => {
  let db: DatabaseSync;
  let depot: OrdersRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    applySchema(db);
    depot = new OrdersRepository(db);
  });

  afterEach(() => db.close());

  it('enregistre une commande en attente de paiement', () => {
    depot.createPending(commande);

    expect(depot.findById('ord_1')).toMatchObject({
      status: 'pending',
      paymentId: null,
      downloadCount: 0,
    });
  });

  describe('idempotence du paiement', () => {
    beforeEach(() => {
      depot.createPending(commande);
      depot.attachPayment('ord_1', 'pay_1');
    });

    it('passe la commande en payée une seule fois', () => {
      // PayPlug rejoue la même notification : seul le premier passage livre.
      expect(depot.markPaid('ord_1', 'pay_1')).toBe(true);
      expect(depot.markPaid('ord_1', 'pay_1')).toBe(false);
      expect(depot.findById('ord_1')?.status).toBe('paid');
    });

    it('refuse un paiement qui n’est pas celui de la commande', () => {
      // metadata.order_id pointant vers une autre commande que celle ayant créé
      // le paiement : ne jamais livrer sur cette base.
      expect(depot.markPaid('ord_1', 'pay_autre')).toBe(false);
      expect(depot.findById('ord_1')?.status).toBe('pending');
    });

    it('ne ramène pas une commande déjà livrée à l’état payé', () => {
      depot.markPaid('ord_1', 'pay_1');
      depot.markDelivered('ord_1');

      expect(depot.markPaid('ord_1', 'pay_1')).toBe(false);
      expect(depot.findById('ord_1')?.status).toBe('delivered');
    });

    it('interdit qu’un même paiement soit rattaché à deux commandes', () => {
      depot.createPending({ ...commande, id: 'ord_2' });

      expect(() => depot.attachPayment('ord_2', 'pay_1')).toThrow(/UNIQUE/);
    });
  });

  describe('suivi de la livraison', () => {
    beforeEach(() => {
      depot.createPending(commande);
      depot.attachPayment('ord_1', 'pay_1');
      depot.markPaid('ord_1', 'pay_1');
    });

    it('marque la commande livrée et horodate', () => {
      depot.markDelivered('ord_1');

      const ordre = depot.findById('ord_1');
      expect(ordre?.status).toBe('delivered');
      expect(ordre?.deliveredAt).not.toBeNull();
    });

    it('marque un échec de livraison sans perdre la commande', () => {
      // Le paiement est encaissé : la commande doit rester consultable pour
      // permettre un renvoi manuel.
      depot.markDeliveryFailed('ord_1');

      expect(depot.findById('ord_1')?.status).toBe('delivery_failed');
    });
  });

  describe('quota de téléchargement', () => {
    it("autorise tant que le quota n'est pas atteint, puis refuse", () => {
      depot.createPending(commande);
      depot.attachPayment('ord_1', 'pay_1');
      depot.markPaid('ord_1', 'pay_1');

      expect(depot.claimDownload('ord_1', 2)).toBe(true);
      expect(depot.claimDownload('ord_1', 2)).toBe(true);
      expect(depot.claimDownload('ord_1', 2)).toBe(false);
      expect(depot.findById('ord_1')?.downloadCount).toBe(2);
    });

    it('refuse pour une commande jamais payée', () => {
      depot.createPending(commande);

      expect(depot.claimDownload('ord_1', 5)).toBe(false);
    });

    it('refuse pour une commande inexistante', () => {
      expect(depot.claimDownload('ord_inconnue', 5)).toBe(false);
    });
  });
});
