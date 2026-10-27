import type { Database, Queryable } from '../db/database.js'

export type NoticeSender = (input: {
  channel: 'email' | 'phone'
  destination: string
  body: string
}) => Promise<void>

const stageMessage = (stage: string) =>
  `Há uma atualização na etapa do atendimento: ${stage}. A mensagem não traz detalhes clínicos.`

export async function recordStageChange(
  tx: Queryable,
  dentistId: string,
  procedureId: string,
  previousStatus: string,
  nextStatus: string,
): Promise<void> {
  if (previousStatus === nextStatus) return
  const patients = await tx.query<{
    id: string
    email: string
    phone: string
    notify_by_email: boolean
    notify_by_phone: boolean
  }>(
    `SELECT patients.id, patients.email, patients.phone, patients.notify_by_email, patients.notify_by_phone
     FROM procedures
     JOIN patients ON patients.id = procedures.patient_id AND patients.dentist_id = procedures.dentist_id
     WHERE procedures.id = $1 AND procedures.deleted_at IS NULL`,
    [procedureId],
  )
  const patient = patients[0]
  if (!patient) return
  const channels = [
    ...(patient.notify_by_email && patient.email ? ['email' as const] : []),
    ...(patient.notify_by_phone && patient.phone ? ['phone' as const] : []),
  ]
  if (channels.length === 0) return
  const events = await tx.query<{ id: string }>(
    `INSERT INTO stage_notice_events (dentist_id, patient_id, procedure_id, stage_label)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [dentistId, patient.id, procedureId, nextStatus],
  )
  const eventId = events[0]?.id
  if (!eventId) return
  for (const channel of channels) {
    await tx.query(
      `INSERT INTO stage_notice_deliveries (event_id, dentist_id, patient_id, channel, status)
       VALUES ($1, $2, $3, $4, 'aguardando')`,
      [eventId, dentistId, patient.id, channel],
    )
  }
}

export async function revokeDisabledChannels(tx: Queryable, patientId: string): Promise<void> {
  await tx.query(
    `UPDATE stage_notice_deliveries
     SET status = 'revogada'
     WHERE patient_id = $1
       AND status = 'aguardando'
       AND (
         (channel = 'email' AND NOT EXISTS (
           SELECT 1 FROM patients WHERE id = $1 AND notify_by_email AND email <> ''
         ))
         OR (channel = 'phone' AND NOT EXISTS (
           SELECT 1 FROM patients WHERE id = $1 AND notify_by_phone AND phone <> ''
         ))
       )`,
    [patientId],
  )
}

export async function processStageNotices(database: Database, sender: NoticeSender): Promise<number> {
  const pending = await database.query<{ id: string; dentist_id: string }>(
    `SELECT id, dentist_id FROM stage_notice_deliveries WHERE status = 'aguardando' ORDER BY id`,
  )
  let sent = 0
  for (const item of pending) {
    const delivered = await database.withDentist(item.dentist_id, async (tx) => {
      const rows = await tx.query<{
        id: string
        channel: 'email' | 'phone'
        stage_label: string
        email: string
        phone: string
        notify_by_email: boolean
        notify_by_phone: boolean
        status: string
      }>(
        `SELECT deliveries.id, deliveries.channel, deliveries.status, events.stage_label,
                patients.email, patients.phone, patients.notify_by_email, patients.notify_by_phone
         FROM stage_notice_deliveries deliveries
         JOIN stage_notice_events events ON events.id = deliveries.event_id
         JOIN patients ON patients.id = deliveries.patient_id
         WHERE deliveries.id = $1
         FOR UPDATE`,
        [item.id],
      )
      const delivery = rows[0]
      if (!delivery || delivery.status !== 'aguardando') return false
      const allowed = delivery.channel === 'email' ? delivery.notify_by_email && delivery.email : delivery.notify_by_phone && delivery.phone
      if (!allowed) {
        await tx.query(`UPDATE stage_notice_deliveries SET status = 'revogada' WHERE id = $1`, [delivery.id])
        return false
      }
      const destination = delivery.channel === 'email' ? delivery.email : delivery.phone
      try {
        await sender({ channel: delivery.channel, destination, body: stageMessage(delivery.stage_label) })
      } catch {
        await tx.query(
          `UPDATE stage_notice_deliveries SET status = 'falha', attempts = attempts + 1 WHERE id = $1`,
          [delivery.id],
        )
        return false
      }
      await tx.query(
        `UPDATE stage_notice_deliveries SET status = 'enviado', attempts = attempts + 1 WHERE id = $1`,
        [delivery.id],
      )
      return true
    })
    if (delivered) sent += 1
  }
  return sent
}

export async function reprocessNotice(database: Database, dentistId: string, deliveryId: string): Promise<boolean> {
  const rows = await database.withDentist(dentistId, (tx) =>
    tx.query(
      `UPDATE stage_notice_deliveries SET status = 'aguardando' WHERE id = $1 AND status = 'falha' RETURNING id`,
      [deliveryId],
    ),
  )
  return rows.length === 1
}
