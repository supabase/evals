import { createPlatform } from './app.js'

const DEFAULT_PORT = 7070

const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT
const accessToken = process.env.ACCESS_TOKEN
const seedDir = process.env.SEED_DIR ?? './seed'

const platform = await createPlatform({ accessToken, seedDir })
const server = await platform.listen({ port })
console.log(`platform-lite listening at ${server.url}`)
