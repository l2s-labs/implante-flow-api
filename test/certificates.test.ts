import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { test } from 'node:test'
import { dentistForAccessToken } from '../src/auth/dentist.js'
import { buildApp } from '../src/app.js'
import type { AppConfig } from '../src/config.js'
import { migrate } from '../src/db/migrate.js'
import { MemoryObjectStore } from '../src/files/object-store.js'
import { PgliteDatabase } from './pglite-database.js'

function pdfContentText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1')
  const parts: string[] = []
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const payload = Buffer.from(match[1] ?? '', 'latin1')
    try {
      parts.push(inflateSync(payload).toString('latin1'))
    } catch {
      parts.push(payload.toString('latin1'))
    }
  }
  const decoded: string[] = []
  for (const hex of parts.join('\n').matchAll(/<([0-9A-Fa-f]+)> Tj/g)) {
    decoded.push(Buffer.from(hex[1] ?? '', 'hex').toString('latin1'))
  }
  return decoded.join('\n')
}

const config: AppConfig = {
  appEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  openApiEnabled: false,
  corsOrigins: [],
  serviceName: 'implante-flow-api',
  serviceVersion: '0.1.0',
  databaseUrl: null,
  workOs: null,
  s3: null,
  monitorServices: [],
  railway: null,
}

async function seedClinic(app: Awaited<ReturnType<typeof buildApp>>, auth = 'Bearer ana') {
  const patient = await app.inject({
    method: 'POST',
    url: '/v1/patients',
    headers: { authorization: auth },
    payload: { name: 'Helena', birthDate: '1980-01-02' },
  })
  const patientId = patient.json<{ id: string }>().id
  const location = await app.inject({
    method: 'POST',
    url: '/v1/locations',
    headers: { authorization: auth },
    payload: { name: 'Clínica Centro', address: 'Rua A, 100 — Centro — Rio de Janeiro/RJ — 20000-000' },
  })
  const locationId = location.json<{ id: string }>().id
  await app.inject({
    method: 'PUT',
    url: `/v1/patients/${patientId}/locations`,
    headers: { authorization: auth },
    payload: { locationIds: [locationId] },
  })
  return { patientId, locationId }
}

test('certificado incompleto é recusado e a reemissão cria outra versão sem assinatura', async () => {
  const database = await PgliteDatabase.create()
  await migrate(database)
  const ana = await dentistForAccessToken(database, { subject: 'user_ana', email: 'ana@example.com', name: 'Ana' })
  const bia = await dentistForAccessToken(database, { subject: 'user_bia', email: 'bia@example.com', name: 'Bia' })
  await database.query(`UPDATE dentists SET cro = '12345', cro_uf = 'RJ' WHERE id = $1`, [ana.id])
  const store = new MemoryObjectStore()
  const app = await buildApp({
    config,
    database,
    objectStore: store,
    authenticate: async (authorization) => (authorization === 'Bearer bia' ? bia : ana),
  })
  const { patientId, locationId } = await seedClinic(app)
  const procedure = await app.inject({
    method: 'POST',
    url: `/v1/patients/${patientId}/procedures`,
    headers: { authorization: 'Bearer ana' },
    payload: {
      modality: 'implante',
      subtype: 'unitario',
      surgeryDate: '2026-10-01',
      sites: [{ fdi: 11, role: 'pilar' }],
    },
  })
  const procedureId = procedure.json<{ id: string }>().id
  const missing = await app.inject({
    method: 'POST',
    url: `/v1/procedures/${procedureId}/certificates`,
    headers: { authorization: 'Bearer ana' },
    payload: { locationId },
  })
  assert.equal(missing.statusCode, 400)
  await database.query(
    `INSERT INTO implant_pieces (dentist_id, site_id, manufacturer, model, size, manufactured_on, expires_on)
     SELECT dentist_id, id, 'Neodent', 'Drive', '3.5', '2026-01-01', '2031-01-01'
     FROM tooth_sites WHERE procedure_id = $1`,
    [procedureId],
  )
  const first = await app.inject({
    method: 'POST',
    url: `/v1/procedures/${procedureId}/certificates`,
    headers: { authorization: 'Bearer ana' },
    payload: { locationId, copies: 1 },
  })
  assert.equal(first.statusCode, 201)
  const issued = first.json<{
    version: number
    signed: boolean
    sha256: string
    downloadUrl: string
    copies: number
    location: { id: string; name: string; address: string }
  }>()
  assert.equal(issued.version, 1)
  assert.equal(issued.signed, false)
  assert.equal(issued.sha256.length, 64)
  assert.equal(issued.downloadUrl.includes('certificates'), true)
  assert.equal(issued.copies, 1)
  assert.equal(issued.location.id, locationId)
  assert.equal(issued.location.name, 'Clínica Centro')
  assert.match(issued.location.address, /Rua A/)
  const second = await app.inject({
    method: 'POST',
    url: `/v1/procedures/${procedureId}/certificates`,
    headers: { authorization: 'Bearer ana' },
    payload: { locationId, copies: 2 },
  })
  assert.equal(second.statusCode, 201)
  assert.equal(second.json<{ version: number; copies: number }>().version, 2)
  assert.equal(second.json<{ copies: number }>().copies, 2)
  const row = await database.query<{ copies: number; location_name: string; location_address: string }>(
    `SELECT copies, location_name, location_address FROM certificate_versions
     WHERE procedure_id = $1 AND version = 2`,
    [procedureId],
  )
  assert.equal(row[0]?.copies, 2)
  assert.equal(row[0]?.location_name, 'Clínica Centro')
  const signedApp = await buildApp({
    config,
    database,
    objectStore: store,
    documentSigner: async (pdf) => ({ pdf, signed: true }),
    authenticate: async () => ana,
  })
  const signed = await signedApp.inject({
    method: 'POST',
    url: `/v1/procedures/${procedureId}/certificates`,
    headers: { authorization: 'Bearer ana' },
    payload: { locationId },
  })
  assert.equal(signed.json<{ version: number; signed: boolean }>().signed, true)
  assert.equal(signed.json<{ version: number }>().version, 3)
  await signedApp.close()
  const hidden = await app.inject({
    method: 'POST',
    url: `/v1/procedures/${procedureId}/certificates`,
    headers: { authorization: 'Bearer bia' },
    payload: { locationId },
  })
  assert.equal(hidden.statusCode, 403)
  await app.close()
  await database.close()
})

