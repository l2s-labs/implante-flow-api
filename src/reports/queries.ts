import type { Database } from '../db/database.js'
import { ClinicValidationError } from '../clinic/rules.js'

export type ReportScope = {
  from: string
  to: string
  today: string
  modality: string
  patientId: string | null
  search: string
  status: string
  limit: number
  offset: number
}

type Summary = {
  today: string
  onTimePatients: number
  missedPatients: number
  overduePatients: number
  upcomingAppointments: number
  completedAppointments: number
  missedAppointments: number
  withoutOutcome: number
  attendancePercent: number | null
}

const appointmentJson = `json_build_object(
  'followUpId', follow_ups.id,
  'procedureId', follow_ups.procedure_id,
  'scheduledOn', to_char(follow_ups.scheduled_on, 'YYYY-MM-DD'),
  'reason', follow_ups.reason,
  'status', follow_ups.status,
  'modality', procedures.modality
)`

export function brasiliaDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function parseReportScope(
  input: Record<string, unknown>,
  today: string,
  options: { period: 'required' | 'optional' },
): ReportScope {
  const horizon = text(input['horizon'])
  let from = text(input['from'])
  let to = text(input['to'])
  if (horizon === 'today') {
    from = today
    to = today
  } else if (horizon === 'week') {
    from = today
    to = addDays(today, 6)
  } else if (horizon === 'month') {
    from = today
    to = addDays(today, 29)
  } else if (horizon !== '' && horizon !== 'custom') {
    throw new ClinicValidationError('Período do relatório inválido.')
  }
  if ((from === '') !== (to === '')) throw new ClinicValidationError('Informe o início e o fim do período.')
  if (options.period === 'required' && from === '') throw new ClinicValidationError('Informe o período.')
  if (from !== '' && (!isIsoDate(from) || !isIsoDate(to) || from > to)) {
    throw new ClinicValidationError('Período do relatório inválido.')
  }
  const modality = text(input['modality'])
  if (modality !== '' && !['implante', 'enxerto', 'protese'].includes(modality)) {
    throw new ClinicValidationError('Modalidade inválida.')
  }
  const status = text(input['status'])
  if (status !== '' && !['agendado', 'realizado', 'faltou'].includes(status)) {
    throw new ClinicValidationError('Status do retorno inválido.')
  }
  const limit = input['limit'] === undefined ? 50 : Number(input['limit'])
  const offset = input['offset'] === undefined ? 0 : Number(input['offset'])
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ClinicValidationError('Limite inválido.')
  if (!Number.isInteger(offset) || offset < 0) throw new ClinicValidationError('Deslocamento inválido.')
  const patientId = text(input['patientId'])
  if (patientId !== '' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(patientId)) {
    throw new ClinicValidationError('Paciente inválido.')
  }
  return {
    from,
    to,
    today,
    modality,
    patientId: patientId === '' ? null : patientId,
    search: text(input['q']),
    status,
    limit,
    offset,
  }
}

export async function reportSummary(database: Database, dentistId: string, scope: ReportScope): Promise<Summary> {
  const rows = await database.withDentist(dentistId, (tx) =>
    tx.query<Record<string, unknown>>(
      `SELECT
         (SELECT count(*) FROM patients
          WHERE ${patientPredicate()}
            AND NOT EXISTS (
              SELECT 1 FROM follow_ups
              JOIN procedures ON procedures.id = follow_ups.procedure_id AND procedures.deleted_at IS NULL
              WHERE procedures.patient_id = patients.id
                AND follow_ups.status = 'agendado'
                AND follow_ups.scheduled_on < $1::date
                AND ($4 = '' OR procedures.modality = $4)
            )) AS on_time_patients,
         (SELECT count(DISTINCT patients.id) ${appointmentFrom()}
          AND follow_ups.status = 'faltou'
          AND follow_ups.scheduled_on BETWEEN $2::date AND $3::date) AS missed_patients,
         (SELECT count(DISTINCT patients.id) ${appointmentFrom()}
          AND follow_ups.status = 'agendado'
          AND follow_ups.scheduled_on < $1::date
          AND follow_ups.scheduled_on BETWEEN $2::date AND $3::date) AS overdue_patients,
         (SELECT count(*) ${appointmentFrom()}
          AND follow_ups.status = 'agendado'
          AND follow_ups.scheduled_on >= $1::date
          AND follow_ups.scheduled_on BETWEEN $2::date AND $3::date) AS upcoming_appointments,
         (SELECT count(*) ${appointmentFrom()}
          AND follow_ups.status = 'realizado'
          AND follow_ups.scheduled_on BETWEEN $2::date AND $3::date) AS completed_appointments,
         (SELECT count(*) ${appointmentFrom()}
          AND follow_ups.status = 'faltou'
          AND follow_ups.scheduled_on BETWEEN $2::date AND $3::date) AS missed_appointments,
         (SELECT count(*) ${appointmentFrom()}
          AND follow_ups.status = 'agendado'
          AND follow_ups.scheduled_on BETWEEN $2::date AND $3::date) AS without_outcome`,
      params(scope).slice(0, 7),
    ),
  )
  const row = rows[0] ?? {}
  const completed = numberOf(row['completed_appointments'])
  const missed = numberOf(row['missed_appointments'])
  const withOutcome = completed + missed
  return {
    today: scope.today,
    onTimePatients: numberOf(row['on_time_patients']),
    missedPatients: numberOf(row['missed_patients']),
    overduePatients: numberOf(row['overdue_patients']),
    upcomingAppointments: numberOf(row['upcoming_appointments']),
    completedAppointments: completed,
    missedAppointments: missed,
    withoutOutcome: numberOf(row['without_outcome']),
    attendancePercent: withOutcome === 0 ? null : Math.round((completed * 100) / withOutcome),
  }
}

