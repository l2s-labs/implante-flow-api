import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { CepError, lookupCep } from '../cep/lookup.js'
import type { Database } from '../db/database.js'
import { errorResponseSchema } from '../http/error-handler.js'

function databaseOf(request: FastifyRequest, reply: FastifyReply): Database | undefined {
  if (request.server.database && request.dentist) return request.server.database
  void reply.status(503).send({
    error: { code: 'unavailable', message: 'Prontuário indisponível.', requestId: request.id },
  })
  return undefined
}

const cepResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['cep', 'logradouro', 'bairro', 'localidade', 'uf', 'source'],
  properties: {
    cep: { type: 'string', pattern: '^[0-9]{8}$' },
    logradouro: { type: 'string' },
    bairro: { type: 'string' },
    localidade: { type: 'string' },
    uf: { type: 'string' },
    source: { type: 'string', enum: ['cache', 'viacep'] },
  },
} as const

export async function registerCepRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (v1) => {
      v1.get(
        '/ceps/:cep',
        {
          schema: {
            tags: ['perfil'],
            operationId: 'getCep',
            summary: 'Consulta CEP via cache/ViaCEP (servidor; app nunca chama ViaCEP)',
            security: [{ bearerAuth: [] }],
            params: {
              type: 'object',
              additionalProperties: false,
              required: ['cep'],
              properties: {
                cep: { type: 'string', description: 'CEP com 8 dígitos (hífen opcional)' },
              },
            },
            response: {
              200: cepResponseSchema,
              400: errorResponseSchema,
              401: errorResponseSchema,
              404: errorResponseSchema,
              502: errorResponseSchema,
              503: errorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const database = databaseOf(request, reply)
          if (!database || !request.dentist) return

          const { cep } = request.params as { cep: string }

          try {
            // Ciber: não logar CEP completo nem endereço (sem PII).
            request.log.info({ event: 'cep_lookup' }, 'consulta CEP')
            const deps = {
              database,
              dentistId: request.dentist.id,
              cepRaw: cep,
              now: request.server.clock(),
              ...(request.server.viaCepClient
                ? { viaCep: request.server.viaCepClient }
                : {}),
            }
            return await lookupCep(deps)
          } catch (error) {
            if (error instanceof CepError) {
              const status = error.statusCode as 400 | 404 | 502
              return reply.status(status).send({
                error: {
                  code: error.code,
                  message: error.message,
                  requestId: request.id,
                },
              })
            }
            throw error
          }
        },
      )
    },
    { prefix: '/v1' },
  )
}
