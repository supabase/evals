import { ProjectInstance } from '../project/ProjectInstance.js';
import type { ProjectStore } from '../project-store.js';
import type { Organization } from '../organization.js';
import {
  createManagementApiRoutes,
  type ManagementApiRoutes,
} from './routes.js';
import { generateRef } from './utils.js';

export function createAccountRoutes(
  store: ProjectStore,
  org: Organization
): ManagementApiRoutes {
  const routes = createManagementApiRoutes();

  // Like the real list endpoint, no plan: callers need get_organization for it.
  routes.get('/v1/organizations', (c) => {
    return c.json([{ id: org.id, slug: org.slug, name: org.name }]);
  });

  routes.get('/v1/organizations/:slug', (c) => {
    const { slug } = c.req.param();
    if (slug !== org.slug) {
      return c.json({ message: 'Organization not found' }, 404);
    }
    return c.json(org);
  });

  // Branch databases are projects internally but aren't listed as projects.
  routes.get('/v1/projects', (c) => {
    const projects = Array.from(store.values())
      .filter((p) => !p.parentRef)
      .map((p) => p.toProjectDetails());
    return c.json(projects);
  });

  routes.get('/v1/projects/:ref', (c) => {
    const { ref } = c.req.param();
    const project = store.get(ref);
    if (!project) return c.json({ message: 'Project not found' }, 404);
    return c.json(project.toProjectDetails());
  });

  routes.post('/v1/projects', async (c) => {
    const body = await c.req.json<{
      name?: string;
      region?: string;
      organization_slug?: string;
      db_pass?: string;
    }>();
    const ref = generateRef();
    const name = body.name ?? ref;
    const orgSlug = body.organization_slug ?? org.slug;
    const instance = new ProjectInstance(ref, name, orgSlug);
    await instance.init();
    store.set(ref, instance);
    return c.json(instance.toProjectDetails(), 201);
  });

  routes.post('/v1/projects/:ref/pause', (c) => {
    const { ref } = c.req.param();
    const project = store.get(ref);
    if (!project) return c.json({ message: 'Project not found' }, 404);
    project.status = 'INACTIVE';
    return c.json({ message: 'Project paused' });
  });

  routes.post('/v1/projects/:ref/restore', (c) => {
    const { ref } = c.req.param();
    const project = store.get(ref);
    if (!project) return c.json({ message: 'Project not found' }, 404);
    project.status = 'ACTIVE_HEALTHY';
    return c.json({ message: 'Project restored' });
  });

  return routes;
}
