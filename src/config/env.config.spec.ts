import { validateEnv } from './env.config';

const complet = {
  PAYPLUG_SECRET_KEY: 'sk_test_123',
  BREVO_API_KEY: 'xkeysib-123',
  BREVO_SENDER_EMAIL: 'contact@example.com',
  DOWNLOAD_TOKEN_SECRET: 'un-secret-de-test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
};

describe('validateEnv', () => {
  it('accepte un environnement complet et applique les valeurs par défaut', () => {
    const config = validateEnv(complet);

    expect(config.payplugSecretKey).toBe('sk_test_123');
    expect(config.payplugMode).toBe('test');
    expect(config.port).toBe(3000);
    expect(config.dataDir).toBe('./data');
    expect(config.brevoSenderName).toBe('Grindrise');
    expect(config.downloadTokenTtlDays).toBe(7);
    expect(config.downloadMaxUses).toBe(5);
    expect(config.brevoReplyTo).toBeUndefined();
  });

  it('liste toutes les variables manquantes en une fois', () => {
    // Une erreur par variable obligerait à relancer le container autant de fois
    // qu'il manque de clés : la liste complète en un message évite ce ping-pong.
    expect(() => validateEnv({})).toThrow(/PAYPLUG_SECRET_KEY.*BREVO_API_KEY/s);
  });

  it('refuse une clé PayPlug qui n’est pas une clé secrète', () => {
    expect(() => validateEnv({ ...complet, PAYPLUG_SECRET_KEY: 'pk_test_123' })).toThrow(
      /PAYPLUG_SECRET_KEY invalide/,
    );
  });

  it('déduit le mode live du préfixe de la clé', () => {
    const config = validateEnv({
      ...complet,
      PAYPLUG_SECRET_KEY: 'sk_live_123',
      PUBLIC_BASE_URL: 'https://exemple.fr',
    });

    expect(config.payplugMode).toBe('live');
  });

  it('refuse une clé live avec une URL publique non https', () => {
    // Configuration de développement déployée avec la clé de production : les
    // liens de livraison pointeraient vers localhost dans de vrais emails.
    expect(() => validateEnv({ ...complet, PAYPLUG_SECRET_KEY: 'sk_live_123' })).toThrow(
      /mélange probable/,
    );
  });

  it('retire le slash final de PUBLIC_BASE_URL', () => {
    // Sans ça, les liens envoyés par email contiennent un double slash.
    const config = validateEnv({ ...complet, PUBLIC_BASE_URL: 'https://exemple.fr/' });

    expect(config.publicBaseUrl).toBe('https://exemple.fr');
  });

  it('refuse un entier non strictement positif', () => {
    expect(() => validateEnv({ ...complet, DOWNLOAD_MAX_USES: '0' })).toThrow(/DOWNLOAD_MAX_USES/);
    expect(() => validateEnv({ ...complet, PORT: 'abc' })).toThrow(/PORT/);
  });
});
