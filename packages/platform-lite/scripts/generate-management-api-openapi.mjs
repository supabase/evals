import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript'

const UPSTREAM_OPENAPI_URL =
  process.env.MANAGEMENT_API_OPENAPI_URL ?? 'https://api.supabase.com/api/v1-json'

const HTTP_METHODS = new Set([
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
])

const ROUTE_MODULE_ORDER = [
  'account.ts',
  'database.ts',
  'functions.ts',
  'debugging.ts',
  'development.ts',
]

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const managementApiDir = join(packageDir, 'src', 'management-api')
const outputPath = join(managementApiDir, 'openapi.json')
const typesOutputPath = join(managementApiDir, 'types.ts')

const spec = await loadOpenApiSpec()
const routes = await loadSupportedRoutes()
const filteredPaths = filterPaths(spec.paths, routes)

if (Object.keys(filteredPaths).length === 0) {
  throw new Error('Filtered OpenAPI spec is empty. Check the route matcher before writing output.')
}

await writeFile(outputPath, `${JSON.stringify({ ...spec, paths: filteredPaths }, null, 2)}\n`)
await writeFile(typesOutputPath, `${COMMENT_HEADER}${astToString(await openapiTS(spec))}`)

console.log(
  `Generated full Management API contract types at ${relative(packageDir, typesOutputPath)}`,
)
console.log(
  `Filtered advertised OpenAPI spec from ${Object.keys(spec.paths).length} upstream paths to ${
    Object.keys(filteredPaths).length
  } platform-lite paths at ${relative(packageDir, outputPath)}`,
)

async function loadOpenApiSpec() {
  const inputPath = process.env.MANAGEMENT_API_OPENAPI_INPUT
  const raw = inputPath
    ? await readFile(resolve(packageDir, inputPath), 'utf8')
    : await fetchOpenApiSpec()

  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || !parsed.paths || typeof parsed.paths !== 'object') {
    throw new Error('Management API OpenAPI spec does not contain a paths object')
  }

  return parsed
}

async function fetchOpenApiSpec() {
  const response = await fetch(UPSTREAM_OPENAPI_URL)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${UPSTREAM_OPENAPI_URL}: ${response.status} ${response.statusText}`)
  }
  return response.text()
}

async function loadSupportedRoutes() {
  const files = await orderedRouteFiles()
  const routeDefinitions = []

  for (const file of files) {
    const absolutePath = join(managementApiDir, file)
    const source = await readFile(absolutePath, 'utf8')
    const routePattern = /\broutes\.(get|post)\(\s*(['"`])([^'"`]+)\2/g
    let match

    while ((match = routePattern.exec(source))) {
      routeDefinitions.push({
        file,
        line: source.slice(0, match.index).split('\n').length,
        method: match[1],
        path: match[3],
      })
    }
  }

  return routeDefinitions
}

async function orderedRouteFiles() {
  const files = (await readdir(managementApiDir))
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => !['openapi.ts', 'routes.ts', 'types.ts'].includes(file))

  return [
    ...ROUTE_MODULE_ORDER.filter((file) => files.includes(file)),
    ...files.filter((file) => !ROUTE_MODULE_ORDER.includes(file)).sort(),
  ]
}

function filterPaths(upstreamPaths, routes) {
  const filtered = {}

  for (const route of routes) {
    const match = findMatchingOperation(upstreamPaths, route)
    if (!match) {
      console.warn(
        `Skipping ${route.method.toUpperCase()} ${route.path}: no upstream OpenAPI operation (${relative(
          packageDir,
          join(managementApiDir, route.file),
        )}:${route.line})`,
      )
      continue
    }

    const existingPath = filtered[match.path] ?? {}
    for (const [key, value] of Object.entries(match.pathItem)) {
      if (!HTTP_METHODS.has(key)) {
        existingPath[key] = value
      }
    }
    existingPath[route.method] = match.pathItem[route.method]
    filtered[match.path] = existingPath
  }

  return filtered
}

function findMatchingOperation(upstreamPaths, route) {
  for (const [path, pathItem] of Object.entries(upstreamPaths)) {
    if (!pathItem || typeof pathItem !== 'object') {
      continue
    }
    if (route.method in pathItem && pathsMatch(route.path, path)) {
      return { path, pathItem }
    }
  }
}

function pathsMatch(honoPath, openApiPath) {
  const honoSegments = pathSegments(honoPath)
  const openApiSegments = pathSegments(openApiPath)
  if (honoSegments.length !== openApiSegments.length) {
    return false
  }

  return honoSegments.every((segment, index) => {
    const openApiSegment = openApiSegments[index]
    if (segment.startsWith(':') && isOpenApiParameter(openApiSegment)) {
      return true
    }
    return segment === openApiSegment
  })
}

function pathSegments(path) {
  return path.split('/').filter(Boolean)
}

function isOpenApiParameter(segment) {
  return segment.startsWith('{') && segment.endsWith('}')
}
