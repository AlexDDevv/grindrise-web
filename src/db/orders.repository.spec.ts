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
      depot.markDelivered('ord_1', { provider: 'fake' });

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
      depot.markDelivered('ord_1', { provider: 'fake' });

      const ordre = depot.findById('ord_1');
      expect(ordre?.status).toBe('delivered');
      expect(ordre?.deliveredAt).not.toBeNull();
    });

    it('marque un échec de livraison sans perdre la commande', () => {
      // Le paiement est encaissé : la commande doit rester consultable pour
      // permettre un renvoi manuel.
      depot.markDeliveryFailed('ord_1', 'Brevo HS');

      expect(depot.findById('ord_1')?.status).toBe('delivery_failed');
    });
  });

  describe("journal d'audit", () => {
    const types = () => depot.listEvents('ord_1').map((e) => e.type);

    it('trace chaque étape du parcours nominal, dans l’ordre', () => {
      depot.createPending(commande);
      depot.attachPayment('ord_1', 'pay_1');
      depot.markPaid('ord_1', 'pay_1');
      depot.markDelivered('ord_1', { provider: 'brevo' });
      depot.claimDownload('ord_1', 5);

      expect(types()).toEqual([
        'order_created',
        'payment_created',
        'payment_confirmed',
        'email_sent',
        'download_served',
      ]);
    });

    it('trace un rejeu de paiement ignoré', () => {
      // Un rejeu sans trace serait invisible : impossible de prouver ensuite
      // que la seconde notification est bien arrivée et a été écartée.
      depot.createPending(commande);
      depot.attachPayment('ord_1', 'pay_1');
      depot.markPaid('ord_1', 'pay_1');
      depot.markPaid('ord_1', 'pay_1');

      expect(types().slice(-2)).toEqual(['payment_confirmed', 'payment_already_processed']);
    });

    it('conserve l’historique complet quand le statut est écrasé', () => {
      // orders ne garde que l'état courant : un échec suivi d'un renvoi réussi
      // n'y laisse que « delivered ». Le journal, lui, garde les deux.
      depot.createPending(commande);
      depot.attachPayment('ord_1', 'pay_1');
      depot.markPaid('ord_1', 'pay_1');
      depot.markDeliveryFailed('ord_1', 'Brevo a répondu 503.');
      depot.markDelivered('ord_1', { provider: 'brevo' });

      const evenements = depot.listEvents('ord_1');
      expect(evenements.map((e) => e.type).slice(-2)).toEqual(['delivery_failed', 'email_sent']);
      expect(evenements.at(-2)?.detail).toEqual({ reason: 'Brevo a répondu 503.' });
    });

    it('trace un téléchargement refusé et sa raison', () => {
      depot.createPending(commande);

      depot.claimDownload('ord_1', 5);

      expect(depot.listEvents('ord_1').at(-1)).toMatchObject({
        type: 'download_refused',
        detail: { reason: 'not_paid' },
      });
    });

    it('rattache à la commande les événements tracés par payment_id seul', () => {
      depot.createPending(commande);
      depot.attachPayment('ord_1', 'pay_1');
      depot.recordEvent({ type: 'notification_received', paymentId: 'pay_1' });

      expect(types()).toContain('notification_received');
    });

    it('ne duplique pas l’email de l’acheteur dans le journal', () => {
      // Donnée personnelle : une seule copie, dans orders.
      depot.createPending(commande);
      depot.attachPayment('ord_1', 'pay_1');
      depot.markPaid('ord_1', 'pay_1');
      depot.markDelivered('ord_1', { provider: 'brevo' });

      expect(JSON.stringify(depot.listEvents('ord_1'))).not.toContain(commande.email);
    });

    it('refuse toute modification ou suppression du journal', () => {
      // Une trace modifiable après coup ne prouve rien : c'est la base qui
      // l'interdit, pas seulement le code.
      depot.createPending(commande);

      expect(() => db.exec(`UPDATE order_events SET type = 'email_sent'`)).toThrow(/ajout seul/);
      expect(() => db.exec('DELETE FROM order_events')).toThrow(/ajout seul/);
      expect(types()).toEqual(['order_created']);
    });

    it('annule le changement d’état si sa trace ne peut pas être écrite', () => {
      // Une commande sans trace est pire qu'une commande refusée : on perdrait
      // la preuve de ce qui s'est passé. Supprimer la table du journal fait
      // échouer l'événement APRÈS l'INSERT de la commande.
      db.exec('DROP TABLE order_events');

      expect(() => depot.createPending(commande)).toThrow();
      expect(depot.findById('ord_1')).toBeUndefined();
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
