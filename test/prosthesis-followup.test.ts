import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InvalidAccessTokenError } from '../src/auth/access-token.js'
import { dentistForAccessToken } from '../src/auth/dentist.js'
import { buildApp } from '../src/app.js'
import type { AppConfig } from '../src/config.js'
import { migrate } from '../src/db/migrate.js'
import { PgliteDatabase } from './pglite-database.js'

const config: AppConfig = {
  appEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  openApiEnabled: false,
  corsOrigins: [],
  serviceName: 'implante-flow-api',
  serviceVersion: '0.2.1',
  databaseUrl: null,
  workOs: null,
  s3: null,
  monitorServices: [],
  railway: null,
}

async function setup() {
  const database = await PgliteDatabase.create()
  const ran = await migrate(database)
  assert.ok(ran.includes('013_prosthesis_followups.sql'), `missing 013 in ${ran.join(',')}`)
  const ana = await dentistForAccessToken(database, {
    subject: 'user_ana',
    email: 'ana@example.com',
    name: 'Ana',
  })
  const bia = await dentistForAccessToken(database, {
    subject: 'user_bia',
    email: 'bia@example.com',
    name: 'Bia',
  })
  const app = await buildApp({
    config,
    database,
    authenticate: async (authorization) => {
      if (authorization === 'Bearer ana') return ana
      if (authorization === 'Bearer bia') return bia
      throw new InvalidAccessTokenError()
    },
  })
  return { app, database, ana, bia }
}

async function createProteseProcedure(app: Awaited<ReturnType<typeof buildApp>>) {
  const patient = await app.inject({
    method: 'POST',
    url: '/v1/patients',
    headers: { authorization: 'Bearer ana' },
    payload: { name: 'Paciente Protese', birthDate: '1980-01-01', phone: '21977776666' },
  })
  assert.equal(patient.statusCode, 201)
  const patientId = patient.json<{ id: string }>().id

  const procedure = await app.inject({
    method: 'POST',
    url: `/v1/patients/${patientId}/procedures`,
    headers: { authorization: 'Bearer ana' },
    payload: {
      modality: 'protese',
      subtype: 'unitario',
      surgeryDate: '2026-10-01',
      statusLabel: 'planejado',
      sites: [{ fdi: 11, role: 'pilar' }],
    },
  })
  assert.equal(procedure.statusCode, 201, procedure.body)
  return { patientId, procedureId: procedure.json<{ id: string }>().id }
}

