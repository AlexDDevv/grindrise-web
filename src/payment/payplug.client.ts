import { logger } from '../logger';

/**
 * Client REST PayPlug minimal.
 *
 * Pas de SDK : PayPlug n'en publie aucun pour Node, et les paquets npm
 * communautaires reposent sur une authentification par session abandonnée par
 * l'API. Deux appels suffisent au tunnel — créer un paiement, relire un
 * paiement — et tiennent chacun en un `fetch`.
 */

const API_BASE_URL = 'https://api.payplug.com';

/** Version d'API figée : sans cet en-tête, PayPlug applique la version par
 * défaut du compte, qui peut changer côté dashboard sans que le code le sache. */
const API_VERSION = '2019-08-06';

/** Même raisonnement que pour Brevo : sans timeout, undici attend 300 s, et la
 * notification PayPlug qui attend cette réponse resterait ouverte d'autant. */
const REQUEST_TIMEOUT_MS = 10_000;

export type PayPlugMode = 'test' | 'live';

/** Sous-ensemble de l'objet `payment` renvoyé par PayPlug, limité à ce que le
 * tunnel lit. */
export type PayPlugPayment = {
  id: string;
  object: 'payment';
  is_live: boolean;
  is_paid: boolean;
  amount: number;
  currency: string;
  failure: { code: string; message: string } | null;
  hosted_payment: { payment_url: string } | null;
  metadata: Record<string, unknown> | null;
};

type Contact = { email: string; language: 'fr' };

export type CreatePaymentParams = {
  /** En centimes. */
  amount: number;
  currency: 'EUR';
  billing: Contact;
  shipping: Contact & { delivery_type: 'DIGITAL_GOODS' };
  hosted_payment: { return_url: string; cancel_url: string };
  notification_url: string;
  metadata: Record<string, string>;
};

/**
 * Échec d'un appel à l'API PayPlug.
 *
 * `status` vaut `undefined` quand PayPlug n'a pas répondu (réseau, timeout) :
 * l'appelant distingue ainsi une panne passagère d'un refus explicite.
 */
export class PayPlugError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PayPlugError';
  }
}

/** Tronque le corps avant de le journaliser en debug : diagnostic, pas archive. */
function preview(body: string): string {
  return body.length > 300 ? `${body.slice(0, 300)}…` : body;
}

/**
 * Déduit le mode du préfixe de la clé. PayPlug sert test et live sur le même
 * endpoint : seule la clé les distingue, c'est donc elle qu'il faut vérifier.
 */
export function payplugModeOf(secretKey: string): PayPlugMode | undefined {
  if (secretKey.startsWith('sk_test_')) return 'test';
  if (secretKey.startsWith('sk_live_')) return 'live';
  return undefined;
}

export class PayPlugClient {
  readonly mode: PayPlugMode;

  constructor(private readonly secretKey: string) {
    // Garde-fou redondant avec validateEnv, volontairement : un client construit
    // hors de main.ts (script de rattrapage, test manuel) doit lui aussi
    // échouer tout de suite plutôt qu'au premier paiement, en 401.
    const mode = payplugModeOf(secretKey);
    if (!mode) {
      throw new Error('Clé PayPlug absente ou invalide : sk_test_… ou sk_live_… attendue.');
    }
    this.mode = mode;
  }

  createPayment(params: CreatePaymentParams): Promise<PayPlugPayment> {
    return this.request('POST', '/v1/payments', params);
  }

  retrievePayment(paymentId: string): Promise<PayPlugPayment> {
    return this.request('GET', `/v1/payments/${encodeURIComponent(paymentId)}`);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<PayPlugPayment> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          'payplug-version': API_VERSION,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new PayPlugError(
        `PayPlug injoignable : ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    const text = await response.text().catch(() => '');

    if (!response.ok) {
      // Les erreurs de validation PayPlug citent les champs envoyés, email de
      // l'acheteur compris : le corps reste en debug, jamais dans le message.
      logger.debug('PayPlug a répondu en erreur', {
        method,
        path,
        status: response.status,
        body: preview(text),
      });
      throw new PayPlugError(`PayPlug a répondu ${response.status}.`, response.status);
    }

    try {
      return JSON.parse(text) as PayPlugPayment;
    } catch {
      throw new PayPlugError('Réponse PayPlug illisible.', response.status);
    }
  }
}
