export const FUNCTION_SLUG = 'apply-promo';
/** The version platform-lite gives a function seeded from `remote/functions`. */
export const SEEDED_VERSION = 1;

export type PromoProbe = {
  group: 'fix' | 'kept';
  request: { code: string; cartCents: number };
  expected: { valid: true; discountCents: number } | { valid: false };
};

/** Requests the scorer sends to the live function: lowercase codes the fix must accept, and rules the seeded source already enforces. */
export const PROMO_PROBES: readonly PromoProbe[] = [
  {
    group: 'fix',
    request: { code: 'welcome10', cartCents: 6000 },
    expected: { valid: true, discountCents: 600 },
  },
  {
    group: 'fix',
    request: { code: 'freeship', cartCents: 6000 },
    expected: { valid: true, discountCents: 495 },
  },
  {
    group: 'fix',
    request: { code: 'loyal15', cartCents: 6000 },
    expected: { valid: true, discountCents: 900 },
  },
  {
    group: 'kept',
    request: { code: 'LOYAL15', cartCents: 6000 },
    expected: { valid: true, discountCents: 900 },
  },
  {
    group: 'kept',
    request: { code: 'FREESHIP', cartCents: 2000 },
    expected: { valid: false },
  },
  {
    group: 'kept',
    request: { code: 'LOYAL15', cartCents: 3000 },
    expected: { valid: false },
  },
  {
    group: 'kept',
    request: { code: 'SPRING50', cartCents: 6000 },
    expected: { valid: false },
  },
];
