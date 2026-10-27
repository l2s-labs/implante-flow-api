import type { Queryable } from '../db/database.js'
import type { Database } from '../db/database.js'
import { recordStageChange, revokeDisabledChannels } from '../notices/stage-notices.js'
import { insertImplantLinks, insertProcedureRecordedImplants } from './implants.js'
import {
  ClinicValidationError,
  assertProcedureShape,
  clientUuid,
  followUpReasons,
  isIsoDate,
  isMinor,
  isValidCpf,
  isValidEmail,
  isValidPhone,
  normalizePhone,
  statusesFor,
  type ToothSiteInput,
} from './rules.js'

export type PatientInput = {
  name?: unknown
  birthDate?: unknown
  phone?: unknown
  email?: unknown
  cpf?: unknown
  notes?: unknown
  guardian?: unknown
  notifyByEmail?: unknown
  notifyByPhone?: unknown
}

export type PatientRecord = {
  id: string
  name: string
  birthDate: string
  phone: string
  email: string
  cpf: string
  notes: string
  guardian: string
  notifyByEmail: boolean
  notifyByPhone: boolean
}

type PatientRow = {
  id: string
  name: string
  birth_date: string | Date
  phone: string
  email: string
  cpf: string
  notes: string
  guardian: string
  notify_by_email: boolean
  notify_by_phone: boolean
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function dateOnly(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return value.slice(0, 10)
}

function toPatient(row: PatientRow): PatientRecord {
  return {
    id: row.id,
    name: row.name,
    birthDate: dateOnly(row.birth_date),
    phone: row.phone,
    email: row.email,
    cpf: row.cpf,
    notes: row.notes,
    guardian: row.guardian,
    notifyByEmail: row.notify_by_email,
    notifyByPhone: row.notify_by_phone,
  }
}

export function parsePatient(input: PatientInput, current?: PatientRecord): Omit<PatientRecord, 'id'> {
  const name = text(input.name, current?.name)
  const birthDate = text(input.birthDate, current?.birthDate)
  const phone = normalizePhone(text(input.phone, current?.phone))
  const email = text(input.email, current?.email).toLowerCase()
  const cpf = text(input.cpf, current?.cpf).replace(/\D/g, '')
  const notes = text(input.notes, current?.notes)
  const guardian = text(input.guardian, current?.guardian)
  if (name.length === 0) throw new ClinicValidationError('Informe o nome do paciente.')
  if (!isIsoDate(birthDate)) throw new ClinicValidationError('Data de nascimento inválida.')
  if (phone !== '' && !isValidPhone(phone)) throw new ClinicValidationError('Telefone inválido.')
  if (email !== '' && !isValidEmail(email)) throw new ClinicValidationError('E-mail inválido.')
  if (cpf !== '' && !isValidCpf(cpf)) throw new ClinicValidationError('CPF inválido.')
  if (isMinor(birthDate) && guardian.length === 0) {
    throw new ClinicValidationError('Paciente menor precisa do responsável legal.')
  }
  const notifyByEmail = input.notifyByEmail === undefined ? (current?.notifyByEmail ?? false) : input.notifyByEmail === true
  const notifyByPhone = input.notifyByPhone === undefined ? (current?.notifyByPhone ?? false) : input.notifyByPhone === true
  return {
    name,
    birthDate,
    phone,
    email,
    cpf,
    notes,
    guardian,
    notifyByEmail: notifyByEmail && isValidEmail(email),
    notifyByPhone: notifyByPhone && isValidPhone(phone),
  }
}

const patientColumns = `id, name, birth_date, phone, email, cpf, notes, guardian, notify_by_email, notify_by_phone`

export async function createPatient(
  database: Database,
  dentistId: string,
  input: PatientInput,
): Promise<PatientRecord> {
  const patient = parsePatient(input)
  const id = clientUuid((input as { id?: unknown }).id)
  const rows = await database.withDentist(dentistId, (tx) =>
    tx.query<PatientRow>(
      `INSERT INTO patients (
         id, dentist_id, name, birth_date, phone, email, cpf, notes, guardian, notify_by_email, notify_by_phone
       ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${patientColumns}`,
      [
        id,
        dentistId,
        patient.name,
        patient.birthDate,
        patient.phone,
        patient.email,
        patient.cpf,
        patient.notes,
        patient.guardian,
        patient.notifyByEmail,
        patient.notifyByPhone,
      ],
    ),
  )
  const row = rows[0]
  if (!row) throw new ClinicValidationError('Não foi possível gravar o paciente.')
  return toPatient(row)
}

export async function listPatients(
  database: Database,
  dentistId: string,
  options: {
    search: string
    limit: number
    offset: number
    locationId?: string
    withoutLocation?: boolean
  },
): Promise<PatientRecord[]> {
  const term = options.search.replace(/[\\%_]/g, '\\$&')
  const rows = await database.withDentist(dentistId, (tx) =>
    tx.query<PatientRow>(
      `SELECT ${patientColumns}
       FROM patients
       WHERE ($1 = '' OR name ILIKE $2 ESCAPE '\\')
         AND (
           $5::uuid IS NULL AND NOT $6::boolean
           OR ($6::boolean AND NOT EXISTS (
             SELECT 1 FROM patient_locations WHERE patient_locations.patient_id = patients.id
           ))
           OR EXISTS (
             SELECT 1 FROM patient_locations
             WHERE patient_locations.patient_id = patients.id
               AND patient_locations.location_id = $5::uuid
           )
         )
       ORDER BY lower(name), id
       LIMIT $3 OFFSET $4`,
      [options.search, `%${term}%`, options.limit, options.offset, options.locationId ?? null, options.withoutLocation === true],
    ),
  )
  return rows.map(toPatient)
}

export async function getPatient(
  database: Database,
  dentistId: string,
  patientId: string,
): Promise<PatientRecord | null> {
  const rows = await database.withDentist(dentistId, (tx) =>
    tx.query<PatientRow>(`SELECT ${patientColumns} FROM patients WHERE id = $1`, [patientId]),
  )
  return rows[0] ? toPatient(rows[0]) : null
}

export async function updatePatient(
  database: Database,
  dentistId: string,
  patientId: string,
  input: PatientInput,
): Promise<PatientRecord | null> {
  return database.withDentist(dentistId, async (tx) => {
    const currentRows = await tx.query<PatientRow>(
      `SELECT ${patientColumns} FROM patients WHERE id = $1 FOR UPDATE`,
      [patientId],
    )
    const current = currentRows[0]
    if (!current) return null
    const patient = parsePatient(input, toPatient(current))
    const rows = await tx.query<PatientRow>(
      `UPDATE patients
       SET name = $2, birth_date = $3, phone = $4, email = $5, cpf = $6, notes = $7,
           guardian = $8, notify_by_email = $9, notify_by_phone = $10
       WHERE id = $1
       RETURNING ${patientColumns}`,
      [
        patientId,
        patient.name,
        patient.birthDate,
        patient.phone,
        patient.email,
        patient.cpf,
        patient.notes,
        patient.guardian,
        patient.notifyByEmail,
        patient.notifyByPhone,
      ],
    )
    const saved = rows[0] ? toPatient(rows[0]) : null
    await revokeDisabledChannels(tx, patientId)
    return saved
  })
}

type PieceInput = {
  manufacturer?: unknown
  model?: unknown
  reference?: unknown
  size?: unknown
  lot?: unknown
  manufacturedOn?: unknown
  expiresOn?: unknown
  anvisa?: unknown
}

type GraftInput = PieceInput & {
  origin?: unknown
  processing?: unknown
  presentation?: unknown
  productType?: unknown
  granulometry?: unknown
  donorSite?: unknown
}

export type ProcedureInput = {
  id?: unknown
  modality?: unknown
  subtype?: unknown
  arch?: unknown
  surgeryDate?: unknown
  statusLabel?: unknown
  notes?: unknown
  associatedGraft?: unknown
  sinusLift?: unknown
  sinusLiftTechnique?: unknown
  sinusLiftNote?: unknown
  linkedProcedureIds?: unknown
  linkedImplantIds?: unknown
  sites?: unknown
  followUps?: unknown
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !isIsoDate(value)) throw new ClinicValidationError(`${label} inválida.`)
  return value
}

