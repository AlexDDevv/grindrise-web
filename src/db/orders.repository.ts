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
   * Enregistre la commande AVANT le paiement : le prix, le produit et l'email
   * viennent de notre serveur, et la notification PayPlug n'aura plus qu'à
   * pointer vers cette ligne via `metadata.order_id`.
   */
  createPending(input: NewOrder): void {
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
  }

  /** Relie la commande au paiement PayPlug créé pour elle. */
  attachPayment(orderId: string, paymentId: string): void {
    this.db.prepare('UPDATE orders SET payment_id = ? WHERE id = ?').run(paymentId, orderId);
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
   * @returns true si cet appel a effectué la transition et doit livrer.
   */
  markPaid(orderId: string, paymentId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE orders SET status = 'paid', paid_at = ?
         WHERE id = ? AND payment_id = ? AND status = 'pending'`,
      )
      .run(new Date().toISOString(), orderId, paymentId);

    return result.changes > 0;
  }

  findById(orderId: string): Order | undefined {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
      | OrderRow
      | undefined;

    return row ? toOrder(row) : undefined;
  }

  markDelivered(orderId: string): void {
    this.db
      .prepare(`UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), orderId);
  }

  markDeliveryFailed(orderId: string): void {
    this.db.prepare(`UPDATE orders SET status = 'delivery_failed' WHERE id = ?`).run(orderId);
  }

  /**
   * Consomme un téléchargement.
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
    const result = this.db
      .prepare(
        `UPDATE orders SET download_count = download_count + 1
         WHERE id = ? AND status != 'pending' AND download_count < ?`,
      )
      .run(orderId, maxUses);

    return result.changes > 0;
  }
}
