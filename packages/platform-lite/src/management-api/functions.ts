import type { ProjectStore } from '../project-store.js'
import type { EdgeFunctionEntry } from '../project/ProjectInstance.js'
import { createManagementApiRoutes, type ManagementApiRoutes } from './routes.js'

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
  }, {
    openApiPath: '/v1/projects/{ref}/functions/{function_slug}',
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
  }, {
    openApiPath: '/v1/projects/{ref}/functions/{function_slug}/body',
  })

  routes.post('/v1/projects/:ref/functions/deploy', async (c) => {
    const { ref } = c.req.param()
    const slug = c.req.query('slug')
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)
    if (!slug) return c.json({ message: 'Missing slug query parameter' }, 400)

    const formData = await c.req.formData()
    const metadataRaw = formData.get('metadata')
    const metadata = metadataRaw
      ? JSON.parse(typeof metadataRaw === 'string' ? metadataRaw : await (metadataRaw as File).text())
      : {}

    const files: Array<{ name: string; content: string }> = []
    for (const [key, value] of formData.entries()) {
      if (key === 'file' && value instanceof File && value.name) {
        files.push({ name: value.name, content: await value.text() })
      }
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
