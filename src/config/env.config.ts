import { payplugModeOf, type PayPlugMode } from '../payment/payplug.client';

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
  payplugSecretKey: string;
  /** Déduit du préfixe de la clé : PayPlug n'a pas d'endpoint de test séparé. */
  payplugMode: PayPlugMode;
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

  // Aucune valeur par défaut, même en développement : une clé factice ferait
  // démarrer le serveur et reporterait l'échec au premier achat, en 401.
  const payplugSecretKey = required('PAYPLUG_SECRET_KEY');
  const brevoApiKey = required('BREVO_API_KEY');
  const brevoSenderEmail = required('BREVO_SENDER_EMAIL');
  const downloadTokenSecret = required('DOWNLOAD_TOKEN_SECRET');
  const publicBaseUrl = required('PUBLIC_BASE_URL');

  if (missing.length > 0) {
    throw new Error(
      `Variables d'environnement manquantes : ${missing.join(', ')}. Voir .env.example.`,
    );
  }

  const payplugMode = payplugModeOf(payplugSecretKey);
  if (!payplugMode) {
    // La clé publique (pk_…) se trouve à côté de la secrète dans le dashboard :
    // c'est la confusion la plus probable, autant la nommer.
    throw new Error(
      'PAYPLUG_SECRET_KEY invalide : clé secrète sk_test_… ou sk_live_… attendue (pas la clé publique pk_…).',
    );
  }

  // Une clé live avec une URL publique en http, c'est une configuration locale
  // passée en production par erreur : les liens de livraison partiraient vers
  // localhost dans les emails de vrais acheteurs, et PayPlug ne pourrait pas
  // joindre la notification_url.
  if (payplugMode === 'live' && !publicBaseUrl.startsWith('https://')) {
    throw new Error(
      `Clé PayPlug live avec PUBLIC_BASE_URL non https (${publicBaseUrl}) : mélange probable test/production.`,
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
    payplugSecretKey,
    payplugMode,
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
