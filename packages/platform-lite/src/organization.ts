import { z } from 'zod';
import type { components } from './management-api/types.js';

type OrganizationPlan = NonNullable<
  components['schemas']['V1OrganizationSlugResponse']['plan']
>;

export const organizationSeedSchema = z.object({
  name: z.string().min(1).optional(),
  plan: z.enum(['free', 'pro', 'team', 'enterprise', 'platform']).optional(),
}) satisfies z.ZodType<{ name?: string; plan?: OrganizationPlan }>;

export type OrganizationSeed = z.infer<typeof organizationSeedSchema>;

export type Organization = {
  id: string;
  slug: string;
  name: string;
  plan: OrganizationPlan;
  allowed_release_channels: Array<'ga'>;
  opt_in_tags: never[];
};

export const DEFAULT_ORG_SLUG = 'default-org';

/**
 * The 402 body the platform returns when a free-plan org tries to create a
 * branch (the `PaymentRequiredException` behind most `create_branch` failures).
 */
export const BRANCHING_REQUIRES_PAID_PLAN_MESSAGE =
  'Branching is supported only on the Pro plan or above';

export function createOrganization(seed: OrganizationSeed = {}): Organization {
  return {
    id: DEFAULT_ORG_SLUG,
    slug: DEFAULT_ORG_SLUG,
    name: seed.name ?? 'Default Organization',
    plan: seed.plan ?? 'free',
    allowed_release_channels: ['ga'],
    opt_in_tags: [],
  };
}

export function hasBranching(org: Organization): boolean {
  return org.plan !== 'free';
}

/**
 * Minimal emulation of `GET /v1/organizations/{slug}/entitlements`: only the
 * branching features, gated on plan. The real endpoint lists every feature
 * with plan- and override-specific limits; platform-lite doesn't model those.
 */
export function branchingEntitlements(
  org: Organization
): components['schemas']['V1ListEntitlementsResponse'] {
  const hasAccess = hasBranching(org);
  return {
    entitlements: [
      {
        feature: { key: 'branching_limit', type: 'numeric' },
        hasAccess,
        type: 'numeric',
        config: {
          enabled: hasAccess,
          value: 0,
          unlimited: hasAccess,
          unit: 'branches',
        },
      },
      {
        feature: { key: 'branching_persistent', type: 'boolean' },
        hasAccess,
        type: 'boolean',
        config: { enabled: hasAccess },
      },
    ],
  };
}
