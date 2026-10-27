import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InvalidAccessTokenError } from '../src/auth/access-token.js'
import { dentistForAccessToken } from '../src/auth/dentist.js'
import { buildApp } from '../src/app.js'
import {
  CEP_CACHE_TTL_MS,
  normalizeCep,
  type ViaCepClient,
  type ViaCepResult,
} from '../src/cep/lookup.js'
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

const NOW = new Date('2026-10-27T12:00:00.000Z')

function mockViaCep(impl: ViaCepClient): { client: ViaCepClient; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    client: async (cep) => {
      calls.push(cep)
      return impl(cep)
    },
  }
}

async function setup(viaCep: ViaCepClient, clock: () => Date = () => NOW) {
  const database = await PgliteDatabase.create()
  const ran = await migrate(database)
  assert.ok(ran.includes('011_cep_cache.sql'), `migration 011 missing in ${ran.join(',')}`)
  const ana = await dentistForAccessToken(database, {
    subject: 'user_ana',
    email: 'ana@example.com',
    name: 'Ana',
  })
  const app = await buildApp({
    config,
    database,
    clock,
    viaCepClient: viaCep,
    authenticate: async (authorization) => {
      if (authorization !== 'Bearer ana') throw new InvalidAccessTokenError()
      return ana
    },
  })
  return { app, database, ana }
}

test('normalizeCep aceita máscara e rejeita inválido', () => {
  assert.equal(normalizeCep('01310-100'), '01310100')
  assert.equal(normalizeCep('01310100'), '01310100')
  assert.equal(normalizeCep('1310100'), null)
  assert.equal(normalizeCep('abcdefgh'), null)
})

