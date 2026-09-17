import { logger } from './logger';

describe('logger', () => {
  let out: jest.SpyInstance;

  beforeEach(() => {
    out = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('émet une ligne JSON contenant niveau, message et horodatage', () => {
    logger.info('Paiement reçu');

    expect(out).toHaveBeenCalledTimes(1);
    const line = JSON.parse(out.mock.calls[0][0] as string);
    expect(line).toMatchObject({ level: 'info', message: 'Paiement reçu' });
    expect(Number.isNaN(Date.parse(line.ts))).toBe(false);
  });

  it('fusionne le contexte à plat pour rester interrogeable', () => {
    logger.info('Email envoyé', { orderId: 'ord_1', provider: 'brevo' });

    const line = JSON.parse(out.mock.calls[0][0] as string);
    expect(line).toMatchObject({ orderId: 'ord_1', provider: 'brevo' });
  });

  it('tait les niveaux sous le seuil, à LOG_LEVEL=info par défaut', () => {
    logger.debug('Détail de diagnostic');

    expect(out).not.toHaveBeenCalled();
  });
});
