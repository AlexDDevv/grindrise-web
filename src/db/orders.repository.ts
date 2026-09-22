import type { DatabaseSync } from 'node:sqlite';

export type OrderStatus = 'pending' | 'paid' | 'delivered' | 'delivery_failed';

export type Order = {
  id: string;
  paymentId: string | null;
  productId: string;
  email: string;
  amountTotal: number;
  currency: string;
  status: OrderStatus;
  downloadCount: number;
  createdAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
};

export type NewOrder = {
  id: string;
  productId: string;
  email: string;
  amountTotal: number;
  currency: string;
};

type OrderRow = {
  id: string;
  payment_id: string | null;
  product_id: string;
  email: string;
  amount_total: number;
  currency: string;
  status: string;
  download_count: number;
  created_at: string;
  paid_at: string | null;
  delivered_at: string | null;
};

/**
 * Ce qui est tracé dans `order_events`. Une étape du tunnel = un type : la
 * liste se lit comme le déroulé complet d'une commande, incidents compris.
 */
export type OrderEventType =
  | 'order_created'
  | 'payment_created'
  | 'payment_creation_failed'
  | 'notification_received'
  | 'notification_rejected'
  | 'verification_failed'
  | 'payment_not_paid'
  | 'payment_mismatch'
  | 'payment_confirmed'
  | 'payment_already_processed'
  | 'email_sent'
  | 'delivery_failed'
  | 'download_served'
  | 'download_refused';

export type NewOrderEvent = {
  type: OrderEventType;
  orderId?: string;
  paymentId?: string;
  /** Contexte de l'étape. Jamais de donnée personnelle : l'email vit dans
   * `orders`, une seule fois, et n'est pas dupliqué dans le journal. */
  detail?: Record<string, unknown>;
};

export type OrderEvent = {
  id: number;
  orderId: string | null;
  paymentId: string | null;
  type: OrderEventType;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

type OrderEventRow = {
  id: number;
  order_id: string | null;
  payment_id: string | null;
  type: string;
  detail: string | null;
  created_at: string;
};

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    paymentId: row.payment_id,
    productId: row.product_id,
    email: row.email,
    amountTotal: row.amount_total,
    currency: row.currency,
    status: row.status as OrderStatus,
    downloadCount: row.download_count,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    deliveredAt: row.delivered_at,
  };
}

