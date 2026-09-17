import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Stockage des commandes.
 *
 * Stripe reste la source de vérité des paiements : cette base ne sert qu'à
 * garantir qu'une livraison ne part qu'une fois, et à tracer ce qui a été
 * envoyé. SQLite plutôt qu'un fichier JSON parce que l'idempotence repose sur
 * une contrainte d'unicité appliquée atomiquement — deux webhooks concurrents
 * liraient le même JSON avant que l'un n'écrive.
 */
export function applySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      checkout_session_id TEXT PRIMARY KEY,
      product_id          TEXT NOT NULL,
      email               TEXT NOT NULL,
      amount_total        INTEGER NOT NULL,
      currency            TEXT NOT NULL,
      status              TEXT NOT NULL,
      download_count      INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL,
      delivered_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS processed_events (
      event_id    TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    );
  `);
}

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'orders.db'));

  // WAL : un téléchargement en cours ne doit pas bloquer l'écriture d'un
  // webhook qui arrive au même moment.
  db.exec('PRAGMA journal_mode = WAL');
  applySchema(db);
  return db;
}
