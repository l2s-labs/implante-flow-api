import { Writable } from 'node:stream'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify, { LogController, type FastifyInstance } from 'fastify'
import type { Authenticate } from './auth/plugin.js'
import { registerAuth } from './auth/plugin.js'
import { type AppConfig, loadConfig } from './config.js'
import type { Database } from './db/database.js'
import type { DocumentSigner } from './certificates/issue.js'
import type { ObjectStore } from './files/object-store.js'
import { registerErrorHandler } from './http/error-handler.js'
import { requestIdFrom } from './http/request-id.js'
import { createDbLogTransport } from './ops/db-log-transport.js'
import { registerCertificateRoutes } from './routes/certificates.js'
import { registerCatalogRoutes } from './routes/catalog.js'
import { registerClinicRoutes } from './routes/clinic.js'
import { registerPhotoRoutes } from './routes/photos.js'
import { registerReportRoutes } from './routes/reports.js'
import { registerPracticeRoutes } from './routes/practice.js'
import { registerHealthRoutes, type ReadinessCheck } from './routes/health.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerV1Routes } from './routes/v1.js'
import { registerCepRoutes } from './routes/ceps.js'
import { registerProsthesisFollowupRoutes } from './routes/prosthesis-followups.js'
import type { ViaCepClient } from './cep/lookup.js'
import './types.js'

export type BuildAppOptions = {
  config?: AppConfig
  readinessCheck?: ReadinessCheck
  authenticate?: Authenticate
  database?: Database | null
  objectStore?: ObjectStore | null
  documentSigner?: DocumentSigner
  clock?: () => Date
  viaCepClient?: ViaCepClient | null
}

function createStdoutAndDbLogStream(database: Database): Writable {
  const dbTransport = createDbLogTransport(database)
  return new Writable({
    write(chunk, encoding, callback) {
      process.stdout.write(chunk)
      if (!dbTransport.write(chunk, encoding)) {
        dbTransport.once('drain', callback)
        return
      }
      callback()
    },
  })
}

function buildLoggerOptions(config: AppConfig, database: Database | null) {
  const redact = {
    paths: ['req.headers.authorization', 'req.headers.cookie'],
    censor: '[redacted]',
  }
  if (!database || config.logLevel === 'silent') {
    return { level: config.logLevel, redact }
  }
  return {
    level: config.logLevel,
    redact,
    stream: createStdoutAndDbLogStream(database),
  }
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig()
  const readinessCheck = options.readinessCheck ?? (async () => true)
  const database = options.database ?? null

  const app = Fastify({
    logger: buildLoggerOptions(config, database),
    genReqId: (request) => requestIdFrom(request.headers),
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    ajv: {
      customOptions: {
        removeAdditional: false,
        allErrors: true,
      },
    },
  })

  app.decorate('config', config)
  app.decorate('database', database)
  app.decorate('objectStore', options.objectStore ?? null)
  app.decorate('clock', options.clock ?? (() => new Date()))
  app.decorate('viaCepClient', options.viaCepClient ?? null)

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  registerErrorHandler(app)

  await app.register(helmet, config.openApiEnabled ? { contentSecurityPolicy: false } : {})

  if (config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: [...config.corsOrigins],
      credentials: false,
    })
  }

  if (config.openApiEnabled) {
    await app.register(swagger, {
      transform: ({ schema, url }) => ({
        schema,
        url: url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url,
      }),
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'Implante Flow API',
          description:
            'API clínica do prontuário Implante Flow. Rotas de negócio ficam em /v1. Probes /health e /ready são públicos e não versionados.',
          version: config.serviceVersion,
        },
        servers: [{ url: '/' }],
        tags: [
          { name: 'operacao', description: 'Contrato de execução e identidade da API.' },
          { name: 'prontuario', description: 'Pacientes, procedimentos, consultas e retornos.' },
          { name: 'catalogo', description: 'Fabricantes e modelos somente leitura.' },
          {
            name: 'admin',
            description: 'Operações administrativas do painel interno (RBAC).',
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
      },
    })
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      staticCSP: true,
    })
  }

  registerHealthRoutes(app, readinessCheck)
  registerAuth(app, options.authenticate)
  await registerV1Routes(app)
  await registerAdminRoutes(app)
  await registerClinicRoutes(app)
  await registerCatalogRoutes(app)
  await registerPracticeRoutes(app)
  await registerCepRoutes(app)
  await registerProsthesisFollowupRoutes(app)
  await registerPhotoRoutes(app)
  await registerCertificateRoutes(app, options.documentSigner)
  await registerReportRoutes(app)

  return app
}
