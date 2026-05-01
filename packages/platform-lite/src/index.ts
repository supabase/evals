import { createApp } from './app.js'
import { listen } from './listen.js'

const port = Number(process.env.PORT ?? 3001)
const accessToken = process.env.ACCESS_TOKEN
const seedDir = process.env.SEED_DIR ?? './seed'

const app = await createApp({ accessToken, seedDir })
await listen(app, { port })