function pieceFrom(input: PieceInput | null | undefined): PieceInput | null {
  if (!input) return null
  return input
}

export async function createProcedure(
  database: Database,
  dentistId: string,
  patientId: string,
  input: ProcedureInput,
): Promise<Record<string, unknown> | null> {
  const modality = text(input.modality)
  const subtype = text(input.subtype) || null
  const arch = text(input.arch) || null
  const surgeryDate = text(input.surgeryDate)
  const statusLabel = text(input.statusLabel, 'planejado')
  const notes = text(input.notes)
  const sites = Array.isArray(input.sites) ? (input.sites as ToothSiteInput[]) : []
  if (!isIsoDate(surgeryDate)) throw new ClinicValidationError('Data da cirurgia inválida.')
  if (!statusesFor(modality).includes(statusLabel)) throw new ClinicValidationError('Status inválido para a modalidade.')
  assertProcedureShape({ modality, subtype, arch, sites })
  const sinusLift = input.sinusLift === true
  const sinusLiftTechnique = sinusLift ? text(input.sinusLiftTechnique) || null : null
  const sinusLiftNote = sinusLift ? text(input.sinusLiftNote) : ''
  if (sinusLift && !sinusLiftTechnique) throw new ClinicValidationError('Informe o tipo de levantamento de seio.')
  if (sinusLiftTechnique === 'outro' && sinusLiftNote.length === 0) {
    throw new ClinicValidationError('Descreva o tipo de levantamento de seio.')
  }

  const id = clientUuid(input.id)
  return database.withDentist(dentistId, async (tx) => {
    const patient = await tx.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [patientId])
    if (!patient[0]) return null
    const procedureRows = await tx.query<{ id: string }>(
      `INSERT INTO procedures (
         id, dentist_id, patient_id, modality, subtype, associated_graft, sinus_lift, sinus_lift_technique,
         sinus_lift_note, arch, surgery_date, status_label, notes
       ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        id,
        dentistId,
        patientId,
        modality,
        subtype,
        input.associatedGraft === true,
        sinusLift,
        sinusLiftTechnique,
        sinusLiftNote,
        arch,
        surgeryDate,
        statusLabel,
        notes,
      ],
    )
    const procedureId = procedureRows[0]?.id
    if (!procedureId) throw new ClinicValidationError('Não foi possível gravar o procedimento.')
    for (const site of sites) await insertSite(tx, dentistId, procedureId, site)
    for (const followUp of Array.isArray(input.followUps) ? input.followUps : []) {
      await insertFollowUp(tx, dentistId, procedureId, followUp as Record<string, unknown>)
    }
    if (modality === 'implante') {
      await insertProcedureRecordedImplants(tx, dentistId, patientId, procedureId, sites, surgeryDate)
    }
    if (modality === 'protese') {
      await insertImplantLinks(
        tx,
        dentistId,
        patientId,
        procedureId,
        input.linkedImplantIds,
        input.linkedProcedureIds,
      )
    } else if (Array.isArray(input.linkedProcedureIds) && input.linkedProcedureIds.length > 0) {
      // Mantém procedure_links legado para modalidades que ainda enviem vínculos antigos.
      for (const link of input.linkedProcedureIds) {
        const linkedId = clientUuid(link)
        if (!linkedId) throw new ClinicValidationError('Procedimento vinculado inválido.')
        const found = await tx.query(
          'SELECT id FROM procedures WHERE id = $1 AND deleted_at IS NULL',
          [linkedId],
        )
        if (!found[0]) throw new ClinicValidationError('Procedimento vinculado não encontrado.')
        await tx.query(
          `INSERT INTO procedure_links (dentist_id, procedure_id, linked_procedure_id) VALUES ($1, $2, $3)`,
          [dentistId, procedureId, linkedId],
        )
      }
    }
    return readProcedure(tx, procedureId)
  })
}

async function insertSite(
  tx: Queryable,
  dentistId: string,
  procedureId: string,
  site: ToothSiteInput,
): Promise<void> {
  const rows = await tx.query<{ id: string }>(
    `INSERT INTO tooth_sites (dentist_id, procedure_id, fdi, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [dentistId, procedureId, site.fdi, site.role],
  )
  const siteId = rows[0]?.id
  if (!siteId) throw new ClinicValidationError('Não foi possível gravar o dente.')
  const piece = pieceFrom(site.piece)
  if (piece) {
    await tx.query(
      `INSERT INTO implant_pieces (
         dentist_id, site_id, manufacturer, model, reference, size, lot, manufactured_on, expires_on, anvisa
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        dentistId,
        siteId,
        text(piece.manufacturer),
        text(piece.model),
        text(piece.reference),
        text(piece.size),
        text(piece.lot),
        optionalDate(piece.manufacturedOn, 'Fabricação'),
        optionalDate(piece.expiresOn, 'Validade'),
        text(piece.anvisa),
      ],
    )
  }
  for (const graft of site.grafts ?? []) await insertGraft(tx, dentistId, siteId, graft as GraftInput)
}

async function insertGraft(tx: Queryable, dentistId: string, siteId: string, graft: GraftInput): Promise<void> {
  const origin = text(graft.origin)
  if (origin !== 'biomaterial' && origin !== 'autogeno') {
    throw new ClinicValidationError('Origem do enxerto inválida.')
  }
  await tx.query(
    `INSERT INTO graft_materials (
       dentist_id, site_id, origin, processing, presentation, manufacturer, model, product_type,
       granulometry, size, lot, manufactured_on, expires_on, anvisa, donor_site
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      dentistId,
      siteId,
      origin,
      text(graft.processing) || null,
      text(graft.presentation) || null,
      text(graft.manufacturer),
      text(graft.model),
      text(graft.productType),
      text(graft.granulometry),
      text(graft.size),
      text(graft.lot),
      optionalDate(graft.manufacturedOn, 'Fabricação do enxerto'),
      optionalDate(graft.expiresOn, 'Validade do enxerto'),
      text(graft.anvisa),
      text(graft.donorSite),
    ],
  )
}

async function insertFollowUp(
  tx: Queryable,
  dentistId: string,
  procedureId: string,
  input: Record<string, unknown>,
): Promise<void> {
  const reason = text(input['reason'])
  const scheduledOn = text(input['scheduledOn'])
  if (!followUpReasons.includes(reason as (typeof followUpReasons)[number])) {
    throw new ClinicValidationError('Motivo do retorno inválido.')
  }
  if (!isIsoDate(scheduledOn)) throw new ClinicValidationError('Data do retorno inválida.')
  const days = Number(input['reminderDaysBefore'] ?? 15)
  if (!Number.isInteger(days) || days < 1) throw new ClinicValidationError('Antecedência do lembrete inválida.')
  await tx.query(
    `INSERT INTO follow_ups (
       id, dentist_id, procedure_id, scheduled_on, reason, status, reminder_enabled, reminder_days_before
     ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, 'agendado', $6, $7)`,
    [clientUuid(input['id']), dentistId, procedureId, scheduledOn, reason, input['reminderEnabled'] !== false, days],
  )
}

export async function getProcedure(
  database: Database,
  dentistId: string,
  procedureId: string,
): Promise<Record<string, unknown> | null> {
  return database.withDentist(dentistId, (tx) => readProcedure(tx, procedureId))
}

async function readProcedure(tx: Queryable, procedureId: string): Promise<Record<string, unknown> | null> {
  const procedures = await tx.query<Record<string, unknown>>(
    'SELECT * FROM procedures WHERE id = $1 AND deleted_at IS NULL',
    [procedureId],
  )
  const procedure = procedures[0]
  if (!procedure) return null
  const sites = await tx.query<Record<string, unknown>>(
    'SELECT * FROM tooth_sites WHERE procedure_id = $1 ORDER BY fdi',
    [procedureId],
  )
  const siteIds = sites.map((site) => site['id'])
  const pieces =
    siteIds.length === 0
      ? []
      : await tx.query<Record<string, unknown>>('SELECT * FROM implant_pieces WHERE site_id = ANY($1::uuid[])', [siteIds])
  const grafts =
    siteIds.length === 0
      ? []
      : await tx.query<Record<string, unknown>>('SELECT * FROM graft_materials WHERE site_id = ANY($1::uuid[])', [siteIds])
  const followUps = await tx.query<Record<string, unknown>>(
    'SELECT * FROM follow_ups WHERE procedure_id = $1 ORDER BY scheduled_on',
    [procedureId],
  )
  const visits = await tx.query<Record<string, unknown>>(
    'SELECT * FROM visits WHERE procedure_id = $1 ORDER BY visited_on DESC',
    [procedureId],
  )
  return {
    id: procedure['id'],
    patientId: procedure['patient_id'],
    modality: procedure['modality'],
    subtype: procedure['subtype'],
    arch: procedure['arch'],
    surgeryDate: dateOnly(procedure['surgery_date'] as string | Date),
    statusLabel: procedure['status_label'],
    notes: procedure['notes'],
    associatedGraft: procedure['associated_graft'],
    sinusLift: procedure['sinus_lift'],
    sinusLiftTechnique: procedure['sinus_lift_technique'],
    sinusLiftNote: procedure['sinus_lift_note'],
    sites: sites.map((site) => ({
      id: site['id'],
      fdi: site['fdi'],
      role: site['role'],
      piece: pieces.find((piece) => piece['site_id'] === site['id']) ?? null,
      grafts: grafts.filter((graft) => graft['site_id'] === site['id']),
    })),
    followUps,
    visits,
  }
}

export async function updateProcedureStatus(
  database: Database,
  dentistId: string,
  procedureId: string,
  statusLabel: string,
  notes: string | undefined,
  details?: {
    sites?: ToothSiteInput[]
    sinusLift?: boolean
    sinusLiftTechnique?: string | null
    sinusLiftNote?: string
    associatedGraft?: boolean
  },
): Promise<Record<string, unknown> | null> {
  return database.withDentist(dentistId, async (tx) => {
    const current = await tx.query<{
      modality: string
      subtype: string | null
      arch: string | null
      status_label: string
    }>('SELECT modality, subtype, arch, status_label FROM procedures WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [procedureId])
    const modality = current[0]?.modality
    const row = current[0]
    if (!modality || !row) return null
    if (!statusesFor(modality).includes(statusLabel)) throw new ClinicValidationError('Status inválido para a modalidade.')
    await tx.query(
      `UPDATE procedures SET status_label = $2, notes = COALESCE($3, notes) WHERE id = $1`,
      [procedureId, statusLabel, notes ?? null],
    )
    if (details?.associatedGraft !== undefined) {
      await tx.query('UPDATE procedures SET associated_graft = $2 WHERE id = $1', [procedureId, details.associatedGraft])
    }
    if (details?.sinusLift !== undefined) {
      const sinusLift = details.sinusLift
      const technique = sinusLift ? details.sinusLiftTechnique || null : null
      const note = sinusLift ? details.sinusLiftNote ?? '' : ''
      if (sinusLift && !technique) throw new ClinicValidationError('Informe o tipo de levantamento de seio.')
      if (technique === 'outro' && note.trim().length === 0) {
        throw new ClinicValidationError('Descreva o tipo de levantamento de seio.')
      }
      await tx.query(
        `UPDATE procedures SET sinus_lift = $2, sinus_lift_technique = $3, sinus_lift_note = $4 WHERE id = $1`,
        [procedureId, sinusLift, technique, note],
      )
    }
    if (details?.sites) {
      assertProcedureShape({
        modality,
        subtype: row.subtype,
        arch: row.arch,
        sites: details.sites,
      })
      await tx.query('DELETE FROM tooth_sites WHERE procedure_id = $1', [procedureId])
      for (const site of details.sites) await insertSite(tx, dentistId, procedureId, site)
    }
    await recordStageChange(tx, dentistId, procedureId, row.status_label, statusLabel)
    return readProcedure(tx, procedureId)
  })
}

export async function recordVisit(
  database: Database,
  dentistId: string,
  procedureId: string,
  input: { id?: unknown; date?: unknown; note?: unknown; statusLabel?: unknown },
): Promise<Record<string, unknown> | null> {
  const visitedOn = text(input.date)
  const note = text(input.note)
  const statusLabel = text(input.statusLabel)
  if (!isIsoDate(visitedOn)) throw new ClinicValidationError('Data da consulta inválida.')
  if (statusLabel.length === 0) throw new ClinicValidationError('Informe o status da consulta.')
  return database.withDentist(dentistId, async (tx) => {
    const current = await tx.query<{ modality: string; status_label: string }>(
      'SELECT modality, status_label FROM procedures WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [procedureId],
    )
    if (!current[0]) return null
    if (!statusesFor(current[0].modality).includes(statusLabel)) {
      throw new ClinicValidationError('Status inválido para a modalidade.')
    }
    await tx.query(
      `INSERT INTO visits (id, dentist_id, procedure_id, visited_on, note, status_label)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6)`,
      [clientUuid(input.id), dentistId, procedureId, visitedOn, note, statusLabel],
    )
    await tx.query('UPDATE procedures SET status_label = $2 WHERE id = $1', [procedureId, statusLabel])
    await recordStageChange(tx, dentistId, procedureId, current[0].status_label, statusLabel)
    return readProcedure(tx, procedureId)
  })
}

export async function updateFollowUp(
  database: Database,
  dentistId: string,
  followUpId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const status = text(input['status'])
  if (status !== '' && !['agendado', 'realizado', 'faltou'].includes(status)) {
    throw new ClinicValidationError('Status do retorno inválido.')
  }
  const scheduledOn = input['scheduledOn'] === undefined ? null : text(input['scheduledOn'])
  if (scheduledOn !== null && !isIsoDate(scheduledOn)) throw new ClinicValidationError('Data do retorno inválida.')
  return database.withDentist(dentistId, async (tx) => {
    const rows = await tx.query<Record<string, unknown>>(
      `UPDATE follow_ups
       SET status = COALESCE(NULLIF($2, ''), status),
           scheduled_on = COALESCE($3::date, scheduled_on),
           reminder_enabled = COALESCE($4, reminder_enabled)
       WHERE id = $1
         AND EXISTS (
           SELECT 1 FROM procedures p
           WHERE p.id = follow_ups.procedure_id AND p.deleted_at IS NULL
         )
       RETURNING *`,
      [followUpId, status, scheduledOn, typeof input['reminderEnabled'] === 'boolean' ? input['reminderEnabled'] : null],
    )
    return rows[0] ?? null
  })
}

/** L2S-73: soft delete — marca deleted_at; sem hard delete. */
export async function softDeleteProcedure(
  database: Database,
  dentistId: string,
  procedureId: string,
): Promise<boolean> {
  return database.withDentist(dentistId, async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `UPDATE procedures
       SET deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [procedureId],
    )
    return rows.length > 0
  })
}
