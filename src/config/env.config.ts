/**
 * Validation de l'environnement au démarrage.
 *
 * Même philosophie que grindrise-notifications : un container mal configuré
 * doit crasher au boot pour que CapRover le signale immédiatement, jamais
 * échouer silencieusement au premier paiement — moment où l'argent est déjà
 * encaissé et où l'acheteur attend son fichier.
 */
export type AppConfig = {
  port: number;
  publicBaseUrl: string;
  dataDir: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  brevoApiKey: string;
  brevoSenderEmail: string;
  brevoSenderName: string;
  brevoReplyTo?: string;
  downloadTokenSecret: string;
  downloadTokenTtlDays: number;
  downloadMaxUses: number;
};

export function validateEnv(raw: Record<string, unknown>): AppConfig {
  const missing: string[] = [];

  const required = (key: string): string => {
    const value = raw[key];
    if (typeof value !== 'string' || value.trim() === '') {
      missing.push(key);
      return '';
    }
    return value.trim();
  };

  const optional = (key: string, fallback: string): string => {
    const value = raw[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
  };

  const stripeSecretKey = required('STRIPE_SECRET_KEY');
  const stripeWebhookSecret = required('STRIPE_WEBHOOK_SECRET');
  const brevoApiKey = required('BREVO_API_KEY');
  const brevoSenderEmail = required('BREVO_SENDER_EMAIL');
  const downloadTokenSecret = required('DOWNLOAD_TOKEN_SECRET');
  const publicBaseUrl = required('PUBLIC_BASE_URL');

  if (missing.length > 0) {
    throw new Error(
      `Variables d'environnement manquantes : ${missing.join(', ')}. Voir .env.example.`,
    );
  }

  const positiveInteger = (key: string, fallback: number): number => {
    const value = raw[key];
    if (typeof value !== 'string' || value.trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${key} invalide : ${value}. Entier strictement positif attendu.`);
    }
    return parsed;
  };

  const replyTo = raw.BREVO_REPLY_TO;

  return {
    port: positiveInteger('PORT', 3000),
    // Le slash final produirait des liens en double slash dans des emails déjà
    // partis — irrattrapable une fois envoyés.
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
    dataDir: optional('DATA_DIR', './data'),
    stripeSecretKey,
    stripeWebhookSecret,
    brevoApiKey,
    brevoSenderEmail,
    brevoSenderName: optional('BREVO_SENDER_NAME', 'Grindrise'),
    brevoReplyTo:
      typeof replyTo === 'string' && replyTo.trim() !== '' ? replyTo.trim() : undefined,
    downloadTokenSecret,
    downloadTokenTtlDays: positiveInteger('DOWNLOAD_TOKEN_TTL_DAYS', 7),
    downloadMaxUses: positiveInteger('DOWNLOAD_MAX_USES', 5),
  };
}
