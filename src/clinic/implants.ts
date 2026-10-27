import type { Database, Queryable } from '../db/database.js'
import { ClinicValidationError, clientUuid, isIsoDate, isValidFdi } from './rules.js'

export type ImplantOrigin = 'preexisting' | 'procedure_recorded'

export type InstalledImplantInput = {
  id?: unknown
  fdi?: unknown
  manufacturer?: unknown
  model?: unknown
  size?: unknown
  lot?: unknown
  installedOn?: unknown
  originClinic?: unknown
  notes?: unknown
  active?: unknown
}

type ImplantRow = {
  id: string
  patient_id: string
  fdi: number
  origin: ImplantOrigin
  source_procedure_id: string | null
  manufacturer: string
  model: string
  size: string
  lot: string
  installed_on: string | Date | null
  origin_clinic: string
  notes: string
  active: boolean
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function dateOnly(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return value.slice(0, 10)
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !isIsoDate(value)) throw new ClinicValidationError(`${label} inválida.`)
  return value
}

export function implantFrom(row: ImplantRow): Record<string, unknown> {
  return {
    id: row.id,
    patientId: row.patient_id,
    fdi: row.fdi,
    origin: row.origin,
    sourceProcedureId: row.source_procedure_id,
    manufacturer: row.manufacturer,
    model: row.model,
    size: row.size,
    lot: row.lot,
    installedOn: row.installed_on ? `${dateOnly(row.installed_on)}T00:00:00.000` : null,
    originClinic: row.origin_clinic,
    notes: row.notes,
    active: row.active,
  }
}

const implantColumns = `id, patient_id, fdi, origin, source_procedure_id, manufacturer, model, size, lot,
  installed_on, origin_clinic, notes, active`

export async function listImplants(
  database: Database,
  dentistId: string,
  patientId: string,
): Promise<Record<string, unknown>[] | null> {
  return database.withDentist(dentistId, async (tx) => {
    const patient = await tx.query('SELECT id FROM patients WHERE id = $1', [patientId])
    if (!patient[0]) return null
    const rows = await tx.query<ImplantRow>(
      `SELECT ${implantColumns} FROM installed_implants
       WHERE patient_id = $1
       ORDER BY active DESC, fdi, created_at, id`,
      [patientId],
    )
    return rows.map(implantFrom)
  })
}

export async function createPreexistingImplant(
  database: Database,
  dentistId: string,
  patientId: string,
  input: InstalledImplantInput,
): Promise<Record<string, unknown> | null> {
  const fdi = Number(input.fdi)
  if (!Number.isInteger(fdi) || !isValidFdi(fdi)) {
    throw new ClinicValidationError('Informe o dente (FDI).')
  }
  const id = clientUuid(input.id)
  const manufacturer = text(input.manufacturer)
  const model = text(input.model)
  const size = text(input.size)
  const lot = text(input.lot)
  const installedOn = optionalDate(input.installedOn, 'Data de instalação')
  const originClinic = text(input.originClinic)
  const notes = text(input.notes)

  return database.withDentist(dentistId, async (tx) => {
    const patient = await tx.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [patientId])
    if (!patient[0]) return null
    const rows = await tx.query<ImplantRow>(
      `INSERT INTO installed_implants (
         id, dentist_id, patient_id, fdi, origin, manufacturer, model, size, lot,
         installed_on, origin_clinic, notes
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, 'preexisting', $5, $6, $7, $8, $9, $10, $11
       )
       RETURNING ${implantColumns}`,
      [id, dentistId, patientId, fdi, manufacturer, model, size, lot, installedOn, originClinic, notes],
    )
    const row = rows[0]
    if (!row) throw new ClinicValidationError('Não foi possível gravar o implante.')
    return implantFrom(row)
  })
}