export class OrdersRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Exécute un changement d'état et sa trace dans une seule transaction : un
   * crash entre les deux laisserait sinon un état sans trace, ou une trace
   * d'un changement qui n'a jamais eu lieu.
   */
  private atomically<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Ajoute une ligne au journal d'audit. Appelé directement pour les étapes
   * sans changement d'état (notification reçue, anomalie…), et en interne par
   * chaque méthode qui modifie une commande.
   */
  recordEvent(event: NewOrderEvent): void {
    this.db
      .prepare(
        `INSERT INTO order_events (order_id, payment_id, type, detail, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        event.orderId ?? null,
        event.paymentId ?? null,
        event.type,
        event.detail ? JSON.stringify(event.detail) : null,
        new Date().toISOString(),
      );
  }

  /** Historique d'une commande, dans l'ordre chronologique. Les événements
   * tracés avant que la commande ne soit identifiée (notification reçue) sont
   * rattachés par leur payment_id. */
  listEvents(orderId: string): OrderEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM order_events
         WHERE order_id = ?
            OR payment_id = (SELECT payment_id FROM orders WHERE id = ?)
         ORDER BY id`,
      )
      .all(orderId, orderId) as OrderEventRow[];

    return rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      paymentId: row.payment_id,
      type: row.type as OrderEventType,
      detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : null,
      createdAt: row.created_at,
    }));
  }

  /**
   * Enregistre la commande AVANT le paiement : le prix, le produit et l'email
   * viennent de notre serveur, et la notification PayPlug n'aura plus qu'à
   * pointer vers cette ligne via `metadata.order_id`.
   */
  createPending(input: NewOrder): void {
    this.atomically(() => {
      this.db
        .prepare(
          `INSERT INTO orders (id, product_id, email, amount_total, currency, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          input.id,
          input.productId,
          input.email,
          input.amountTotal,
          input.currency,
          new Date().toISOString(),
        );
      this.recordEvent({
        type: 'order_created',
        orderId: input.id,
        detail: {
          productId: input.productId,
          amount: input.amountTotal,
          currency: input.currency,
        },
      });
    });
  }

  /** Relie la commande au paiement PayPlug créé pour elle. */
  attachPayment(orderId: string, paymentId: string): void {
    this.atomically(() => {
      this.db.prepare('UPDATE orders SET payment_id = ? WHERE id = ?').run(paymentId, orderId);
      this.recordEvent({ type: 'payment_created', orderId, paymentId });
    });
  }

  /**
   * Verrou d'idempotence : fait passer la commande de `pending` à `paid`, une
   * seule fois, et seulement pour le paiement qui lui est rattaché.
   *
   * PayPlug peut envoyer plusieurs fois la même notification, y compris en
   * parallèle. La décision de livrer découle du nombre de lignes modifiées,
   * jamais d'un SELECT préalable — qui rouvrirait la fenêtre de concurrence à
   * refermer. La contrainte UNIQUE sur `payment_id` interdit par ailleurs qu'un
   * même paiement serve deux commandes.
   *
   * Les deux issues sont tracées : un rejeu ignoré est aussi une information.
   *
   * @returns true si cet appel a effectué la transition et doit livrer.
   */
  markPaid(orderId: string, paymentId: string): boolean {
    return this.atomically(() => {
      const result = this.db
        .prepare(
          `UPDATE orders SET status = 'paid', paid_at = ?
           WHERE id = ? AND payment_id = ? AND status = 'pending'`,
        )
        .run(new Date().toISOString(), orderId, paymentId);

      const transition = result.changes > 0;
      this.recordEvent({
        type: transition ? 'payment_confirmed' : 'payment_already_processed',
        orderId,
        paymentId,
      });
      return transition;
    });
  }

  findById(orderId: string): Order | undefined {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
      | OrderRow
      | undefined;

    return row ? toOrder(row) : undefined;
  }

  findByPaymentId(paymentId: string): Order | undefined {
    const row = this.db.prepare('SELECT * FROM orders WHERE payment_id = ?').get(paymentId) as
      | OrderRow
      | undefined;

    return row ? toOrder(row) : undefined;
  }

  markDelivered(orderId: string, detail: { provider: string }): void {
    this.atomically(() => {
      this.db
        .prepare(`UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), orderId);
      this.recordEvent({ type: 'email_sent', orderId, detail });
    });
  }

  markDeliveryFailed(orderId: string, reason: string): void {
    this.atomically(() => {
      this.db.prepare(`UPDATE orders SET status = 'delivery_failed' WHERE id = ?`).run(orderId);
      this.recordEvent({ type: 'delivery_failed', orderId, detail: { reason } });
    });
  }

  /**
   * Consomme un téléchargement, et trace l'issue.
   *
   * Le test du quota et l'incrément sont une seule instruction SQL : les
   * séparer permettrait à deux requêtes simultanées de passer toutes les deux
   * le contrôle avant que l'une n'incrémente. Une commande encore `pending`
   * n'a jamais été payée : aucun téléchargement ne lui est accordé.
   *
   * @returns false si la commande n'existe pas, n'est pas payée ou si le quota
   *   est atteint.
   */
  claimDownload(orderId: string, maxUses: number): boolean {
    return this.atomically(() => {
      const result = this.db
        .prepare(
          `UPDATE orders SET download_count = download_count + 1
           WHERE id = ? AND status != 'pending' AND download_count < ?`,
        )
        .run(orderId, maxUses);

      const commande = this.findById(orderId);
      if (result.changes > 0) {
        this.recordEvent({
          type: 'download_served',
          orderId,
          detail: { count: commande?.downloadCount },
        });
        return true;
      }

      const reason = !commande
        ? 'order_not_found'
        : commande.status === 'pending'
          ? 'not_paid'
          : 'quota_reached';
      this.recordEvent({ type: 'download_refused', orderId, detail: { reason, maxUses } });
      return false;
    });
  }
}
