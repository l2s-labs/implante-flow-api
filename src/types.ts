import type { AuthenticatedDentist } from './auth/dentist.js'
import type { AppConfig } from './config.js'
import type { Database } from './db/database.js'
import type { ObjectStore } from './files/object-store.js'
import type { ViaCepClient } from './cep/lookup.js'

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig
    database: Database | null
    objectStore: ObjectStore | null
    clock: () => Date
    viaCepClient: ViaCepClient | null
  }

  interface FastifyRequest {
    dentist: AuthenticatedDentist | null
  }
}
