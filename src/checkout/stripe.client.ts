import Stripe from 'stripe';

/**
 * Client Stripe.
 *
 * Isolé dans sa propre fabrique pour que les tests de route injectent un double
 * sans jamais instancier le vrai SDK ni toucher au réseau.
 */
export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey);
}