test('L2S-74 provisional + definitive com skip e events; wire EN', async () => {
  const { app, database } = await setup()
  const { procedureId } = await createProteseProcedure(app)

  const empty = await app.inject({
    method: 'GET',
    url: `/v1/procedures/${procedureId}/prosthesis-followups`,
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(empty.statusCode, 200)
  assert.deepEqual(empty.json(), [])

  const provisional = await app.inject({
    method: 'PUT',
    url: `/v1/procedures/${procedureId}/prosthesis-followups/provisional`,
    headers: { authorization: 'Bearer ana' },
    payload: {},
  })
  assert.equal(provisional.statusCode, 200, provisional.body)
  const prov = provisional.json<{
    phase: string
    status: null
    statusAt: null
    events: unknown[]
  }>()
  assert.equal(prov.phase, 'provisional')
  assert.equal(prov.status, null)
  assert.equal(prov.events.length, 0)

  const withStatusOnProv = await app.inject({
    method: 'PUT',
    url: `/v1/procedures/${procedureId}/prosthesis-followups/provisional`,
    headers: { authorization: 'Bearer ana' },
    payload: { status: 'molded' },
  })
  assert.equal(withStatusOnProv.statusCode, 400)
  assert.equal(
    withStatusOnProv.json<{ error: { code: string } }>().error.code,
    'prosthesis_status_invalid',
  )

  const definitive = await app.inject({
    method: 'PUT',
    url: `/v1/procedures/${procedureId}/prosthesis-followups/definitive`,
    headers: { authorization: 'Bearer ana' },
    payload: { status: 'installed', statusAt: '2026-10-15' },
  })
  assert.equal(definitive.statusCode, 200, definitive.body)
  const def = definitive.json<{
    phase: string
    status: string
    statusAt: string
    events: { status: string; statusAt: string | null }[]
  }>()
  assert.equal(def.phase, 'definitive')
  assert.equal(def.status, 'installed')
  assert.equal(def.statusAt, '2026-10-15')
  assert.equal(def.events.length, 1)
  assert.equal(def.events[0]?.status, 'installed')
  assert.equal(def.events[0]?.statusAt, '2026-10-15')

  const patched = await app.inject({
    method: 'PATCH',
    url: `/v1/procedures/${procedureId}/prosthesis-followups/definitive`,
    headers: { authorization: 'Bearer ana' },
    payload: { status: 'returnedFromLab', statusAt: '2026-10-10' },
  })
  assert.equal(patched.statusCode, 200)
  const afterPatch = patched.json<{
    status: string
    events: { status: string }[]
  }>()
  assert.equal(afterPatch.status, 'returnedFromLab')
  assert.equal(afterPatch.events.length, 2)
  assert.deepEqual(
    afterPatch.events.map((e) => e.status),
    ['installed', 'returnedFromLab'],
  )

  const listed = await app.inject({
    method: 'GET',
    url: `/v1/procedures/${procedureId}/prosthesis-followups`,
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(listed.statusCode, 200)
  const items = listed.json<{ phase: string }[]>()
  assert.equal(items.length, 2)
  assert.equal(items[0]?.phase, 'provisional')
  assert.equal(items[1]?.phase, 'definitive')

  const invalidPhase = await app.inject({
    method: 'PUT',
    url: `/v1/procedures/${procedureId}/prosthesis-followups/provisional`,
    headers: { authorization: 'Bearer ana' },
    payload: {},
  })
  // upsert again ok
  assert.equal(invalidPhase.statusCode, 200)

  const badStatus = await app.inject({
    method: 'PATCH',
    url: `/v1/procedures/${procedureId}/prosthesis-followups/definitive`,
    headers: { authorization: 'Bearer ana' },
    payload: { status: 'naoExiste' },
  })
  assert.equal(badStatus.statusCode, 400)

  await app.close()
  await database.close()
})

test('L2S-74 soft-deleted parent e anti-IDOR → 404', async () => {
  const { app, database } = await setup()
  const { procedureId } = await createProteseProcedure(app)

  await app.inject({
    method: 'PUT',
    url: `/v1/procedures/${procedureId}/prosthesis-followups/provisional`,
    headers: { authorization: 'Bearer ana' },
    payload: {},
  })

  const foreignList = await app.inject({
    method: 'GET',
    url: `/v1/procedures/${procedureId}/prosthesis-followups`,
    headers: { authorization: 'Bearer bia' },
  })
  assert.equal(foreignList.statusCode, 404)
  assert.equal(foreignList.json<{ error: { code: string } }>().error.code, 'not_found')

  const foreignPut = await app.inject({
    method: 'PUT',
    url: `/v1/procedures/${procedureId}/prosthesis-followups/definitive`,
    headers: { authorization: 'Bearer bia' },
    payload: { status: 'molded' },
  })
  assert.equal(foreignPut.statusCode, 404)

  const deleted = await app.inject({
    method: 'DELETE',
    url: `/v1/procedures/${procedureId}`,
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(deleted.statusCode, 204)

  const afterDelete = await app.inject({
    method: 'GET',
    url: `/v1/procedures/${procedureId}/prosthesis-followups`,
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(afterDelete.statusCode, 404)

  const putAfterDelete = await app.inject({
    method: 'PUT',
    url: `/v1/procedures/${procedureId}/prosthesis-followups/definitive`,
    headers: { authorization: 'Bearer ana' },
    payload: { status: 'molded' },
  })
  assert.equal(putAfterDelete.statusCode, 404)

  await app.close()
  await database.close()
})

test('L2S-74 fase inválida na URL → 400 nested', async () => {
  const { app, database } = await setup()
  const { procedureId } = await createProteseProcedure(app)

  const res = await app.inject({
    method: 'PUT',
    url: `/v1/procedures/${procedureId}/prosthesis-followups/provisorio`,
    headers: { authorization: 'Bearer ana' },
    payload: {},
  })
  // Fastify schema enum rejects before handler → 400 validation_error
  assert.equal(res.statusCode, 400)
  assert.ok(res.json<{ error: { code: string; requestId: string } }>().error.requestId)

  await app.close()
  await database.close()
})
