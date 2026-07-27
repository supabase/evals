import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProjectStore } from '../project-store.js';
import {
  createManagementApiRoutes,
  type ManagementApiRoutes,
} from './routes.js';

const createSecretsSchema = z.array(
  z.object({
    name: z.string().min(1),
    value: z.string(),
  })
);

const deleteSecretsSchema = z.array(z.string().min(1));

// The real Management API never returns secret plaintext — `value` is the
// SHA-256 digest of the secret. We mirror that so `supabase secrets list`
// behaves the same; the plaintext is kept server-side for env injection.
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createSecretsRoutes(store: ProjectStore): ManagementApiRoutes {
  const routes = createManagementApiRoutes();

  routes.get('/v1/projects/:ref/secrets', (c) => {
    const { ref } = c.req.param();
    const project = store.get(ref);
    if (!project) return c.json({ message: 'Project not found' }, 404);
    const secrets = Array.from(project.secrets.entries()).map(
      ([name, value]) => ({
        name,
        value: digest(value),
        updated_at: project.createdAt,
      })
    );
    return c.json(secrets);
  });

  routes.post('/v1/projects/:ref/secrets', async (c) => {
    const { ref } = c.req.param();
    const project = store.get(ref);
    if (!project) return c.json({ message: 'Project not found' }, 404);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: 'Invalid JSON body' }, 400);
    }
    const parsed = createSecretsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ message: z.prettifyError(parsed.error) }, 400);
    }
    // Mirror the API guard: reserved SUPABASE_ prefix is rejected.
    const reserved = parsed.data.find((s) => s.name.startsWith('SUPABASE_'));
    if (reserved) {
      return c.json(
        {
          message: `Secret name must not start with the SUPABASE_ prefix: ${reserved.name}`,
        },
        400
      );
    }
    for (const { name, value } of parsed.data) {
      project.secrets.set(name, value);
    }
    return c.body(null, 201);
  });

  routes.app.delete('/v1/projects/:ref/secrets', async (c) => {
    const { ref } = c.req.param();
    const project = store.get(ref);
    if (!project) return c.json({ message: 'Project not found' }, 404);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: 'Invalid JSON body' }, 400);
    }
    const parsed = deleteSecretsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ message: z.prettifyError(parsed.error) }, 400);
    }
    for (const name of parsed.data) {
      project.secrets.delete(name);
    }
    return c.json({ message: 'ok' });
  });

  return routes;
}
