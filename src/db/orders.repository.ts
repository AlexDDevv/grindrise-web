import type { DatabaseSync } from 'node:sqlite';

export type OrderStatus = 'paid' | 'delivered' | 'delivery_failed';

export type Order = {
  checkoutSessionId: string;
  productId: string;
  email: string;
  amountTotal: number;
  currency: string;
  status: OrderStatus;
  downloadCount: number;
  createdAt: string;
  deliveredAt: string | null;
};

export type NewOrder = {
  checkoutSessionId: string;
  productId: string;
  email: string;
  amountTotal: number;
  currency: string;
};

type OrderRow = {
  checkout_session_id: string;
  product_id: string;
  email: string;
  amount_total: number;
  currency: string;
  status: string;
  download_count: number;
  created_at: string;
  delivered_at: string | null;
};

function toOrder(row: OrderRow): Order {
  return {
    checkoutSessionId: row.checkout_session_id,
    productId: row.product_id,
    email: row.email,
    amountTotal: row.amount_total,
    currency: row.currency,
    status: row.status as OrderStatus,
    downloadCount: row.download_count,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

export class OrdersRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Premier verrou d'idempotence : couvre le rejeu du MÊME événement, quand
   * notre 200 s'est perdu et que Stripe retente.
   *
   * @returns true si l'événement est inédit et doit être traité.
   */
  markEventProcessed(eventId: string): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO processed_events (event_id, received_at)
         VALUES (?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(eventId, new Date().toISOString());

    return result.changes > 0;
  }

  /**
   * Second verrou : couvre deux événements DIFFÉRENTS portant la même session
   * Stripe, que le premier verrou laisse passer.
   *
   * La décision de livrer découle du nombre de lignes écrites, jamais d'un
   * SELECT préalable — qui rouvrirait la fenêtre de concurrence à refermer.
   *
   * @returns true si la commande est inédite et doit être livrée.
   */
  insertPaidOrder(input: NewOrder): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO orders
           (checkout_session_id, product_id, email, amount_total, currency, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'paid', ?) ON CONFLICT DO NOTHING`,
      )
      .run(
        input.checkoutSessionId,
        input.productId,
        input.email,
        input.amountTotal,
        input.currency,
        new Date().toISOString(),
      );

    return result.changes > 0;
  }

  findById(checkoutSessionId: string): Order | undefined {
    const row = this.db
      .prepare('SELECT * FROM orders WHERE checkout_session_id = ?')
      .get(checkoutSessionId) as OrderRow | undefined;

    return row ? toOrder(row) : undefined;
  }

  markDelivered(checkoutSessionId: string): void {
    this.db
      .prepare(
        `UPDATE orders SET status = 'delivered', delivered_at = ?
         WHERE checkout_session_id = ?`,
      )
      .run(new Date().toISOString(), checkoutSessionId);
  }

  markDeliveryFailed(checkoutSessionId: string): void {
    this.db
      .prepare(`UPDATE orders SET status = 'delivery_failed' WHERE checkout_session_id = ?`)
      .run(checkoutSessionId);
  }

  /**
   * Consomme un téléchargement.
   *
   * Le test du quota et l'incrément sont une seule instruction SQL : les
   * séparer permettrait à deux requêtes simultanées de passer toutes les deux
   * le contrôle avant que l'une n'incrémente.
   *
   * @returns false si la commande n'existe pas ou si le quota est atteint.
   */
  claimDownload(checkoutSessionId: string, maxUses: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE orders SET download_count = download_count + 1
         WHERE checkout_session_id = ? AND download_count < ?`,
      )
      .run(checkoutSessionId, maxUses);

    return result.changes > 0;
  }
}
