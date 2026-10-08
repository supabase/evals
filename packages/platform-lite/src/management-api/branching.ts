import { z } from 'zod';
import {
  BRANCHING_REQUIRES_PAID_PLAN_MESSAGE,
  hasBranching,
  type Organization,
} from '../organization.js';
import { ProjectInstance, type Branch } from '../project/ProjectInstance.js';
import type { ProjectStore } from '../project-store.js';
import {
  createManagementApiRoutes,
  type ManagementApiRoutes,
} from './routes.js';
import { generateRef } from './utils.js';

const createBranchBodySchema = z.object({
  branch_name: z.string().min(1),
});

/**
 * Development branches. A branch is a fresh project database with the
 * parent's migration history replayed onto it (no data), ready immediately;
 * a migration that fails to replay (e.g. it depends on seeded, unmigrated
 * schema) leaves the branch in MIGRATIONS_FAILED, as on the platform.
 * Free-plan orgs get the platform's 402, and `/branching` reports the same rule.
 */
export function createBranchingRoutes(
  store: ProjectStore,
  org: Organization
): ManagementApiRoutes {
  const routes = createManagementApiRoutes();

  routes.get('/v1/projects/:ref/branching', (c) => {
    const { ref } = c.req.param();
    if (!store.get(ref)) return c.json({ message: 'Project not found' }, 404);
    return c.json({ available: hasBranching(org) });
  });

  routes.get('/v1/projects/:ref/branches', (c) => {
    const { ref } = c.req.param();
    const project = store.get(ref);
    if (!project) return c.json({ message: 'Project not found' }, 404);
    return c.json(project.branches);
  });

  routes.post('/v1/projects/:ref/branches', async (c) => {
    const { ref } = c.req.param();
    const project = store.get(ref);
    if (!project) return c.json({ message: 'Project not found' }, 404);
    if (!hasBranching(org)) {
      return c.json({ message: BRANCHING_REQUIRES_PAID_PLAN_MESSAGE }, 402);
    }

    const parsed = createBranchBodySchema.safeParse(
      await c.req.json().catch(() => undefined)
    );
    if (!parsed.success) {
      return c.json({ message: z.prettifyError(parsed.error) }, 400);
    }
    const name = parsed.data.branch_name;

    const branchDb = new ProjectInstance(
      generateRef(),
      name,
      project.organizationId
    );
    branchDb.parentRef = project.ref;
    await branchDb.init();
    store.set(branchDb.ref, branchDb);
    const status = await project.replayMigrationsOnto(branchDb).then(
      () => 'FUNCTIONS_DEPLOYED' as const,
      () => 'MIGRATIONS_FAILED' as const
    );

    const now = new Date().toISOString();
    const branch: Branch = {
      id: crypto.randomUUID(),
      name,
      project_ref: branchDb.ref,
      parent_project_ref: project.ref,
      is_default: false,
      persistent: false,
      status,
      created_at: now,
      updated_at: now,
      with_data: false,
    };
    project.branches.push(branch);
    return c.json(branch, 201);
  });

  return routes;
}
