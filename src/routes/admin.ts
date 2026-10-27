import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { forbidUnlessAdmin } from '../auth/plugin.js'
import { errorResponseSchema } from '../http/error-handler.js'
import { listAuditEvents, recordAuditEventSafe } from '../ops/audit-events.js'
import { countClinicalAndCatalog } from '../ops/admin-catalog.js'
import { probeMonitorServices } from '../ops/monitor-services.js'
import {
  emptySystemLogsResult,
  listSystemLogs,
  type SystemLogLevel,
} from '../ops/system-logs.js'
import { registerAdminCatalogRoutes } from './admin-catalog.js'

const systemLogLevels = new Set<SystemLogLevel>([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
])

function parsePositiveInt(value: unknown, fallback: number, max = 100): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : fallback
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: string,
): boolean {
  return forbidUnlessAdmin(request, reply, permission)
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (admin) => {
      admin.addHook('preHandler', async (request, reply) => {
        if (!forbidUnlessAdmin(request, reply)) return
      })

      admin.addHook('onResponse', async (request, reply) => {
        const dentist = request.dentist
        if (!dentist) return
        const route = request.routeOptions.url ?? request.url.split('?')[0] ?? request.url
        if (reply.statusCode === 403) {
          await recordAuditEventSafe(admin.database, {
            actorEmail: dentist.email,
            actorDentistId: dentist.id,
            action: 'admin.access.denied',
            target: `${request.method} ${route}`,
            result: 'denied',
            requestId: request.id,
          })
          return
        }
        if (reply.statusCode < 200 || reply.statusCode >= 300) return
        if (request.method !== 'GET') {
          await recordAuditEventSafe(admin.database, {
            actorEmail: dentist.email,
            actorDentistId: dentist.id,
            action: `admin.${request.method.toLowerCase()}`,
            target: route,
            result: 'success',
            requestId: request.id,
          })
        }
      })

      await registerAdminCatalogRoutes(admin)

      admin.get(
        '/dashboard/overview',
        {
          schema: {
            tags: ['admin'],
            operationId: 'getAdminDashboardOverview',
            summary: 'Indicadores operacionais agregados',
            security: [{ bearerAuth: [] }],
            response: {
              200: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'activeUsers',
                  'patients',
                  'procedures',
                  'installedImplants',
                  'implantPieces',
                  'manufacturers',
                  'models',
                  'sizes',
                  'references',
                  'syncJobs',
                  'recentFailures',
                  'integrationsOnline',
                  'integrationsTotal',
                  'generatedAt',
                ],
                properties: {
                  activeUsers: { type: 'integer' },
                  patients: { type: 'integer' },
                  procedures: { type: 'integer' },
                  installedImplants: { type: 'integer' },
                  implantPieces: { type: 'integer' },
                  manufacturers: { type: 'integer' },
                  models: { type: 'integer' },
                  sizes: { type: 'integer' },
                  references: { type: 'integer' },
                  syncJobs: { type: 'integer' },
                  recentFailures: { type: 'integer' },
                  integrationsOnline: { type: 'integer' },
                  integrationsTotal: { type: 'integer' },
                  generatedAt: { type: 'string', format: 'date-time' },
                },
              },
              401: errorResponseSchema,
              403: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          if (!requirePermission(request, reply, 'dashboard:read')) return
          const database = admin.database
          let activeUsers = 0
          let clinical = {
            patients: 0,
            procedures: 0,
            installedImplants: 0,
            implantPieces: 0,
            manufacturers: 0,
            models: 0,
            sizes: 0,
            references: 0,
          }
          if (database) {
            const rows = await database.query<{ count: string }>(
              'SELECT COUNT(*)::text AS count FROM dentists',
            )
            activeUsers = Number.parseInt(rows[0]?.count ?? '0', 10)
            clinical = await countClinicalAndCatalog(database)
          }
          const remote = await probeMonitorServices(admin.config.monitorServices)
          const providers = [
            Boolean(admin.config.workOs),
            Boolean(admin.objectStore),
            ...remote.map((item) => item.status === 'ok'),
            Boolean(admin.config.railway),
          ]
          return {
            activeUsers,
            ...clinical,
            syncJobs: 0,
            recentFailures: remote.filter((item) => item.status === 'down').length,
            integrationsOnline: providers.filter(Boolean).length,
            integrationsTotal: providers.length,
            generatedAt: admin.clock().toISOString(),
          }
        },
      )

      admin.get(
        '/dashboard/health',
        {
          schema: {
            tags: ['admin'],
            operationId: 'listAdminServiceHealth',
            summary: 'Saúde operacional agregada',
            security: [{ bearerAuth: [] }],
            response: {
              200: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'name', 'status', 'checkedAt'],
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    status: { type: 'string', enum: ['ok', 'degraded', 'down', 'unknown'] },
                    detail: { type: 'string' },
                    checkedAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
              401: errorResponseSchema,
              403: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          if (!requirePermission(request, reply, 'dashboard:read')) return
          const checkedAt = admin.clock().toISOString()
          const databaseOk = admin.database ? await admin.database.ping() : false
          const remote = await probeMonitorServices(admin.config.monitorServices)
          const railway = admin.config.railway
          const services = [
            {
              id: 'api',
              name: 'API clínica',
              status: 'ok' as const,
              detail: railway?.service
                ? `Processo respondendo (${railway.service})`
                : 'Processo respondendo',
              checkedAt,
            },
            {
              id: 'postgres',
              name: 'PostgreSQL',
              status: databaseOk ? ('ok' as const) : ('down' as const),
              detail: databaseOk ? 'Ping ok' : 'Sem conexão',
              checkedAt,
            },
            ...remote.map((item) => ({
              id: item.id,
              name: item.name,
              status: item.status,
              detail: item.detail,
              checkedAt,
            })),
          ]
          if (railway) {
            const parts = [
              railway.environment ? `env ${railway.environment}` : null,
              railway.service ? `svc ${railway.service}` : null,
              railway.publicDomain ? railway.publicDomain : null,
            ].filter((part): part is string => part !== null)
            services.push({
              id: 'railway-runtime',
              name: 'Railway (runtime)',
              status: 'ok' as const,
              detail: parts.length > 0 ? parts.join(' · ') : 'Variáveis Railway presentes',
              checkedAt,
            })
          }
          return services
        },
      )

      admin.get(
        '/users',
        {
          schema: {
            tags: ['admin'],
            operationId: 'listAdminUsers',
            summary: 'Lista usuários (dentistas) com paginação',
            security: [{ bearerAuth: [] }],
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                q: { type: 'string' },
                status: { type: 'string' },
                page: { type: 'string' },
                pageSize: { type: 'string' },
              },
            },
            response: {
              200: {
                type: 'object',
                additionalProperties: false,
                required: ['items', 'page', 'pageSize', 'total'],
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: [
                        'id',
                        'name',
                        'email',
                        'status',
                        'role',
                        'permissions',
                        'patients',
                        'procedures',
                        'pieces',
                        'createdAt',
                      ],
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        email: { type: 'string' },
                        cro: { type: ['string', 'null'] },
                        croUf: { type: ['string', 'null'] },
                        status: { type: 'string', enum: ['active', 'invited', 'inactive'] },
                        role: { type: 'string' },
                        permissions: { type: 'array', items: { type: 'string' } },
                        patients: { type: 'integer' },
                        procedures: { type: 'integer' },
                        pieces: { type: 'integer' },
                        createdAt: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                  page: { type: 'integer' },
                  pageSize: { type: 'integer' },
                  total: { type: 'integer' },
                },
              },
              401: errorResponseSchema,
              403: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          if (!requirePermission(request, reply, 'users:read')) return
          const query = request.query as {
            q?: string
            page?: string
            pageSize?: string
          }
          const page = parsePositiveInt(query.page, 1)
          const pageSize = parsePositiveInt(query.pageSize, 20, 100)
          const offset = (page - 1) * pageSize
          const database = admin.database
          if (!database) {
            return { items: [], page, pageSize, total: 0 }
          }

          const search = query.q?.trim()
          const params: unknown[] = []
          let where = ''
          if (search) {
            params.push(`%${search}%`)
            where =
              `WHERE d.name ILIKE $1 OR d.email ILIKE $1 OR COALESCE(d.cro, '') ILIKE $1`
          }

          const totalRows = await database.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM dentists d ${where}`,
            params,
          )
          const total = Number.parseInt(totalRows[0]?.count ?? '0', 10)
          const listParams = [...params, pageSize, offset]
          const limitIdx = params.length + 1
          const offsetIdx = params.length + 2
          const rows = await database.query<{
            id: string
            name: string
            email: string
            cro: string | null
            cro_uf: string | null
            created_at: Date
            patients: string
            procedures: string
            pieces: string
          }>(
            `SELECT d.id, d.name, d.email, d.cro, d.cro_uf, d.created_at,
                    COALESCE(p.cnt, 0)::text AS patients,
                    COALESCE(pr.cnt, 0)::text AS procedures,
                    COALESCE(ip.cnt, 0)::text AS pieces
             FROM dentists d
             LEFT JOIN (
               SELECT dentist_id, COUNT(*)::bigint AS cnt
               FROM patients
               GROUP BY dentist_id
             ) p ON p.dentist_id = d.id
             LEFT JOIN (
               SELECT dentist_id, COUNT(*)::bigint AS cnt
               FROM procedures
               WHERE deleted_at IS NULL
               GROUP BY dentist_id
             ) pr ON pr.dentist_id = d.id
             LEFT JOIN (
               SELECT dentist_id, COUNT(*)::bigint AS cnt
               FROM implant_pieces
               GROUP BY dentist_id
             ) ip ON ip.dentist_id = d.id
             ${where}
             ORDER BY d.created_at DESC
             LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
            listParams,
          )

          await recordAuditEventSafe(database, {
            actorEmail: request.dentist?.email ?? 'unknown',
            actorDentistId: request.dentist?.id ?? null,
            action: 'admin.users.list',
            target: search ? `q=${search}` : null,
            result: 'success',
            requestId: request.id,
          })

          return {
            items: rows.map((row) => ({
              id: row.id,
              name: row.name,
              email: row.email,
              cro: row.cro,
              croUf: row.cro_uf,
              status: 'active' as const,
              role: 'member',
              permissions: [] as string[],
              patients: Number.parseInt(row.patients, 10),
              procedures: Number.parseInt(row.procedures, 10),
              pieces: Number.parseInt(row.pieces, 10),
              createdAt: row.created_at.toISOString(),
            })),
            page,
            pageSize,
            total,
          }
        },
      )

      admin.get(
        '/integrations',
        {
          schema: {
            tags: ['admin'],
            operationId: 'listAdminIntegrations',
            summary: 'Status de integrações (sem segredos)',
            security: [{ bearerAuth: [] }],
            response: {
              200: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'name', 'kind', 'status'],
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    kind: {
                      type: 'string',
                      enum: ['email', 'push', 'storage', 'catalog', 'other'],
                    },
                    status: { type: 'string', enum: ['ok', 'error', 'unknown'] },
                    lastRunAt: { type: ['string', 'null'], format: 'date-time' },
                    lastError: { type: ['string', 'null'] },
                  },
                },
              },
              401: errorResponseSchema,
              403: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          if (!requirePermission(request, reply, 'integrations:manage')) return
          const storageOk = Boolean(admin.objectStore)
          const remote = await probeMonitorServices(admin.config.monitorServices)
          const checkedAt = admin.clock().toISOString()
          const items = [
            {
              id: 'workos',
              name: 'WorkOS AuthKit',
              kind: 'other' as const,
              status: admin.config.workOs ? ('ok' as const) : ('unknown' as const),
              lastRunAt: null,
              lastError: null,
            },
            {
              id: 's3',
              name: 'Armazenamento de objetos',
              kind: 'storage' as const,
              status: storageOk ? ('ok' as const) : ('unknown' as const),
              lastRunAt: null,
              lastError: null,
            },
            ...remote.map((item) => ({
              id: item.id,
              name: item.name,
              kind: 'other' as const,
              status:
                item.status === 'ok'
                  ? ('ok' as const)
                  : item.status === 'unknown'
                    ? ('unknown' as const)
                    : ('error' as const),
              lastRunAt: checkedAt,
              lastError: item.status === 'ok' ? null : item.detail,
            })),
          ]
          if (admin.config.railway) {
            const railway = admin.config.railway
            const label = [railway.service, railway.environment].filter(Boolean).join(' / ')
            items.push({
              id: 'railway-runtime',
              name: label ? `Railway (${label})` : 'Railway',
              kind: 'other' as const,
              status: 'ok' as const,
              lastRunAt: checkedAt,
              lastError: null,
            })
          }
          return items
        },
      )

      admin.get(
        '/catalog/jobs',
        {
          schema: {
            tags: ['admin'],
            operationId: 'listAdminCatalogJobs',
            summary: 'Jobs de sincronização de catálogo',
            security: [{ bearerAuth: [] }],
            response: {
              200: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'label', 'status'],
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    status: {
                      type: 'string',
                      enum: ['queued', 'running', 'succeeded', 'failed'],
                    },
                    startedAt: { type: ['string', 'null'], format: 'date-time' },
                    finishedAt: { type: ['string', 'null'], format: 'date-time' },
                  },
                },
              },
              401: errorResponseSchema,
              403: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          if (!requirePermission(request, reply, 'catalogs:manage')) return
          return []
        },
      )

      admin.get(
        '/settings',
        {
          schema: {
            tags: ['admin'],
            operationId: 'listAdminSettings',
            summary: 'Parâmetros globais não sensíveis',
            security: [{ bearerAuth: [] }],
            response: {
              200: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['key', 'label', 'value', 'sensitive', 'updatedAt'],
                  properties: {
                    key: { type: 'string' },
                    label: { type: 'string' },
                    value: { type: 'string' },
                    sensitive: { type: 'boolean' },
                    updatedAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
              401: errorResponseSchema,
              403: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          if (!requirePermission(request, reply, 'settings:manage')) return
          const updatedAt = admin.clock().toISOString()
          return [
            {
              key: 'app_env',
              label: 'Ambiente',
              value: admin.config.appEnv,
              sensitive: false,
              updatedAt,
            },
            {
              key: 'openapi_enabled',
              label: 'OpenAPI',
              value: String(admin.config.openApiEnabled),
              sensitive: false,
              updatedAt,
            },
          ]
        },
      )

      admin.get(
        '/audit-events',
        {
          schema: {
            tags: ['admin'],
            operationId: 'listAdminAuditEvents',
            summary: 'Eventos administrativos (sem dados clínicos)',
            security: [{ bearerAuth: [] }],
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                page: { type: 'string' },
                pageSize: { type: 'string' },
                action: { type: 'string' },
              },
            },
            response: {
              200: {
                type: 'object',
                additionalProperties: false,
                required: ['items', 'page', 'pageSize', 'total'],
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['id', 'actorEmail', 'action', 'result', 'createdAt'],
                      properties: {
                        id: { type: 'string' },
                        actorEmail: { type: 'string' },
                        action: { type: 'string' },
                        target: { type: ['string', 'null'] },
                        result: { type: 'string', enum: ['success', 'denied', 'failure'] },
                        justification: { type: ['string', 'null'] },
                        createdAt: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                  page: { type: 'integer' },
                  pageSize: { type: 'integer' },
                  total: { type: 'integer' },
                },
              },
              401: errorResponseSchema,
              403: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          if (!requirePermission(request, reply, 'audit:read')) return
          const query = request.query as { page?: string; pageSize?: string; action?: string }
          const page = parsePositiveInt(query.page, 1)
          const pageSize = parsePositiveInt(query.pageSize, 20, 100)
          const database = admin.database
          if (!database) {
            return { items: [], page, pageSize, total: 0 }
          }
          return listAuditEvents(database, {
            page,
            pageSize,
            ...(query.action ? { action: query.action } : {}),
          })
        },
      )

      admin.get(
        '/logs',
        {
          schema: {
            tags: ['admin'],
            operationId: 'listAdminSystemLogs',
            summary: 'Logs operacionais persistidos (warn+ e erros)',
            security: [{ bearerAuth: [] }],
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                page: { type: 'string' },
                pageSize: { type: 'string' },
                level: { type: 'string' },
                q: { type: 'string' },
              },
            },
            response: {
              200: {
                type: 'object',
                additionalProperties: false,
                required: ['items', 'page', 'pageSize', 'total', 'summary'],
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['id', 'level', 'message', 'source', 'createdAt'],
                      properties: {
                        id: { type: 'string' },
                        level: {
                          type: 'string',
                          enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
                        },
                        message: { type: 'string' },
                        source: { type: 'string' },
                        requestId: { type: ['string', 'null'] },
                        context: { type: 'object', additionalProperties: true },
                        createdAt: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                  page: { type: 'integer' },
                  pageSize: { type: 'integer' },
                  total: { type: 'integer' },
                  summary: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                      'windowHours',
                      'total',
                      'errors',
                      'warnings',
                      'info',
                      'lastAt',
                    ],
                    properties: {
                      windowHours: { type: 'integer' },
                      total: { type: 'integer' },
                      errors: { type: 'integer' },
                      warnings: { type: 'integer' },
                      info: { type: 'integer' },
                      lastAt: { type: ['string', 'null'], format: 'date-time' },
                    },
                  },
                },
              },
              401: errorResponseSchema,
              403: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          if (!requirePermission(request, reply, 'audit:read')) return
          const query = request.query as {
            page?: string
            pageSize?: string
            level?: string
            q?: string
          }
          const page = parsePositiveInt(query.page, 1)
          const pageSize = parsePositiveInt(query.pageSize, 50, 100)
          const database = admin.database
          if (!database) {
            return emptySystemLogsResult(page, pageSize)
          }
          const level =
            query.level && systemLogLevels.has(query.level as SystemLogLevel)
              ? (query.level as SystemLogLevel)
              : undefined
          return listSystemLogs(database, {
            page,
            pageSize,
            ...(level ? { level } : {}),
            ...(query.q ? { q: query.q } : {}),
          })
        },
      )
    },
    { prefix: '/v1/admin' },
  )
}
