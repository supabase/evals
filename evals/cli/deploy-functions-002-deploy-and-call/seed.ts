export const FUNCTION_SLUG = 'shipping-quote';

export type QuoteProbe = {
  request: { country: string; weightKg: number };
  expected: { quoteCents: number; currency: string };
};

/** Requests the scorer sends to the deployed function and the seeded rates' answers. */
export const QUOTE_PROBES: readonly QuoteProbe[] = [
  {
    request: { country: 'IE', weightKg: 2.3 },
    expected: { quoteCents: 810, currency: 'EUR' },
  },
  {
    request: { country: 'US', weightKg: 0.4 },
    expected: { quoteCents: 894, currency: 'USD' },
  },
];
