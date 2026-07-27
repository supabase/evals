import { ProjectInstance } from '../project/ProjectInstance.js';
import type { ProjectStore } from '../project-store.js';
import {
  createManagementApiRoutes,
  type ManagementApiRoutes,
} from './routes.js';

const DEFAULT_ORG = {
  id: 'default-org',
  slug: 'default-org',
  name: 'Default Organization',
  plan: 'free',
  allowed_release_channels: ['ga'],
  opt_in_tags: [],
};

export function createAccountRoutes(store: ProjectStore): ManagementApiRoutes {
  const routes = createManagementApiRoutes();

  routes.get('/v1/organizations', (c) => {
    return c.json([DEFAULT_ORG]);
  });

  routes.get('/v1/organizations/:slug', (c) => {
    const { slug } = c.req.param();
    if (slug !== DEFAULT_ORG.slug) {
      return c.json({ message: 'Organization not found' }, 404);
    }
    return c.json(DEFAULT_ORG);
  });

  routes.get('/v1/projects', (c) => {
    const projects = Array.from(store.values()).map((p) =>
      p.toProjectDetails()
    );
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
    const orgSlug = body.organization_slug ?? DEFAULT_ORG.slug;
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

function generateRef(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}
