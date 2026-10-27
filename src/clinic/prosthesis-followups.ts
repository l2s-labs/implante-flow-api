import type { Database, Queryable } from '../db/database.js'
import { ClinicValidationError, isIsoDate } from './rules.js'

/** Wire ADR-003 (EN) ↔ DB PT camelCase */

export const wirePhases = ['provisional', 'definitive'] as const
export type WirePhase = (typeof wirePhases)[number]

export const dbPhases = ['provisorio', 'definitivo'] as const
export type DbPhase = (typeof dbPhases)[number]

export const wireStatuses = ['molded', 'sentToLab', 'returnedFromLab', 'installed'] as const
export type WireStatus = (typeof wireStatuses)[number]

export const dbStatuses = [
  'moldado',
  'enviadoLaboratorio',
  'retornoLaboratorio',
  'instalada',
] as const
export type DbStatus = (typeof dbStatuses)[number]

const phaseWireToDb: Record<WirePhase, DbPhase> = {
  provisional: 'provisorio',
  definitive: 'definitivo',
}

const phaseDbToWire: Record<DbPhase, WirePhase> = {
  provisorio: 'provisional',
  definitivo: 'definitive',
}

const statusWireToDb: Record<WireStatus, DbStatus> = {
  molded: 'moldado',
  sentToLab: 'enviadoLaboratorio',
  returnedFromLab: 'retornoLaboratorio',
  installed: 'instalada',
}

const statusDbToWire: Record<DbStatus, WireStatus> = {
  moldado: 'molded',
  enviadoLaboratorio: 'sentToLab',
  retornoLaboratorio: 'returnedFromLab',
  instalada: 'installed',
}

export type ProsthesisFollowupEvent = {
  id: string
  status: WireStatus
  statusAt: string | null
  createdAt: string
}

export type ProsthesisFollowupRecord = {
  id: string
  procedureId: string
  phase: WirePhase
  status: WireStatus | null
  statusAt: string | null
  events: ProsthesisFollowupEvent[]
}

type FollowupRow = {
  id: string
  procedure_id: string
  phase: string
  status: string | null
  status_at: string | Date | null
}

type EventRow = {
  id: string
  followup_id: string
  status: string
  status_at: string | Date | null
  created_at: string | Date
}

function dateOnly(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.slice(0, 10)
  return value.toISOString().slice(0, 10)
}

function isoTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function parseWirePhase(raw: unknown): WirePhase {
  if (typeof raw !== 'string' || !wirePhases.includes(raw as WirePhase)) {
    throw new ClinicValidationError('Fase de prótese inválida.', 'prosthesis_phase_invalid')
  }
  return raw as WirePhase
}

export function parseWireStatus(raw: unknown): WireStatus {
  if (typeof raw !== 'string' || !wireStatuses.includes(raw as WireStatus)) {
    throw new ClinicValidationError('Status de prótese inválido.', 'prosthesis_status_invalid')
  }
  return raw as WireStatus
}

function parseOptionalStatusAt(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' || !isIsoDate(raw)) {
    throw new ClinicValidationError('Data do status inválida.')
  }
  return raw
}

function toWire(row: FollowupRow, events: EventRow[]): ProsthesisFollowupRecord {
  const phase = phaseDbToWire[row.phase as DbPhase]
  if (!phase) throw new ClinicValidationError('Fase de prótese inválida no banco.')
  const status =
    row.status === null || row.status === undefined
      ? null
      : (statusDbToWire[row.status as DbStatus] ?? null)
  if (row.status && !status) throw new ClinicValidationError('Status de prótese inválido no banco.')
  return {
    id: row.id,
    procedureId: row.procedure_id,
    phase,
    status,
    statusAt: dateOnly(row.status_at),
    events: events.map((event) => ({
      id: event.id,
      status: statusDbToWire[event.status as DbStatus],
      statusAt: dateOnly(event.status_at),
      createdAt: isoTimestamp(event.created_at),
    })),
  }
}

async function loadEvents(tx: Queryable, followupId: string): Promise<EventRow[]> {
  return tx.query<EventRow>(
    `SELECT id, followup_id, status, status_at, created_at
     FROM prosthesis_followup_status_events
     WHERE followup_id = $1
     ORDER BY created_at ASC, id ASC`,
    [followupId],
  )
}

async function requireActiveProteseProcedure(
  tx: Queryable,
  procedureId: string,
): Promise<{ id: string } | null> {
  const rows = await tx.query<{ id: string; modality: string }>(
    `SELECT id, modality FROM procedures
     WHERE id = $1 AND deleted_at IS NULL
     FOR UPDATE`,
    [procedureId],
  )
  const row = rows[0]
  if (!row) return null
  if (row.modality !== 'protese') {
    throw new ClinicValidationError('Follow-up de prótese só se aplica a procedimento de prótese.')
  }
  return { id: row.id }
}

async function readOne(tx: Queryable, followupId: string): Promise<ProsthesisFollowupRecord | null> {
  const rows = await tx.query<FollowupRow>(
    `SELECT id, procedure_id, phase, status, status_at
     FROM prosthesis_followups WHERE id = $1`,
    [followupId],
  )
  const row = rows[0]
  if (!row) return null
  return toWire(row, await loadEvents(tx, row.id))
}

