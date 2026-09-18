import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { DEFAULT_REGION, ProjectInstance } from '../project/ProjectInstance.js';
import type { ProjectStore } from '../project-store.js';
import type { CreateProjectOverride } from '../types.js';
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
  createProject?: CreateProjectOverride
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
    const region = createProject?.region ?? requestedRegion;
    const overrideBody = fillRegions(
      createProject?.body,
      requestedRegion,
      region
    );
    if (createProject?.status !== undefined && createProject.status >= 400) {
      return c.json(
        overrideBody ?? {},
        createProject.status as ContentfulStatusCode
      );
    }
    const ref = generateRef();
    const name = body.name ?? ref;
    const orgSlug = body.organization_slug ?? DEFAULT_ORG.slug;
    const instance = new ProjectInstance(ref, name, orgSlug, region);
    await instance.init();
    store.set(ref, instance);
    return c.json({ ...instance.toProjectDetails(), ...overrideBody }, 201);
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

/** Fills `{requested_region}` and `{region}` placeholders in an override body. */
function fillRegions(
  body: Record<string, unknown> | undefined,
  requestedRegion: string,
  region: string
): Record<string, unknown> | undefined {
  if (!body) return undefined;
  return JSON.parse(
    JSON.stringify(body)
      .replace(/\{requested_region\}/g, requestedRegion)
      .replace(/\{region\}/g, region)
  ) as Record<string, unknown>;
}

function generateRef(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}
