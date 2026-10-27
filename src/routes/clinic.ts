import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Database } from '../db/database.js'
import { readChart } from '../clinic/chart.js'
import {
  createPreexistingImplant,
  listImplants,
  updateImplant,
  type InstalledImplantInput,
} from '../clinic/implants.js'
import type { ToothSiteInput } from '../clinic/rules.js'
import {
  createPatient,
  createProcedure,
  getPatient,
  getProcedure,
  listPatients,
  recordVisit,
  softDeleteProcedure,
  updateFollowUp,
  updatePatient,
  updateProcedureStatus,
  type PatientInput,
  type ProcedureInput,
} from '../clinic/store.js'
import { errorResponseSchema } from '../http/error-handler.js'

const denied = (request: FastifyRequest) => ({
  error: { code: 'forbidden', message: 'Acesso negado.', requestId: request.id },
})

function databaseOf(request: FastifyRequest, reply: FastifyReply): Database | undefined {
  if (request.server.database && request.dentist) return request.server.database
  void reply.status(503).send({
    error: { code: 'unavailable', message: 'Prontuário indisponível.', requestId: request.id },
  })
  return undefined
}

function page(query: { limit?: number; offset?: number }): { limit: number; offset: number } {
  return {
    limit: query.limit ?? 50,
    offset: query.offset ?? 0,
  }
}