test('certificado exige CRO estruturado e aceita prótese sem peça', async () => {
  const database = await PgliteDatabase.create()
  await migrate(database)
  const ana = await dentistForAccessToken(database, { subject: 'user_ana2', email: 'ana2@example.com', name: 'Ana' })
  const store = new MemoryObjectStore()
  const app = await buildApp({
    config,
    database,
    objectStore: store,
    authenticate: async () => ana,
  })
  const { patientId, locationId } = await seedClinic(app)
  const procedure = await app.inject({
    method: 'POST',
    url: `/v1/patients/${patientId}/procedures`,
    headers: { authorization: 'Bearer ana' },
    payload: {
      modality: 'protese',
      subtype: 'unitario',
      surgeryDate: '2026-10-01',
      sites: [{ fdi: 21, role: 'pilar' }],
      linkedImplantIds: [],
    },
  })
  const procedureId = procedure.json<{ id: string }>().id
  const withoutCro = await app.inject({
    method: 'POST',
    url: `/v1/procedures/${procedureId}/certificates`,
    headers: { authorization: 'Bearer ana' },
    payload: { locationId },
  })
  assert.equal(withoutCro.statusCode, 400)
  assert.equal(withoutCro.json<{ error: { code: string } }>().error.code, 'DENTIST_CRO_REQUIRED')
  await database.query(`UPDATE dentists SET cro = '99887', cro_uf = 'SP' WHERE id = $1`, [ana.id])
  const issued = await app.inject({
    method: 'POST',
    url: `/v1/procedures/${procedureId}/certificates`,
    headers: { authorization: 'Bearer ana' },
    payload: { locationId, copies: 2 },
  })
  assert.equal(issued.statusCode, 201)
  assert.equal(issued.json<{ copies: number }>().copies, 2)
  await app.close()
  await database.close()
})

