import { createPlatform } from './app.js'

const port = process.env.PORT ? Number(process.env.PORT) : undefined
const accessToken = process.env.ACCESS_TOKEN
const seedDir = process.env.SEED_DIR ?? './seed'

const platform = await createPlatform({ accessToken, seedDir })
await platform.listen({ port })