export async function registerClinicRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (v1) => {
      v1.get(
        '/chart',
        {
          schema: {
            tags: ['prontuario'],
            operationId: 'getChart',
            summary: 'Prontuário do dentista autenticado',
            security: [{ bearerAuth: [] }],
            response: {
              200: { type: 'object', additionalProperties: true },
              401: errorResponseSchema,
              503: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const database = databaseOf(request, reply)
          if (!database || !request.dentist) return
          return readChart(database, request.dentist.id)
        },
      )

      v1.get(
        '/patients',
        {
          schema: {
            tags: ['prontuario'],
            operationId: 'listPatients',
            security: [{ bearerAuth: [] }],
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                q: { type: 'string', maxLength: 120 },
                limit: { type: 'integer', minimum: 1, maximum: 100 },
                offset: { type: 'integer', minimum: 0 },
                locationId: { type: 'string', format: 'uuid' },
                withoutLocation: { type: 'boolean' },
              },
            },
            response: { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema },
          },
        },
        async (request, reply) => {
          const database = databaseOf(request, reply)
          if (!database || !request.dentist) return
          const query = request.query as {
            q?: string
            limit?: number
            offset?: number
            locationId?: string
            withoutLocation?: boolean
          }
          if (query.locationId && query.withoutLocation) {
            return reply.status(400).send({
              error: { code: 'validation_error', message: 'Escolha um local ou pacientes sem local.', requestId: request.id },
            })
          }
          const { limit, offset } = page(query)
          return listPatients(database, request.dentist.id, {
            search: query.q?.trim() ?? '',
            limit,
            offset,
            ...(query.locationId ? { locationId: query.locationId } : {}),
            ...(query.withoutLocation ? { withoutLocation: true } : {}),
          })
        },
      )

      v1.post(
        '/patients',
        {
          schema: {
            tags: ['prontuario'],
            operationId: 'createPatient',
            security: [{ bearerAuth: [] }],
            body: { type: 'object', additionalProperties: false, properties: patientProperties },
            response: {
              201: { type: 'object', additionalProperties: true },
              400: errorResponseSchema,
              401: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const database = databaseOf(request, reply)
          if (!database || !request.dentist) return
          const patient = await createPatient(database, request.dentist.id, request.body as PatientInput)
          return reply.status(201).send(patient)
        },
      )

      v1.get('/patients/:patientId', resourceSchema('getPatient'), async (request, reply) => {
        const database = databaseOf(request, reply)
        if (!database || !request.dentist) return
        const patient = await getPatient(database, request.dentist.id, (request.params as { patientId: string }).patientId)
        if (!patient) return reply.status(403).send(denied(request))
        return patient
      })

      v1.patch('/patients/:patientId', resourceSchema('updatePatient'), async (request, reply) => {
        const database = databaseOf(request, reply)
        if (!database || !request.dentist) return
        const patient = await updatePatient(
          database,
          request.dentist.id,
          (request.params as { patientId: string }).patientId,
          request.body as PatientInput,
        )
        if (!patient) return reply.status(403).send(denied(request))
        return patient
      })

      v1.get(
        '/patients/:patientId/implants',
        {
          schema: {
            tags: ['prontuario'],
            operationId: 'listImplants',
            security: [{ bearerAuth: [] }],
            params: {
              type: 'object',
              additionalProperties: false,
              properties: { patientId: { type: 'string', format: 'uuid' } },
            },
            response: {
              200: { type: 'array', items: { type: 'object', additionalProperties: true } },
              401: errorResponseSchema,
              403: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const database = databaseOf(request, reply)
          if (!database || !request.dentist) return
          const implants = await listImplants(
            database,
            request.dentist.id,
            (request.params as { patientId: string }).patientId,
          )
          if (!implants) return reply.status(403).send(denied(request))
          return implants
        },
      )

      v1.post('/patients/:patientId/implants', resourceSchema('createImplant'), async (request, reply) => {
        const database = databaseOf(request, reply)
        if (!database || !request.dentist) return
        const implant = await createPreexistingImplant(
          database,
          request.dentist.id,
          (request.params as { patientId: string }).patientId,
          request.body as InstalledImplantInput,
        )
        if (!implant) return reply.status(403).send(denied(request))
        return reply.status(201).send(implant)
      })

      v1.patch('/implants/:implantId', resourceSchema('updateImplant'), async (request, reply) => {
        const database = databaseOf(request, reply)
        if (!database || !request.dentist) return
        const implant = await updateImplant(
          database,
          request.dentist.id,
          (request.params as { implantId: string }).implantId,
          request.body as InstalledImplantInput,
        )
        if (!implant) return reply.status(403).send(denied(request))
        return implant
      })

      v1.post('/patients/:patientId/procedures', resourceSchema('createProcedure'), async (request, reply) => {
        const database = databaseOf(request, reply)
        if (!database || !request.dentist) return
        const procedure = await createProcedure(
          database,
          request.dentist.id,
          (request.params as { patientId: string }).patientId,
          request.body as ProcedureInput,
        )
        if (!procedure) return reply.status(403).send(denied(request))
        return reply.status(201).send(procedure)
      })

      v1.get('/procedures/:procedureId', resourceSchema('getProcedure'), async (request, reply) => {
        const database = databaseOf(request, reply)
        if (!database || !request.dentist) return
        const procedure = await getProcedure(
          database,
          request.dentist.id,
          (request.params as { procedureId: string }).procedureId,
        )
        if (!procedure) return reply.status(403).send(denied(request))
        return procedure
      })

      v1.delete(
        '/procedures/:procedureId',
        {
          schema: {
            tags: ['prontuario'],
            operationId: 'softDeleteProcedure',
            summary: 'Soft delete do procedimento (deleted_at; sem hard delete)',
            security: [{ bearerAuth: [] }],
            params: {
              type: 'object',
              additionalProperties: false,
              required: ['procedureId'],
              properties: { procedureId: { type: 'string', format: 'uuid' } },
            },
            response: {
              204: { type: 'null', description: 'Procedimento marcado como excluído' },
              401: errorResponseSchema,
              403: errorResponseSchema,
              503: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const database = databaseOf(request, reply)
          if (!database || !request.dentist) return
          const ok = await softDeleteProcedure(
            database,
            request.dentist.id,
            (request.params as { procedureId: string }).procedureId,
          )
          if (!ok) return reply.status(403).send(denied(request))
          return reply.status(204).send()
        },
      )

      v1.patch('/procedures/:procedureId', resourceSchema('updateProcedure'), async (request, reply) => {
        const database = databaseOf(request, reply)
        if (!database || !request.dentist) return
        const body = request.body as {
          statusLabel?: unknown
          notes?: unknown
          sites?: unknown
          sinusLift?: unknown
          sinusLiftTechnique?: unknown
          sinusLiftNote?: unknown
          associatedGraft?: unknown
        }
        if (typeof body.statusLabel !== 'string') {
          return reply.status(400).send({
            error: { code: 'validation_error', message: 'Informe o status.', requestId: request.id },
          })
        }
        const procedure = await updateProcedureStatus(
          database,
          request.dentist.id,
          (request.params as { procedureId: string }).procedureId,
          body.statusLabel,
          typeof body.notes === 'string' ? body.notes : undefined,
          {
            ...(Array.isArray(body.sites) ? { sites: body.sites as ToothSiteInput[] } : {}),
            ...(typeof body.sinusLift === 'boolean' ? { sinusLift: body.sinusLift } : {}),
            ...(typeof body.sinusLiftTechnique === 'string' ? { sinusLiftTechnique: body.sinusLiftTechnique } : {}),
            ...(typeof body.sinusLiftNote === 'string' ? { sinusLiftNote: body.sinusLiftNote } : {}),
            ...(typeof body.associatedGraft === 'boolean' ? { associatedGraft: body.associatedGraft } : {}),
          },
        )
        if (!procedure) return reply.status(403).send(denied(request))
        return procedure
      })

      v1.post('/procedures/:procedureId/visits', resourceSchema('recordVisit'), async (request, reply) => {
        const database = databaseOf(request, reply)
        if (!database || !request.dentist) return
        const procedure = await recordVisit(
          database,
          request.dentist.id,
          (request.params as { procedureId: string }).procedureId,
          request.body as { date?: unknown; note?: unknown; statusLabel?: unknown },
        )
        if (!procedure) return reply.status(403).send(denied(request))
        return reply.status(201).send(procedure)
      })

      v1.patch('/follow-ups/:followUpId', resourceSchema('updateFollowUp'), async (request, reply) => {
        const database = databaseOf(request, reply)
        if (!database || !request.dentist) return
        const followUp = await updateFollowUp(
          database,
          request.dentist.id,
          (request.params as { followUpId: string }).followUpId,
          request.body as Record<string, unknown>,
        )
        if (!followUp) return reply.status(403).send(denied(request))
        return followUp
      })
    },
    { prefix: '/v1' },
  )
}

const patientProperties = {
  id: { type: 'string', format: 'uuid' },
  name: { type: 'string' },
  birthDate: { type: 'string' },
  phone: { type: 'string' },
  email: { type: 'string' },
  cpf: { type: 'string' },
  notes: { type: 'string' },
  guardian: { type: 'string' },
  notifyByEmail: { type: 'boolean' },
  notifyByPhone: { type: 'boolean' },
}

function resourceSchema(operationId: string) {
  return {
    schema: {
      tags: ['prontuario'],
      operationId,
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        additionalProperties: false,
        properties: {
          patientId: { type: 'string', format: 'uuid' },
          procedureId: { type: 'string', format: 'uuid' },
          followUpId: { type: 'string', format: 'uuid' },
          implantId: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        201: { type: 'object', additionalProperties: true },
        400: errorResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
      },
    },
  }
}