test('GET /v1/ceps/:cep — CEP inválido → 400 cep_invalid', async () => {
  const { client } = mockViaCep(async () => ({ ok: false, reason: 'unavailable' }))
  const { app, database } = await setup(client)
  const res = await app.inject({
    method: 'GET',
    url: '/v1/ceps/123',
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(res.statusCode, 400)
  const body = res.json<{ error: { code: string; message: string; requestId: string } }>()
  assert.equal(body.error.code, 'cep_invalid')
  assert.ok(body.error.requestId)
  assert.equal(JSON.stringify(body).includes('street'), false)
  await app.close()
  await database.close()
})

test('GET /v1/ceps/:cep — exige auth', async () => {
  const { client } = mockViaCep(async () => ({ ok: false, reason: 'unavailable' }))
  const { app, database } = await setup(client)
  const res = await app.inject({ method: 'GET', url: '/v1/ceps/01310100' })
  assert.equal(res.statusCode, 401)
  await app.close()
  await database.close()
})

test('cache hit fresco — não chama ViaCEP; source=cache', async () => {
  const { client, calls } = mockViaCep(async () => {
    throw new Error('ViaCEP não deveria ser chamado no hit fresco')
  })
  const { app, database, ana } = await setup(client)

  await database.withDentist(ana.id, (tx) =>
    tx.query(
      `INSERT INTO cep_cache (cep, street, neighborhood, city, state, ibge, source, fetched_at, updated_at)
       VALUES ('01310100', 'Av Paulista', 'Bela Vista', 'São Paulo', 'SP', '3550308', 'viacep', $1, $1)`,
      [NOW.toISOString()],
    ),
  )

  const res = await app.inject({
    method: 'GET',
    url: '/v1/ceps/01310-100',
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    cep: '01310100',
    logradouro: 'Av Paulista',
    bairro: 'Bela Vista',
    localidade: 'São Paulo',
    uf: 'SP',
    source: 'cache',
  })
  assert.equal(calls.length, 0)
  await app.close()
  await database.close()
})

test('miss + ViaCEP ok — UPSERT e source=viacep', async () => {
  const { client, calls } = mockViaCep(async (cep): Promise<ViaCepResult> => {
    assert.equal(cep, '22041080')
    return {
      ok: true,
      street: 'Av Atlântica',
      neighborhood: 'Copacabana',
      city: 'Rio de Janeiro',
      state: 'RJ',
      ibge: '3304557',
    }
  })
  const { app, database, ana } = await setup(client)
  const res = await app.inject({
    method: 'GET',
    url: '/v1/ceps/22041080',
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    cep: '22041080',
    logradouro: 'Av Atlântica',
    bairro: 'Copacabana',
    localidade: 'Rio de Janeiro',
    uf: 'RJ',
    source: 'viacep',
  })
  assert.deepEqual(calls, ['22041080'])

  const rows = await database.withDentist(ana.id, (tx) =>
    tx.query<{ street: string; source: string }>('SELECT street, source FROM cep_cache WHERE cep = $1', [
      '22041080',
    ]),
  )
  assert.equal(rows[0]?.street, 'Av Atlântica')
  assert.equal(rows[0]?.source, 'viacep')
  await app.close()
  await database.close()
})

test('ViaCEP not_found — 404 cep_not_found e NÃO grava', async () => {
  const { client } = mockViaCep(async () => ({ ok: false, reason: 'not_found' }))
  const { app, database, ana } = await setup(client)
  const res = await app.inject({
    method: 'GET',
    url: '/v1/ceps/99999999',
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(res.statusCode, 404)
  const body = res.json<{ error: { code: string; requestId: string } }>()
  assert.equal(body.error.code, 'cep_not_found')
  assert.ok(body.error.requestId)

  const rows = await database.withDentist(ana.id, (tx) =>
    tx.query('SELECT cep FROM cep_cache WHERE cep = $1', ['99999999']),
  )
  assert.equal(rows.length, 0)
  await app.close()
  await database.close()
})

test('ViaCEP down sem cache — 502 viacep_unavailable', async () => {
  const { client } = mockViaCep(async () => ({ ok: false, reason: 'unavailable' }))
  const { app, database } = await setup(client)
  const res = await app.inject({
    method: 'GET',
    url: '/v1/ceps/01310100',
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(res.statusCode, 502)
  const body = res.json<{ error: { code: string; requestId: string } }>()
  assert.equal(body.error.code, 'viacep_unavailable')
  assert.ok(body.error.requestId)
  await app.close()
  await database.close()
})

test('cache expirado + ViaCEP down — serve stale source=cache', async () => {
  const staleAt = new Date(NOW.getTime() - CEP_CACHE_TTL_MS - 60_000)
  const { client, calls } = mockViaCep(async () => ({ ok: false, reason: 'unavailable' }))
  const { app, database, ana } = await setup(client)

  await database.withDentist(ana.id, (tx) =>
    tx.query(
      `INSERT INTO cep_cache (cep, street, neighborhood, city, state, ibge, source, fetched_at, updated_at)
       VALUES ('30130000', 'Av Afonso Pena', 'Centro', 'Belo Horizonte', 'MG', '3106200', 'viacep', $1, $1)`,
      [staleAt.toISOString()],
    ),
  )

  const res = await app.inject({
    method: 'GET',
    url: '/v1/ceps/30130000',
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json<{ source: string }>().source, 'cache')
  assert.equal(res.json<{ localidade: string }>().localidade, 'Belo Horizonte')
  assert.equal(calls.length, 1)
  await app.close()
  await database.close()
})

test('cache expirado + ViaCEP ok — atualiza e source=viacep', async () => {
  const staleAt = new Date(NOW.getTime() - CEP_CACHE_TTL_MS - 60_000)
  const { client } = mockViaCep(async () => ({
    ok: true,
    street: 'Praça Sete',
    neighborhood: 'Centro',
    city: 'Belo Horizonte',
    state: 'MG',
    ibge: '3106200',
  }))
  const { app, database, ana } = await setup(client)

  await database.withDentist(ana.id, (tx) =>
    tx.query(
      `INSERT INTO cep_cache (cep, street, neighborhood, city, state, ibge, source, fetched_at, updated_at)
       VALUES ('30130000', 'Av Velha', 'Centro', 'Belo Horizonte', 'MG', '3106200', 'viacep', $1, $1)`,
      [staleAt.toISOString()],
    ),
  )

  const res = await app.inject({
    method: 'GET',
    url: '/v1/ceps/30130000',
    headers: { authorization: 'Bearer ana' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    cep: '30130000',
    logradouro: 'Praça Sete',
    bairro: 'Centro',
    localidade: 'Belo Horizonte',
    uf: 'MG',
    source: 'viacep',
  })

  const rows = await database.withDentist(ana.id, (tx) =>
    tx.query<{ street: string }>('SELECT street FROM cep_cache WHERE cep = $1', ['30130000']),
  )
  assert.equal(rows[0]?.street, 'Praça Sete')
  await app.close()
  await database.close()
})

test('defaultViaCepClient usa apenas HTTPS', async () => {
  const { defaultViaCepClient } = await import('../src/cep/lookup.js')
  const original = globalThis.fetch
  let seenUrl = ''
  globalThis.fetch = (async (input: string | URL | Request) => {
    seenUrl = String(input)
    return new Response(JSON.stringify({ erro: true }), { status: 200 })
  }) as typeof fetch
  try {
    const result = await defaultViaCepClient('01310100')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'not_found')
    assert.ok(seenUrl.startsWith('https://viacep.com.br/ws/01310100/json/'))
    assert.equal(seenUrl.startsWith('http://'), false)
  } finally {
    globalThis.fetch = original
  }
})
