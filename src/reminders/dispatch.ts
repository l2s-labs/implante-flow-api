import type { Database, Queryable } from '../db/database.js'

export type ReminderNotifier = (input: {
  channel: 'email' | 'push'
  destination: string
  body: string
}) => Promise<void>

const reasonLabel: Record<string, string> = {
  sutura: 'sutura',
  osseointegracao: 'osseointegração',
  instalarImplante: 'instalar implante',
  instalarPonte: 'instalar ponte',
  instalarProtocolo: 'instalar protocolo',
  controle: 'controle',
  reabertura: 'reabertura',
}

type DueFollowUp = {
  id: string
  dentist_id: string
  scheduled_on: string
  reason: string
  reminder_days_before: number
  patient_name: string
  arch: string
  email: string
  email_channel: boolean
  push_channel: boolean
  teeth: string
}

export function brasiliaDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.slice(0, 10).split('-').map(Number)
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function message(row: DueFollowUp, kind: 'lead' | 'overdue'): string {
  const teeth = row.teeth.split(',').filter(Boolean)
  const place = teeth.length > 0 ? `dente ${teeth.join(', ')}` : row.arch ? `arcada ${row.arch}` : 'retorno'
  const prefix = kind === 'overdue' ? 'Retorno atrasado' : 'Lembrete de retorno'
  return `${prefix}: ${row.patient_name}, ${place}, motivo ${reasonLabel[row.reason] ?? row.reason}.`
}

export async function processDentistReminders(
  database: Database,
  notifier: ReminderNotifier,
  now = new Date(),
): Promise<number> {
  const today = brasiliaDate(now)
  const due = await database.query<DueFollowUp>(
    `SELECT follow_ups.id, follow_ups.dentist_id, follow_ups.scheduled_on::text AS scheduled_on,
            follow_ups.reason, follow_ups.reminder_days_before, patients.name AS patient_name,
            COALESCE(procedures.arch, '') AS arch, dentists.email, dentists.email_channel, dentists.push_channel,
            COALESCE(string_agg(tooth_sites.fdi::text, ',' ORDER BY tooth_sites.fdi), '') AS teeth
     FROM follow_ups
     JOIN procedures ON procedures.id = follow_ups.procedure_id
     JOIN patients ON patients.id = procedures.patient_id
     JOIN dentists ON dentists.id = follow_ups.dentist_id
     LEFT JOIN tooth_sites ON tooth_sites.procedure_id = procedures.id
     WHERE follow_ups.status = 'agendado'
       AND follow_ups.reminder_enabled
       AND dentists.reminder_enabled
       AND procedures.deleted_at IS NULL
     GROUP BY follow_ups.id, patients.id, procedures.id, dentists.id`,
  )
  let sent = 0
  for (const row of due) {
    const scheduled = row.scheduled_on.slice(0, 10)
    const kinds: Array<'lead' | 'overdue'> = []
    if (today >= addDays(scheduled, -Number(row.reminder_days_before)) && today <= scheduled) kinds.push('lead')
    if (today >= addDays(scheduled, 1)) kinds.push('overdue')
    const channels: Array<'email' | 'push'> = []
    if (row.email_channel && row.email) channels.push('email')
    if (row.push_channel) channels.push('push')
    for (const kind of kinds) {
      for (const channel of channels) {
        const delivered = await database.withDentist(row.dentist_id, (tx) =>
          deliver(tx, notifier, row, kind, channel, kind === 'lead' ? addDays(scheduled, -Number(row.reminder_days_before)) : addDays(scheduled, 1)),
        )
        if (delivered) sent += 1
      }
    }
  }
  return sent
}

async function deliver(
  tx: Queryable,
  notifier: ReminderNotifier,
  row: DueFollowUp,
  kind: 'lead' | 'overdue',
  channel: 'email' | 'push',
  scheduledFor: string,
): Promise<boolean> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO reminder_dispatches (dentist_id, follow_up_id, kind, channel, scheduled_for, status)
     VALUES ($1, $2, $3, $4, $5, 'aguardando')
     ON CONFLICT (follow_up_id, kind, channel) DO NOTHING
     RETURNING id`,
    [row.dentist_id, row.id, kind, channel, scheduledFor],
  )
  let dispatchId = inserted[0]?.id
  if (!dispatchId) {
    const existing = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM reminder_dispatches WHERE follow_up_id = $1 AND kind = $2 AND channel = $3`,
      [row.id, kind, channel],
    )
    if (!existing[0] || existing[0].status === 'enviado') return false
    dispatchId = existing[0].id
  }
  const destination = channel === 'email' ? row.email : `dentist:${row.dentist_id}`
  try {
    await notifier({ channel, destination, body: message(row, kind) })
  } catch {
    await tx.query(`UPDATE reminder_dispatches SET status = 'falha', attempts = attempts + 1 WHERE id = $1`, [dispatchId])
    return false
  }
  await tx.query(`UPDATE reminder_dispatches SET status = 'enviado', attempts = attempts + 1 WHERE id = $1`, [dispatchId])
  if (kind === 'overdue') {
    await tx.query(`UPDATE follow_ups SET overdue_notified = true WHERE id = $1`, [row.id])
  }
  return true
}
