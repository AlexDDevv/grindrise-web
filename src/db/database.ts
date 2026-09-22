import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Stockage des commandes.
 *
 * PayPlug reste la source de vérité des paiements : cette base trace ce qui a
 * été commandé, garantit qu'une livraison ne part qu'une fois, et relie un
 * paiement PayPlug à la commande qui l'a créé. SQLite plutôt qu'un fichier JSON
 * parce que l'idempotence repose sur une écriture conditionnelle appliquée
 * atomiquement — deux notifications concurrentes liraient le même JSON avant
 * que l'une n'écrive.
 */
export function applySchema(db: DatabaseSync): void {
  // Le premier schéma (Stripe) indexait les commandes par session Checkout.
  // `CREATE TABLE IF NOT EXISTS` le laisserait en place sans rien dire, et
  // chaque requête échouerait ensuite sur une colonne inconnue — au moment
  // précis d'enregistrer un paiement. Mieux vaut refuser de démarrer.
  const colonnes = db.prepare('PRAGMA table_info(orders)').all() as { name: string }[];
  if (colonnes.some((colonne) => colonne.name === 'checkout_session_id')) {
    throw new Error(
      "Base de commandes au format Stripe détectée : l'archiver puis supprimer orders.db avant de démarrer.",
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id                  TEXT PRIMARY KEY,
      payment_id          TEXT UNIQUE,
      product_id          TEXT NOT NULL,
      email               TEXT NOT NULL,
      amount_total        INTEGER NOT NULL,
      currency            TEXT NOT NULL,
      status              TEXT NOT NULL,
      download_count      INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL,
      paid_at             TEXT,
      delivered_at        TEXT
    );

    -- Journal d'audit : ce que le serveur a fait de chaque commande et de
    -- chaque paiement, dans l'ordre. La table orders ne garde que l'état courant ;
    -- l'historique vit ici. order_id et payment_id sont tous deux nullables :
    -- une notification pour un paiement inconnu se trace sans commande.
    -- Aucune clé étrangère volontairement : une trace doit pouvoir citer une
    -- commande introuvable, c'est précisément ce qu'elle signale.
    CREATE TABLE IF NOT EXISTS order_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    TEXT,
      payment_id  TEXT,
      type        TEXT NOT NULL,
      detail      TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS order_events_order_id ON order_events (order_id);
    CREATE INDEX IF NOT EXISTS order_events_payment_id ON order_events (payment_id);

    -- Journal en ajout seul, garanti par la base et non par la discipline du
    -- code : une trace modifiable après coup ne prouve rien. Une purge au terme
    -- de la durée de conservation devra supprimer ces triggers explicitement.
    CREATE TRIGGER IF NOT EXISTS order_events_no_update
      BEFORE UPDATE ON order_events
      BEGIN SELECT RAISE(ABORT, 'order_events est en ajout seul'); END;

    CREATE TRIGGER IF NOT EXISTS order_events_no_delete
      BEFORE DELETE ON order_events
      BEGIN SELECT RAISE(ABORT, 'order_events est en ajout seul'); END;
  `);
}

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'orders.db'));

  // WAL : un téléchargement en cours ne doit pas bloquer l'écriture d'une
  // notification qui arrive au même moment.
  db.exec('PRAGMA journal_mode = WAL');
  applySchema(db);
  return db;
}
