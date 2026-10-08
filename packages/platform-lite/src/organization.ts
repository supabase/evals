import { z } from 'zod';
import type { components } from './management-api/types.js';

type OrganizationResponse = components['schemas']['V1OrganizationSlugResponse'];
type OrganizationPlan = NonNullable<OrganizationResponse['plan']>;

export const organizationSeedSchema = z.object({
  name: z.string().min(1).optional(),
  plan: z.enum(['free', 'pro', 'team', 'enterprise', 'platform']).optional(),
}) satisfies z.ZodType<{ name?: string; plan?: OrganizationPlan }>;

export type OrganizationSeed = z.infer<typeof organizationSeedSchema>;

export type Organization = OrganizationResponse & {
  slug: string;
  plan: OrganizationPlan;
};

const DEFAULT_ORG_SLUG = 'default-org';

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

/**
 * Whether the org can create branches. The platform also allows allowlisted
 * free orgs and free orgs' K8s projects; platform-lite only models the plan.
 */
export function hasBranching(org: Organization): boolean {
  return org.plan !== 'free';
}
