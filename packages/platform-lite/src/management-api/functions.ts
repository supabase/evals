import type { ProjectStore } from '../project-store.js'
import type { EdgeFunctionEntry } from '../project/ProjectInstance.js'
import { createManagementApiRoutes, type ManagementApiRoutes } from './routes.js'
import { z } from 'zod'

const deployMetadataSchema = z.looseObject({
  name: z.string().optional(),
  entrypoint_path: z.string().optional(),
  import_map_path: z.string().optional(),
  verify_jwt: z.boolean().optional(),
})

export function createFunctionsRoutes(store: ProjectStore): ManagementApiRoutes {
  const routes = createManagementApiRoutes()

  routes.get('/v1/projects/:ref/functions', (c) => {
    const { ref } = c.req.param()
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)
    const fns = Array.from(project.functions.values()).map(toPublicShape)
    return c.json(fns)
  })

  routes.get('/v1/projects/:ref/functions/:slug', (c) => {
    const { ref, slug } = c.req.param()
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)
    const fn = project.functions.get(slug)
    if (!fn) return c.json({ message: 'Function not found' }, 404)
    return c.json(toPublicShape(fn))
  })

  routes.get('/v1/projects/:ref/functions/:slug/body', (c) => {
    const { ref, slug } = c.req.param()
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)
    const fn = project.functions.get(slug)
    if (!fn) return c.json({ message: 'Function not found' }, 404)

    const boundary = 'supabox-lite-boundary'
    const parts: string[] = []
    for (const file of fn.files) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          `Content-Type: application/typescript\r\n\r\n` +
          file.content +
          '\r\n'
      )
    }
    const body = parts.join('') + `--${boundary}--\r\n`

    return new Response(body, {
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    })
  })

  // First-time deployment. `supabase functions deploy` lists the project's
  // functions, then POSTs to create one that doesn't exist yet (the V1 create
  // op): the eszip bundle is the request body and the metadata rides in query
  // params (?slug=&name=&verify_jwt=&ezbr_sha256=). We keep the metadata so the
  // deployment is listable/verifiable; the eszip body is opaque (platform-lite
  // executes JS source, not compiled bundles), so it is not retained for invoke.
  // Redeployment of an existing slug goes through PATCH below.
  routes.post('/v1/projects/:ref/functions', async (c) => {
    const { ref } = c.req.param()
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)

    const slug = c.req.query('slug')
    if (!slug) return c.json({ message: 'Missing slug query parameter' }, 400)
    // Drain the eszip body so the connection closes cleanly; it is not stored.
    await c.req.arrayBuffer().catch(() => undefined)

    const existing = project.functions.get(slug)
    const entry = buildFunctionEntry(slug, c.req.query(), existing)
    project.functions.set(slug, entry)
    return c.json(toPublicShape(entry), 201)
  })

  // Redeployment. Once a function exists, `supabase functions deploy` PATCHes
  // the new bundle to update it in place — the slug is in the path and the
  // metadata rides in query params (?entrypoint_path=&ezbr_sha256=&verify_jwt=,
  // without name/slug). 404 if the function was never created, so a redeploy
  // can't silently resurrect a deleted slug. (Verified against the live
  // Management API: create is POST /functions, update is PATCH /functions/:slug.)
  routes.app.patch('/v1/projects/:ref/functions/:slug', async (c) => {
    const { ref, slug } = c.req.param()
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)

    const existing = project.functions.get(slug)
    if (!existing) return c.json({ message: 'Function not found' }, 404)
    // Drain the eszip body so the connection closes cleanly; it is not stored.
    await c.req.arrayBuffer().catch(() => undefined)

    const entry = buildFunctionEntry(slug, c.req.query(), existing)
    project.functions.set(slug, entry)
    return c.json(toPublicShape(entry))
  })

  routes.post('/v1/projects/:ref/functions/deploy', async (c) => {
    const { ref } = c.req.param()
    const slug = c.req.query('slug')
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)
    if (!slug) return c.json({ message: 'Missing slug query parameter' }, 400)

    const parsed = await parseDeployBody(c.req.raw)
    if (!parsed.ok) return c.json({ message: parsed.error }, 400)
    const { metadata, files } = parsed
    if (files.length === 0) {
      return c.json(
        { message: `Entrypoint path does not exist - ${metadata.entrypoint_path ?? ''}` },
        400
      )
    }

    const existing = project.functions.get(slug)
    const now = Date.now()
    const entry: EdgeFunctionEntry = {
      id: existing?.id ?? crypto.randomUUID(),
      slug,
      name: metadata.name ?? slug,
      status: 'ACTIVE',
      version: (existing?.version ?? 0) + 1,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      verify_jwt: metadata.verify_jwt ?? true,
      entrypoint_path: metadata.entrypoint_path ? toFileUrl(metadata.entrypoint_path) : undefined,
      import_map_path: metadata.import_map_path ? toFileUrl(metadata.import_map_path) : undefined,
      files,
    }
    project.functions.set(slug, entry)

    return c.json(toPublicShape(entry), 201)
  })

  return routes
}

async function parseDeployBody(req: Request): Promise<{
  ok: true
  metadata: z.infer<typeof deployMetadataSchema>
  files: Array<{ name: string; content: string }>
} | {
  ok: false
  error: string
}> {
  let formData: FormData
  try {
    formData = await req.formData()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const metadataRaw = formData.get('metadata')
  let metadataJson: unknown = {}
  if (metadataRaw) {
    const raw = typeof metadataRaw === 'string' ? metadataRaw : await metadataRaw.text()
    try {
      metadataJson = JSON.parse(raw)
    } catch {
      return { ok: false, error: 'Invalid function metadata JSON' }
    }
  }

  const metadata = deployMetadataSchema.safeParse(metadataJson)
  if (!metadata.success) {
    return { ok: false, error: z.prettifyError(metadata.error) }
  }

  const files: Array<{ name: string; content: string }> = []

  for (const [key, value] of formData.entries()) {
    if (key === 'file' && value instanceof File && value.name) {
      files.push({ name: value.name, content: await value.text() })
    }
  }

  return { ok: true, metadata: metadata.data, files }
}

// Build the stored entry for a create (POST) or update (PUT) from the deploy
// query params, preserving identity/created_at across a redeployment and
// bumping the version. The eszip body is opaque, so files are carried over from
// the existing entry rather than extracted.
function buildFunctionEntry(
  slug: string,
  query: Record<string, string>,
  existing: EdgeFunctionEntry | undefined,
): EdgeFunctionEntry {
  const now = Date.now()
  const verifyJwt = query.verify_jwt
  return {
    id: existing?.id ?? crypto.randomUUID(),
    slug,
    name: query.name ?? existing?.name ?? slug,
    status: 'ACTIVE',
    version: (existing?.version ?? 0) + 1,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    verify_jwt: verifyJwt !== undefined ? verifyJwt === 'true' : (existing?.verify_jwt ?? true),
    entrypoint_path: query.entrypoint_path ?? existing?.entrypoint_path,
    import_map_path: existing?.import_map_path,
    files: existing?.files ?? [],
  }
}

function toFileUrl(path: string): string {
  return path.startsWith('file://') ? path : `file:///${path.replace(/^\/+/, '')}`
}

function toPublicShape(fn: EdgeFunctionEntry) {
  return {
    id: fn.id,
    slug: fn.slug,
    name: fn.name,
    status: fn.status,
    version: fn.version,
    created_at: fn.created_at,
    updated_at: fn.updated_at,
    verify_jwt: fn.verify_jwt,
    entrypoint_path: fn.entrypoint_path,
    import_map_path: fn.import_map_path,
  }
}
