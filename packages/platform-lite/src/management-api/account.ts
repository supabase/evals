import { DEFAULT_REGION, ProjectInstance } from '../project/ProjectInstance.js';
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

export function createAccountRoutes(
  store: ProjectStore,
  unavailableRegions: string[] = [],
  rerouteRegions: Record<string, string> = {}
): ManagementApiRoutes {
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
    const requestedRegion = body.region ?? DEFAULT_REGION;
    if (unavailableRegions.includes(requestedRegion)) {
      return c.json(
        {
          message: `The ${requestedRegion} region is unavailable at the moment. Visit https://status.supabase.com for further updates.`,
        },
        503
      );
    }
    const region = rerouteRegions[requestedRegion] ?? requestedRegion;
    const ref = generateRef();
    const name = body.name ?? ref;
    const orgSlug = body.organization_slug ?? DEFAULT_ORG.slug;
    const instance = new ProjectInstance(ref, name, orgSlug, region);
    await instance.init();
    store.set(ref, instance);
    if (region === requestedRegion) {
      return c.json(instance.toProjectDetails(), 201);
    }
    return c.json(
      {
        ...instance.toProjectDetails(),
        message: `WARNING: the ${requestedRegion} region is currently unavailable. Your project was created in ${region} instead.`,
      },
      201
    );
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
