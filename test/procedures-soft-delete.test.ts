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
  assert.ok(ran.includes('012_procedures_soft_delete.sql'), `missing 012 in ${ran.join(',')}`)
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

async function createProcedure(app: Awaited<ReturnType<typeof buildApp>>, patientId: string) {
  const procedure = await app.inject({
    method: 'POST',
    url: `/v1/patients/${patientId}/procedures`,
    headers: { authorization: 'Bearer ana' },
    payload: {
      modality: 'implante',
      subtype: 'unitario',
      surgeryDate: '2026-10-01',
      statusLabel: 'planejado',
      sites: [{ fdi: 11, role: 'pilar', piece: { manufacturer: 'Neodent', model: 'Helix GM' } }],
      followUps: [{ scheduledOn: '2026-10-08', reason: 'sutura' }],
    },
  })
  assert.equal(procedure.statusCode, 201)
  return procedure.json<{ id: string; followUps: { id: string }[] }>()
}

test('L2S-73 soft delete esconde do get/chart e bloqueia mutação; sem hard delete', async () => {
  const { app, database, ana } = await setup()

  const patientRes = await app.inject({
    method: 'POST',
    url: '/v1/patients',
    headers: { authorization: 'Bearer ana' },
    payload: { name: 'Helena Soft', birthDate: '1990-01-01', phone: '21988887777' },
  })
  assert.equal(patientRes.statusCode, 201)
  const patientId = patientRes.json<{ id: string }>().id

  const saved = await createProcedure(app, patientId)
  const procedureId = saved.id

  const before = await app.inject({
    method: 'GET',
    url: '/v1/chart',
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(before.statusCode, 200)
  assert.ok(
    before.json<{ procedures: { id: string }[] }>().procedures.some((p) => p.id === procedureId),
  )

  const deleted = await app.inject({
    method: 'DELETE',
    url: `/v1/procedures/${procedureId}`,
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(deleted.statusCode, 204)
  assert.equal(deleted.body, '')

  const getGone = await app.inject({
    method: 'GET',
    url: `/v1/procedures/${procedureId}`,
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(getGone.statusCode, 403)

  const after = await app.inject({
    method: 'GET',
    url: '/v1/chart',
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(
    after.json<{ procedures: { id: string }[] }>().procedures.some((p) => p.id === procedureId),
    false,
  )

  const patch = await app.inject({
    method: 'PATCH',
    url: `/v1/procedures/${procedureId}`,
    headers: { authorization: 'Bearer ana' },
    payload: { statusLabel: 'instalado' },
  })
  assert.equal(patch.statusCode, 403)

  const visit = await app.inject({
    method: 'POST',
    url: `/v1/procedures/${procedureId}/visits`,
    headers: { authorization: 'Bearer ana' },
    payload: { date: '2026-10-08', note: 'x', statusLabel: 'instalado' },
  })
  assert.equal(visit.statusCode, 403)

  const followUpId = saved.followUps[0]?.id
  assert.ok(followUpId)
  const followUp = await app.inject({
    method: 'PATCH',
    url: `/v1/follow-ups/${followUpId}`,
    headers: { authorization: 'Bearer ana' },
    payload: { status: 'realizado' },
  })
  assert.equal(followUp.statusCode, 403)

  // Row permanece (soft); filhos intactos.
  const rows = await database.withDentist(ana.id, (tx) =>
    tx.query<{ deleted_at: string | Date | null }>(
      'SELECT deleted_at FROM procedures WHERE id = $1',
      [procedureId],
    ),
  )
  assert.equal(rows.length, 1)
  assert.ok(rows[0]?.deleted_at)

  const sites = await database.withDentist(ana.id, (tx) =>
    tx.query('SELECT id FROM tooth_sites WHERE procedure_id = $1', [procedureId]),
  )
  assert.ok(sites.length >= 1)

  // Idempotente: segundo DELETE → 404 (já excluído; Ciber anti-enumeração)
  const again = await app.inject({
    method: 'DELETE',
    url: `/v1/procedures/${procedureId}`,
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(again.statusCode, 404)
  assert.equal(again.json<{ error: { code: string } }>().error.code, 'not_found')

  await app.close()
  await database.close()
})

test('L2S-73 anti-IDOR: outro dentista recebe 404 no soft-delete', async () => {
  const { app, database } = await setup()

  const patientRes = await app.inject({
    method: 'POST',
    url: '/v1/patients',
    headers: { authorization: 'Bearer ana' },
    payload: { name: 'Paciente Bia', birthDate: '1985-05-05', phone: '11999998888' },
  })
  const patientId = patientRes.json<{ id: string }>().id
  const saved = await createProcedure(app, patientId)

  const foreign = await app.inject({
    method: 'DELETE',
    url: `/v1/procedures/${saved.id}`,
    headers: { authorization: 'Bearer bia' },
  })
  assert.equal(foreign.statusCode, 404)
  assert.equal(foreign.json<{ error: { code: string } }>().error.code, 'not_found')

  const stillThere = await app.inject({
    method: 'GET',
    url: `/v1/procedures/${saved.id}`,
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(stillThere.statusCode, 200)

  await app.close()
  await database.close()
})
