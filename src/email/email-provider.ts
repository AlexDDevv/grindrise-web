/**
 * Abstraction d'envoi d'email.
 *
 * `from` n'apparaît PAS dans `EmailMessage` : l'identité de l'expéditeur
 * appartient au fournisseur, qui la lit dans sa configuration. C'est ce qui
 * rend le passage à un domaine authentifié SPF/DKIM une simple variable
 * d'environnement — aucun appelant, aucun gabarit, aucun handler ne mentionne
 * jamais une adresse d'expédition.
 *
 * Ce fichier n'importe rien du serveur HTTP et ne doit jamais le faire : la
 * couche email ignore par quel mécanisme on l'appelle.
 */
export type EmailMessage = {
  to: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
};

export interface EmailProvider {
  /** Nom court du fournisseur, pour les logs. */
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/**
 * Échec définitif : clé invalide, expéditeur non validé, message refusé.
 * Retenter ne ferait que retarder le diagnostic.
 */
export class PermanentEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEmailError';
  }
}

/** Échec passager : quota atteint, panne du fournisseur, coupure réseau. */
export class TransientEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientEmailError';
  }
}