export async function reportPatients(
  database: Database,
  dentistId: string,
  kind: 'onTime' | 'missed' | 'overdue',
  scope: ReportScope,
): Promise<Record<string, unknown>[]> {
  const match =
    kind === 'onTime'
      ? `follow_ups.status = 'agendado' AND follow_ups.scheduled_on >= $1::date`
      : kind === 'missed'
        ? `follow_ups.status = 'faltou' AND follow_ups.scheduled_on BETWEEN $2::date AND $3::date`
        : `follow_ups.status = 'agendado' AND follow_ups.scheduled_on < $1::date
           AND ($2::date IS NULL OR follow_ups.scheduled_on BETWEEN $2::date AND $3::date)`
  const sql =
    kind === 'onTime'
      ? `SELECT patients.id AS "patientId", patients.name,
                COALESCE(json_agg(${appointmentJson} ORDER BY follow_ups.scheduled_on) FILTER (WHERE follow_ups.id IS NOT NULL), '[]'::json) AS appointments
         FROM patients
         LEFT JOIN procedures ON procedures.patient_id = patients.id AND procedures.deleted_at IS NULL AND ($4 = '' OR procedures.modality = $4)
         LEFT JOIN follow_ups ON follow_ups.procedure_id = procedures.id AND ${match}
         WHERE ${patientPredicate()}
           AND ($4 = '' OR EXISTS (SELECT 1 FROM procedures modality_procedure WHERE modality_procedure.patient_id = patients.id AND modality_procedure.deleted_at IS NULL AND modality_procedure.modality = $4))
           AND NOT EXISTS (
             SELECT 1 FROM follow_ups overdue
             JOIN procedures overdue_procedure ON overdue_procedure.id = overdue.procedure_id AND overdue_procedure.deleted_at IS NULL
             WHERE overdue_procedure.patient_id = patients.id
               AND overdue.status = 'agendado'
               AND overdue.scheduled_on < $1::date
               AND ($4 = '' OR overdue_procedure.modality = $4)
           )
         GROUP BY patients.id
         ORDER BY lower(patients.name), patients.id
         LIMIT $8 OFFSET $9`
      : `SELECT patients.id AS "patientId", patients.name,
                count(follow_ups.id)::int AS "appointmentCount",
                COALESCE(json_agg(${appointmentJson} ORDER BY follow_ups.scheduled_on) FILTER (WHERE follow_ups.id IS NOT NULL), '[]'::json) AS appointments
         FROM patients
         JOIN procedures ON procedures.patient_id = patients.id AND procedures.deleted_at IS NULL
         JOIN follow_ups ON follow_ups.procedure_id = procedures.id AND ${match}
         WHERE ${patientPredicate()}
           AND $1::date IS NOT NULL
           AND ($4 = '' OR procedures.modality = $4)
           AND ($10 = '' OR follow_ups.status = $10)
         GROUP BY patients.id
         ORDER BY lower(patients.name), patients.id
         LIMIT $8 OFFSET $9`
  return database.withDentist(dentistId, (tx) => tx.query(sql, params(scope)))
}

export async function reportAppointments(
  database: Database,
  dentistId: string,
  kind: 'upcoming' | 'completed' | 'missed' | 'overdue',
  scope: ReportScope,
): Promise<Record<string, unknown>[]> {
  const match =
    kind === 'upcoming'
      ? `follow_ups.status = 'agendado' AND follow_ups.scheduled_on >= $1::date AND follow_ups.scheduled_on BETWEEN $2::date AND $3::date`
      : kind === 'completed'
        ? `follow_ups.status = 'realizado' AND follow_ups.scheduled_on BETWEEN $2::date AND $3::date`
        : kind === 'missed'
          ? `follow_ups.status = 'faltou' AND follow_ups.scheduled_on BETWEEN $2::date AND $3::date`
          : `follow_ups.status = 'agendado' AND follow_ups.scheduled_on < $1::date AND ($2::date IS NULL OR follow_ups.scheduled_on BETWEEN $2::date AND $3::date)`
  return database.withDentist(dentistId, (tx) =>
    tx.query(
      `SELECT follow_ups.id AS "followUpId", follow_ups.procedure_id AS "procedureId",
              patients.id AS "patientId", patients.name AS "patientName",
              to_char(follow_ups.scheduled_on, 'YYYY-MM-DD') AS "scheduledOn",
              follow_ups.reason, follow_ups.status, procedures.modality
       ${appointmentFrom()}
         AND ${match}
         AND ($10 = '' OR follow_ups.status = $10)
       ORDER BY follow_ups.scheduled_on, patients.name, follow_ups.id
       LIMIT $8 OFFSET $9`,
      params(scope),
    ),
  )
}

function appointmentFrom(): string {
  return `FROM patients
          JOIN procedures ON procedures.patient_id = patients.id AND procedures.deleted_at IS NULL
          JOIN follow_ups ON follow_ups.procedure_id = procedures.id
          WHERE ${patientPredicate()}
            AND $1::date IS NOT NULL
            AND ($4 = '' OR procedures.modality = $4)`
}

function patientPredicate(): string {
  return `($6 = '' OR patients.name ILIKE $7 ESCAPE '\\') AND ($5::uuid IS NULL OR patients.id = $5::uuid)`
}

function params(scope: ReportScope): unknown[] {
  const term = scope.search.replace(/[\\%_]/g, '\\$&')
  return [
    scope.today,
    scope.from === '' ? null : scope.from,
    scope.to === '' ? null : scope.to,
    scope.modality,
    scope.patientId,
    scope.search,
    `%${term}%`,
    scope.limit,
    scope.offset,
    scope.status,
  ]
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function numberOf(value: unknown): number {
  return Number(value ?? 0)
}
