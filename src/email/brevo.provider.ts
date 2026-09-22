import {
  PermanentEmailError,
  TransientEmailError,
  type EmailMessage,
  type EmailProvider,
} from './email-provider';
import { logger } from '../logger';

export type BrevoSender = {
  email: string;
  name: string;
  replyTo?: string;
};

const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/** Undici attend 300 s par défaut sans timeout explicite : la notification
 * PayPlug qui déclenche l'envoi resterait ouverte cinq minutes, et un appelant
 * qui abandonne avant la réponse renvoie la notification. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Tronque le corps avant de le journaliser en debug : diagnostic, pas archive. */
function preview(body: string): string {
  return body.length > 300 ? `${body.slice(0, 300)}…` : body;
}

/**
 * Envoi transactionnel via l'API HTTP de Brevo.
 *
 * Pas de SDK : le paquet officiel est lourd et mal typé pour ce qui tient en un
 * `fetch`. Node 22 fournit `fetch` nativement, donc zéro dépendance ajoutée.
 *
 * L'identité de l'expéditeur est injectée au constructeur et jamais dans un
 * message : passer à un domaine authentifié SPF/DKIM ne touchera que la
 * configuration.
 */
export class BrevoEmailProvider implements EmailProvider {
  readonly name = 'brevo';

  constructor(
    private readonly apiKey: string,
    private readonly sender: BrevoSender,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const payload: Record<string, unknown> = {
      sender: { email: this.sender.email, name: this.sender.name },
      to: [
        message.to.name
          ? { email: message.to.email, name: message.to.name }
          : { email: message.to.email },
      ],
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text,
    };

    if (this.sender.replyTo) {
      payload.replyTo = { email: this.sender.replyTo };
    }

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'api-key': this.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
        // Un dépassement (AbortSignal.timeout) rejette avec une erreur comme
        // n'importe quelle autre panne réseau : rattrapée par le `catch`
        // ci-dessous, donc classée passagère — à rejouer, pas à abandonner.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new TransientEmailError(
        `Brevo injoignable : ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    if (response.ok) return;

    const body = await response.text().catch(() => '');

    // Les réponses d'erreur Brevo (400 destinataire invalide/bloqué en tête)
    // peuvent contenir l'adresse email du destinataire. Le corps ne va donc
    // jamais dans `message` — que l'appelant journalise tel quel en warn ou en
    // error — seulement en debug, désactivé par défaut (`LOG_LEVEL=info`).
    // Le code HTTP suffit à diagnostiquer sans rouvrir les logs ; le corps
    // reste disponible pour qui active le niveau debug en connaissance de cause.
    logger.debug('Brevo a répondu en erreur', { status: response.status, body: preview(body) });

    // 429 = quota atteint, 5xx = panne du fournisseur. Les deux se rattrapent.
    if (response.status === 429 || response.status >= 500) {
      throw new TransientEmailError(`Brevo a répondu ${response.status}.`);
    }

    // 4xx restants : clé invalide, expéditeur non validé, message refusé.
    throw new PermanentEmailError(`Brevo a refusé l'envoi (${response.status}).`);
  }
}