export async function listProsthesisFollowups(
  database: Database,
  dentistId: string,
  procedureId: string,
): Promise<ProsthesisFollowupRecord[] | null> {
  return database.withDentist(dentistId, async (tx) => {
    const procedure = await tx.query<{ id: string }>(
      `SELECT id FROM procedures WHERE id = $1 AND deleted_at IS NULL`,
      [procedureId],
    )
    if (!procedure[0]) return null
    const rows = await tx.query<FollowupRow>(
      `SELECT id, procedure_id, phase, status, status_at
       FROM prosthesis_followups
       WHERE procedure_id = $1
       ORDER BY CASE phase WHEN 'provisorio' THEN 0 ELSE 1 END, id`,
      [procedureId],
    )
    const result: ProsthesisFollowupRecord[] = []
    for (const row of rows) {
      result.push(toWire(row, await loadEvents(tx, row.id)))
    }
    return result
  })
}

/**
 * Upsert da fase (unique procedure_id+phase).
 * provisional: status sempre NULL.
 * definitive: status opcional (skip permitido); grava event se status informado.
 */
export async function upsertProsthesisFollowup(
  database: Database,
  dentistId: string,
  procedureId: string,
  input: { phase: unknown; status?: unknown; statusAt?: unknown },
): Promise<ProsthesisFollowupRecord | null> {
  const phase = parseWirePhase(input.phase)
  const dbPhase = phaseWireToDb[phase]
  const statusAt = parseOptionalStatusAt(input.statusAt)

  let dbStatus: DbStatus | null = null
  if (input.status !== undefined && input.status !== null && input.status !== '') {
    if (phase === 'provisional') {
      throw new ClinicValidationError(
        'Fase provisória não possui status.',
        'prosthesis_status_invalid',
      )
    }
    dbStatus = statusWireToDb[parseWireStatus(input.status)]
  }

  return database.withDentist(dentistId, async (tx) => {
    const procedure = await requireActiveProteseProcedure(tx, procedureId)
    if (!procedure) return null

    const rows = await tx.query<FollowupRow>(
      `INSERT INTO prosthesis_followups (
         dentist_id, procedure_id, phase, status, status_at
       ) VALUES ($1, $2, $3, $4, $5::date)
       ON CONFLICT (procedure_id, phase) DO UPDATE SET
         status = CASE
           WHEN prosthesis_followups.phase = 'provisorio' THEN NULL
           ELSE COALESCE(EXCLUDED.status, prosthesis_followups.status)
         END,
         status_at = CASE
           WHEN prosthesis_followups.phase = 'provisorio' THEN NULL
           WHEN EXCLUDED.status IS NOT NULL THEN EXCLUDED.status_at
           ELSE COALESCE(EXCLUDED.status_at, prosthesis_followups.status_at)
         END
       RETURNING id, procedure_id, phase, status, status_at`,
      [dentistId, procedureId, dbPhase, dbStatus, statusAt],
    )
    const row = rows[0]
    if (!row) throw new ClinicValidationError('Não foi possível gravar o follow-up de prótese.')

    if (dbPhase === 'definitivo' && dbStatus) {
      await tx.query(
        `INSERT INTO prosthesis_followup_status_events (
           dentist_id, followup_id, status, status_at
         ) VALUES ($1, $2, $3, $4::date)`,
        [dentistId, row.id, dbStatus, statusAt],
      )
    }

    return readOne(tx, row.id)
  })
}

/** Atualiza status da fase definitiva (skip OK); provisional → 400. */
export async function patchProsthesisFollowupStatus(
  database: Database,
  dentistId: string,
  procedureId: string,
  phaseRaw: unknown,
  input: { status?: unknown; statusAt?: unknown },
): Promise<ProsthesisFollowupRecord | null> {
  const phase = parseWirePhase(phaseRaw)
  if (phase === 'provisional') {
    throw new ClinicValidationError(
      'Fase provisória não possui status.',
      'prosthesis_status_invalid',
    )
  }
  if (input.status === undefined || input.status === null || input.status === '') {
    throw new ClinicValidationError('Informe o status.', 'prosthesis_status_invalid')
  }
  const dbStatus = statusWireToDb[parseWireStatus(input.status)]
  const statusAt = parseOptionalStatusAt(input.statusAt)
  const dbPhase = phaseWireToDb[phase]

  return database.withDentist(dentistId, async (tx) => {
    const procedure = await requireActiveProteseProcedure(tx, procedureId)
    if (!procedure) return null

    const existing = await tx.query<FollowupRow>(
      `SELECT id, procedure_id, phase, status, status_at
       FROM prosthesis_followups
       WHERE procedure_id = $1 AND phase = $2
       FOR UPDATE`,
      [procedureId, dbPhase],
    )
    if (!existing[0]) {
      throw new ClinicValidationError('Crie a fase definitiva antes de atualizar o status.')
    }

    const rows = await tx.query<FollowupRow>(
      `UPDATE prosthesis_followups
       SET status = $2, status_at = $3::date
       WHERE id = $1
       RETURNING id, procedure_id, phase, status, status_at`,
      [existing[0].id, dbStatus, statusAt],
    )
    const row = rows[0]
    if (!row) return null

    await tx.query(
      `INSERT INTO prosthesis_followup_status_events (
         dentist_id, followup_id, status, status_at
       ) VALUES ($1, $2, $3, $4::date)`,
      [dentistId, row.id, dbStatus, statusAt],
    )

    return readOne(tx, row.id)
  })
}