export async function updateImplant(
  database: Database,
  dentistId: string,
  implantId: string,
  input: InstalledImplantInput,
): Promise<Record<string, unknown> | null> {
  const fdi = input.fdi === undefined ? undefined : Number(input.fdi)
  if (fdi !== undefined && (!Number.isInteger(fdi) || !isValidFdi(fdi))) {
    throw new ClinicValidationError('Dente (FDI) inválido.')
  }
  const manufacturer = input.manufacturer === undefined ? undefined : text(input.manufacturer)
  const model = input.model === undefined ? undefined : text(input.model)
  const size = input.size === undefined ? undefined : text(input.size)
  const lot = input.lot === undefined ? undefined : text(input.lot)
  const installedOn =
    input.installedOn === undefined ? undefined : optionalDate(input.installedOn, 'Data de instalação')
  const originClinic = input.originClinic === undefined ? undefined : text(input.originClinic)
  const notes = input.notes === undefined ? undefined : text(input.notes)
  const active = typeof input.active === 'boolean' ? input.active : undefined

  return database.withDentist(dentistId, async (tx) => {
    const current = await tx.query<ImplantRow>(
      `SELECT ${implantColumns} FROM installed_implants WHERE id = $1 FOR UPDATE`,
      [implantId],
    )
    const existing = current[0]
    if (!existing) return null
    if (existing.origin === 'procedure_recorded' && fdi !== undefined && fdi !== existing.fdi) {
      throw new ClinicValidationError('Dente do implante registrado em cirurgia não pode ser alterado.')
    }
    const rows = await tx.query<ImplantRow>(
      `UPDATE installed_implants
       SET fdi = COALESCE($2, fdi),
           manufacturer = COALESCE($3, manufacturer),
           model = COALESCE($4, model),
           size = COALESCE($5, size),
           lot = COALESCE($6, lot),
           installed_on = CASE WHEN $7::boolean THEN $8::date ELSE installed_on END,
           origin_clinic = COALESCE($9, origin_clinic),
           notes = COALESCE($10, notes),
           active = COALESCE($11, active)
       WHERE id = $1
       RETURNING ${implantColumns}`,
      [
        implantId,
        fdi ?? null,
        manufacturer ?? null,
        model ?? null,
        size ?? null,
        lot ?? null,
        installedOn !== undefined,
        installedOn ?? null,
        originClinic ?? null,
        notes ?? null,
        active ?? null,
      ],
    )
    const row = rows[0]
    return row ? implantFrom(row) : null
  })
}

/** Insert procedure-recorded implants; skips FDI already provisioned for this procedure. */
export async function insertProcedureRecordedImplants(
  tx: Queryable,
  dentistId: string,
  patientId: string,
  procedureId: string,
  sites: { fdi: number; role: string; piece?: Record<string, unknown> | null }[],
  surgeryDate: string,
): Promise<void> {
  for (const site of sites) {
    if (site.role !== 'pilar') continue
    const existing = await tx.query(
      `SELECT id FROM installed_implants
       WHERE source_procedure_id = $1 AND fdi = $2 AND origin = 'procedure_recorded'`,
      [procedureId, site.fdi],
    )
    if (existing[0]) continue
    const piece = site.piece
    await tx.query(
      `INSERT INTO installed_implants (
         dentist_id, patient_id, fdi, origin, source_procedure_id,
         manufacturer, model, size, lot, installed_on
       ) VALUES ($1, $2, $3, 'procedure_recorded', $4, $5, $6, $7, $8, $9)`,
      [
        dentistId,
        patientId,
        site.fdi,
        procedureId,
        text(piece?.['manufacturer']),
        text(piece?.['model']),
        text(piece?.['size']),
        text(piece?.['lot']),
        surgeryDate,
      ],
    )
  }
}

export async function insertImplantLinks(
  tx: Queryable,
  dentistId: string,
  patientId: string,
  procedureId: string,
  linkedImplantIds: unknown,
  linkedProcedureIds: unknown,
): Promise<void> {
  const implantIds = new Set<string>()
  if (Array.isArray(linkedImplantIds)) {
    for (const value of linkedImplantIds) {
      const id = clientUuid(value)
      if (!id) throw new ClinicValidationError('Implante vinculado inválido.')
      implantIds.add(id)
    }
  }
  if (Array.isArray(linkedProcedureIds)) {
    for (const value of linkedProcedureIds) {
      const procedureLinkedId = clientUuid(value)
      if (!procedureLinkedId) throw new ClinicValidationError('Procedimento vinculado inválido.')
      const mapped = await tx.query<{ id: string }>(
        `SELECT id FROM installed_implants
         WHERE source_procedure_id = $1 AND patient_id = $2 AND active = true`,
        [procedureLinkedId, patientId],
      )
      if (mapped.length === 0) {
        // Fallback: keep legacy procedure_links for chart compatibility when inventory missing.
        const found = await tx.query('SELECT id FROM procedures WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL', [
          procedureLinkedId,
          patientId,
        ])
        if (!found[0]) throw new ClinicValidationError('Procedimento vinculado não encontrado.')
        await tx.query(
          `INSERT INTO procedure_links (dentist_id, procedure_id, linked_procedure_id) VALUES ($1, $2, $3)`,
          [dentistId, procedureId, procedureLinkedId],
        )
        continue
      }
      for (const row of mapped) implantIds.add(row.id)
    }
  }

  for (const implantId of implantIds) {
    const found = await tx.query<{ id: string; patient_id: string }>(
      'SELECT id, patient_id FROM installed_implants WHERE id = $1 AND active = true',
      [implantId],
    )
    const implant = found[0]
    if (!implant) throw new ClinicValidationError('Implante vinculado não encontrado.')
    if (implant.patient_id !== patientId) {
      throw new ClinicValidationError('Implante vinculado pertence a outro paciente.')
    }
    await tx.query(
      `INSERT INTO procedure_implant_links (dentist_id, procedure_id, implant_id) VALUES ($1, $2, $3)`,
      [dentistId, procedureId, implantId],
    )
  }
}
