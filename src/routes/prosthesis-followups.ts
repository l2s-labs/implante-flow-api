import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  listProsthesisFollowups,
  patchProsthesisFollowupStatus,
  upsertProsthesisFollowup,
} from '../clinic/prosthesis-followups.js'
import type { Database } from '../db/database.js'
import { errorResponseSchema } from '../http/error-handler.js'

const notFound = (request: FastifyRequest) => ({
  error: {
    code: 'not_found',
    message: 'Procedimento não encontrado.',
    requestId: request.id,
  },
})

function databaseOf(request: FastifyRequest, reply: FastifyReply): Database | undefined {
  if (request.server.database && request.dentist) return request.server.database
  void reply.status(503).send({
    error: { code: 'unavailable', message: 'Prontuário indisponível.', requestId: request.id },
  })
  return undefined
}

const followupSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'procedureId', 'phase', 'status', 'statusAt', 'events'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    procedureId: { type: 'string', format: 'uuid' },
    phase: { type: 'string', enum: ['provisional', 'definitive'] },
    status: {
      type: ['string', 'null'],
      enum: ['molded', 'sentToLab', 'returnedFromLab', 'installed', null],
    },
    statusAt: { type: ['string', 'null'] },
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'statusAt', 'createdAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          status: {
            type: 'string',
            enum: ['molded', 'sentToLab', 'returnedFromLab', 'installed'],
          },
          statusAt: { type: ['string', 'null'] },
          createdAt: { type: 'string' },
        },
      },
    },
  },
} as const

const procedureParams = {
  type: 'object',
  additionalProperties: false,
  required: ['procedureId'],
  properties: { procedureId: { type: 'string', format: 'uuid' } },
} as const

const procedurePhaseParams = {
  type: 'object',
  additionalProperties: false,
  required: ['procedureId', 'phase'],
  properties: {
    procedureId: { type: 'string', format: 'uuid' },
    phase: { type: 'string', enum: ['provisional', 'definitive'] },
  },
} as const

export async function registerProsthesisFollowupRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (v1) => {
      v1.get(
        '/procedures/:procedureId/prosthesis-followups',
        {
          schema: {
            tags: ['prontuario'],
            operationId: 'listProsthesisFollowups',
            summary: 'Lista fases de follow-up de prótese do procedimento',
            security: [{ bearerAuth: [] }],
            params: procedureParams,
            response: {
              200: { type: 'array', items: followupSchema },
              401: errorResponseSchema,
              404: errorResponseSchema,
              503: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const database = databaseOf(request, reply)
          if (!database || !request.dentist) return
          const items = await listProsthesisFollowups(
            database,
            request.dentist.id,
            (request.params as { procedureId: string }).procedureId,
          )
          // Ciber: 404 (não 403) — anti-enumeração para missing/foreign/soft-deleted
          if (!items) return reply.status(404).send(notFound(request))
          return items
        },
      )

      v1.put(
        '/procedures/:procedureId/prosthesis-followups/:phase',
        {
          schema: {
            tags: ['prontuario'],
            operationId: 'upsertProsthesisFollowup',
            summary: 'Cria ou atualiza fase provisional/definitive',
            security: [{ bearerAuth: [] }],
            params: procedurePhaseParams,
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                status: {
                  type: 'string',
                  enum: ['molded', 'sentToLab', 'returnedFromLab', 'installed'],
                },
                statusAt: { type: 'string' },
              },
            },
            response: {
              200: followupSchema,
              400: errorResponseSchema,
              401: errorResponseSchema,
              404: errorResponseSchema,
              503: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const database = databaseOf(request, reply)
          if (!database || !request.dentist) return
          const params = request.params as { procedureId: string; phase: string }
          const body = (request.body ?? {}) as { status?: unknown; statusAt?: unknown }
          const record = await upsertProsthesisFollowup(database, request.dentist.id, params.procedureId, {
            phase: params.phase,
            status: body.status,
            statusAt: body.statusAt,
          })
          if (!record) return reply.status(404).send(notFound(request))
          return record
        },
      )

      v1.patch(
        '/procedures/:procedureId/prosthesis-followups/:phase',
        {
          schema: {
            tags: ['prontuario'],
            operationId: 'patchProsthesisFollowupStatus',
            summary: 'Atualiza status da fase definitiva (skip permitido)',
            security: [{ bearerAuth: [] }],
            params: procedurePhaseParams,
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['status'],
              properties: {
                status: {
                  type: 'string',
                  enum: ['molded', 'sentToLab', 'returnedFromLab', 'installed'],
                },
                statusAt: { type: 'string' },
              },
            },
            response: {
              200: followupSchema,
              400: errorResponseSchema,
              401: errorResponseSchema,
              404: errorResponseSchema,
              503: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const database = databaseOf(request, reply)
          if (!database || !request.dentist) return
          const params = request.params as { procedureId: string; phase: string }
          const body = request.body as { status?: unknown; statusAt?: unknown }
          const record = await patchProsthesisFollowupStatus(
            database,
            request.dentist.id,
            params.procedureId,
            params.phase,
            body,
          )
          if (!record) return reply.status(404).send(notFound(request))
          return record
        },
      )
    },
    { prefix: '/v1' },
  )
}
