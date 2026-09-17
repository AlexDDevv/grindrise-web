/**
 * Log JSON, une ligne par événement.
 *
 * CapRover agrège la sortie standard : une ligne = un événement rend les logs
 * lisibles sans agent externe, et `extra` reste interrogeable.
 *
 * C'est le seul point d'observation du tunnel de vente : paiement reçu, email
 * envoyé, téléchargement effectué passent tous par ici, pour qu'un problème de
 * livraison se diagnostique sans croiser les dashboards Stripe et Brevo.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Lu à l'import, avant toute validation : LOG_LEVEL est optionnel et une valeur
// inconnue ne doit pas empêcher de démarrer.
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

function emit(level: Level, message: string, extra?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...extra,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, extra?: Record<string, unknown>) => emit('debug', message, extra),
  info: (message: string, extra?: Record<string, unknown>) => emit('info', message, extra),
  warn: (message: string, extra?: Record<string, unknown>) => emit('warn', message, extra),
  error: (message: string, extra?: Record<string, unknown>) => emit('error', message, extra),
};
