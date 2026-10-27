import type { Database } from '../db/database.js'

/** TTL do cache ViaCEP (Ciber): hit fresco só dentro desta janela. */
export const CEP_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type CepSource = 'cache' | 'viacep'

/** Wire ADR-003 — vocabulário ViaCEP (DB guarda street/neighborhood/city/state). */
export type CepLookupResponse = {
  cep: string
  logradouro: string
  bairro: string
  localidade: string
  uf: string
  source: CepSource
}

export type ViaCepSuccess = {
  ok: true
  street: string
  neighborhood: string
  city: string
  state: string
  ibge: string
}

export type ViaCepFailure = {
  ok: false
  reason: 'not_found' | 'unavailable'
}

export type ViaCepResult = ViaCepSuccess | ViaCepFailure

export type ViaCepClient = (cep: string) => Promise<ViaCepResult>

export class CepError extends Error {
  readonly statusCode: number
  readonly code: 'cep_invalid' | 'cep_not_found' | 'viacep_unavailable'

  constructor(
    statusCode: number,
    code: 'cep_invalid' | 'cep_not_found' | 'viacep_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'CepError'
    this.statusCode = statusCode
    this.code = code
  }
}

type CepCacheRow = {
  cep: string
  street: string
  neighborhood: string
  city: string
  state: string
  ibge: string
  fetched_at: Date | string
}

const VIA_CEP_HTTPS = 'https://viacep.com.br/ws'

/** Normaliza para 8 dígitos ou null se inválido. */
export function normalizeCep(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (digits.length !== 8) return null
  return digits
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function isFresh(fetchedAt: Date | string, now: Date, ttlMs: number): boolean {
  return now.getTime() - asDate(fetchedAt).getTime() < ttlMs
}

function toResponse(row: CepCacheRow, source: CepSource): CepLookupResponse {
  return {
    cep: String(row.cep).trim(),
    logradouro: row.street,
    bairro: row.neighborhood,
    localidade: row.city,
    uf: String(row.state).trim(),
    source,
  }
}

/**
 * Cliente ViaCEP padrão — somente HTTPS (Ciber).
 * Não loga CEP/endereço; erros viram reason sem PII.
 */
export async function defaultViaCepClient(cep: string): Promise<ViaCepResult> {
  const url = `${VIA_CEP_HTTPS}/${cep}/json/`
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
      redirect: 'error',
    })
    if (!response.ok) return { ok: false, reason: 'unavailable' }
    const body = (await response.json()) as {
      erro?: boolean | string
      logradouro?: string
      bairro?: string
      localidade?: string
      uf?: string
      ibge?: string
    }
    if (body.erro === true || body.erro === 'true') {
      return { ok: false, reason: 'not_found' }
    }
    const state = (body.uf ?? '').trim().toUpperCase()
    return {
      ok: true,
      street: body.logradouro ?? '',
      neighborhood: body.bairro ?? '',
      city: body.localidade ?? '',
      state,
      ibge: body.ibge ?? '',
    }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

async function readCache(
  database: Database,
  dentistId: string,
  cep: string,
): Promise<CepCacheRow | null> {
  const rows = await database.withDentist(dentistId, (tx) =>
    tx.query<CepCacheRow>(
      `SELECT cep, street, neighborhood, city, state, ibge, fetched_at
       FROM cep_cache WHERE cep = $1`,
      [cep],
    ),
  )
  return rows[0] ?? null
}

async function upsertCache(
  database: Database,
  dentistId: string,
  cep: string,
  data: ViaCepSuccess,
  fetchedAt: Date,
): Promise<CepCacheRow> {
  const rows = await database.withDentist(dentistId, (tx) =>
    tx.query<CepCacheRow>(
      `INSERT INTO cep_cache (
         cep, street, neighborhood, city, state, ibge, source, fetched_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'viacep', $7, $7)
       ON CONFLICT (cep) DO UPDATE SET
         street = EXCLUDED.street,
         neighborhood = EXCLUDED.neighborhood,
         city = EXCLUDED.city,
         state = EXCLUDED.state,
         ibge = EXCLUDED.ibge,
         source = EXCLUDED.source,
         fetched_at = EXCLUDED.fetched_at,
         updated_at = EXCLUDED.updated_at
       RETURNING cep, street, neighborhood, city, state, ibge, fetched_at`,
      [cep, data.street, data.neighborhood, data.city, data.state, data.ibge, fetchedAt.toISOString()],
    ),
  )
  const row = rows[0]
  if (!row) throw new Error('cep_cache upsert failed')
  return row
}

export type LookupCepDeps = {
  database: Database
  dentistId: string
  cepRaw: string
  now?: Date
  ttlMs?: number
  viaCep?: ViaCepClient
}

/**
 * Lookup CEP com cache (L2S-72 / ADR-003).
 * - miss + ViaCEP ok → UPSERT, source viacep
 * - hit fresco → source cache (sem chamar ViaCEP)
 * - hit expirado → reconsulta; se ViaCEP down, serve stale (melhor que 502)
 * - ViaCEP {erro:true} → 404, NÃO grava
 * - ViaCEP down sem row → 502 viacep_unavailable
 */
export async function lookupCep(deps: LookupCepDeps): Promise<CepLookupResponse> {
  const cep = normalizeCep(deps.cepRaw)
  if (!cep) {
    throw new CepError(400, 'cep_invalid', 'CEP inválido.')
  }

  const now = deps.now ?? new Date()
  const ttlMs = deps.ttlMs ?? CEP_CACHE_TTL_MS
  const viaCep = deps.viaCep ?? defaultViaCepClient

  const cached = await readCache(deps.database, deps.dentistId, cep)
  if (cached && isFresh(cached.fetched_at, now, ttlMs)) {
    return toResponse(cached, 'cache')
  }

  const remote = await viaCep(cep)
  if (remote.ok) {
    const saved = await upsertCache(deps.database, deps.dentistId, cep, remote, now)
    return toResponse(saved, 'viacep')
  }

  if (remote.reason === 'not_found') {
    // Ciber / BD: CEP inexistente NÃO grava.
    throw new CepError(404, 'cep_not_found', 'CEP não encontrado.')
  }

  // ViaCEP unavailable: stale melhor que 502.
  if (cached) {
    return toResponse(cached, 'cache')
  }

  throw new CepError(502, 'viacep_unavailable', 'Consulta de CEP temporariamente indisponível.')
}
