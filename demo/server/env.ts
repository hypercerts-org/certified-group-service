import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
config({ path: join(__dirname, '..', '.env') })