test('certificado lista todos os implantes com caixa de etiqueta', async () => {
  const database = await PgliteDatabase.create()
  await migrate(database)
  const ana = await dentistForAccessToken(database, {
    subject: 'user_ana_pdf',
    email: 'ana-pdf@example.com',
    name: 'Ana Dentista',
  })
  await database.query(
    `UPDATE dentists SET cro = '44731', cro_uf = 'RJ', phone = '21987654321' WHERE id = $1`,
    [ana.id],
  )
  const store = new MemoryObjectStore()
  const app = await buildApp({
    config,
    database,
    objectStore: store,
    authenticate: async () => ana,
  })
  const { patientId, locationId } = await seedClinic(app)
  const procedure = await app.inject({
    method: 'POST',
    url: `/v1/patients/${patientId}/procedures`,
    headers: { authorization: 'Bearer ana' },
    payload: {
      modality: 'implante',
      subtype: 'ponte',
      surgeryDate: '2026-10-01',
      sites: [
        { fdi: 14, role: 'pilar' },
        { fdi: 15, role: 'pontico' },
        { fdi: 16, role: 'pilar' },
      ],
    },
  })
  assert.equal(procedure.statusCode, 201, procedure.body)
  const procedureId = procedure.json<{ id: string }>().id
  const sites = await database.query<{ id: string; fdi: number }>(
    'SELECT id, fdi FROM tooth_sites WHERE procedure_id = $1 ORDER BY fdi',
    [procedureId],
  )
  for (const site of sites.filter((item) => item.fdi !== 15)) {
    await database.query(
      `INSERT INTO implant_pieces (dentist_id, site_id, manufacturer, model, size)
       VALUES ($1, $2, $3, $4, $5)`,
      [ana.id, site.id, 'Neodent', site.fdi === 14 ? 'Helix GM' : 'Drive CM', '3.5 x 10'],
    )
  }
  const issued = await app.inject({
    method: 'POST',
    url: `/v1/procedures/${procedureId}/certificates`,
    headers: { authorization: 'Bearer ana' },
    payload: { locationId },
  })
  assert.equal(issued.statusCode, 201)
  const key = [...store.objects.keys()].find((item) => item.includes(`/procedures/${procedureId}/certificates/`))
  assert.ok(key)
  const pdf = store.objects.get(key!)?.body
  assert.ok(pdf)
  const text = pdfContentText(pdf!)
  assert.match(text, /Certificado de proced/)
  assert.match(text, /Cole aqui a etiqueta/)
  assert.match(text, /Dente 14/)
  assert.match(text, /Dente 15/)
  assert.match(text, /Dente 16/)
  assert.match(text, /Neodent/)
  assert.match(text, /Helix GM/)
  assert.match(text, /Drive CM/)
  assert.match(text, /Ana Dentista/)
  assert.equal((text.match(/Cole aqui a etiqueta/g) ?? []).length, 2)
  await app.close()
  await database.close()
})

test('certificado com múltiplos locais exige seleção explícita', async () => {
  const database = await PgliteDatabase.create()
  await migrate(database)
  const ana = await dentistForAccessToken(database, { subject: 'user_ana3', email: 'ana3@example.com', name: 'Ana' })
  await database.query(`UPDATE dentists SET cro = '12345', cro_uf = 'RJ' WHERE id = $1`, [ana.id])
  const store = new MemoryObjectStore()
  const app = await buildApp({
    config,
    database,
    objectStore: store,
    authenticate: async () => ana,
  })
  const patient = await app.inject({
    method: 'POST',
    url: '/v1/patients',
    headers: { authorization: 'Bearer ana' },
    payload: { name: 'Helena', birthDate: '1980-01-02' },
  })
  const patientId = patient.json<{ id: string }>().id
  const first = await app.inject({
    method: 'POST',
    url: '/v1/locations',
    headers: { authorization: 'Bearer ana' },
    payload: { name: 'Clínica A', address: 'Rua 1' },
  })
  const second = await app.inject({
    method: 'POST',
    url: '/v1/locations',
    headers: { authorization: 'Bearer ana' },
    payload: { name: 'Clínica B', address: 'Rua 2' },
  })
  const locationA = first.json<{ id: string }>().id
  const locationB = second.json<{ id: string }>().id
  await app.inject({
    method: 'PUT',
    url: `/v1/patients/${patientId}/locations`,
    headers: { authorization: 'Bearer ana' },
    payload: { locationIds: [locationA, locationB] },
  })
  const procedure = await app.inject({
    method: 'POST',
    url: `/v1/patients/${patientId}/procedures`,
    headers: { authorization: 'Bearer ana' },
    payload: {
      modality: 'protese',
      subtype: 'unitario',
      surgeryDate: '2026-10-01',
      sites: [{ fdi: 11, role: 'pilar' }],
    },
  })
  const procedureId = procedure.json<{ id: string }>().id
  const ambiguous = await app.inject({
    method: 'POST',
    url: `/v1/procedures/${procedureId}/certificates`,
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(ambiguous.statusCode, 400)
  assert.equal(ambiguous.json<{ error: { code: string } }>().error.code, 'CERTIFICATE_LOCATION_REQUIRED')
  const chosen = await app.inject({
    method: 'POST',
    url: `/v1/procedures/${procedureId}/certificates`,
    headers: { authorization: 'Bearer ana' },
    payload: { locationId: locationB },
  })
  assert.equal(chosen.statusCode, 201)
  assert.equal(chosen.json<{ location: { id: string } }>().location.id, locationB)
  await app.close()
  await database.close()
})
