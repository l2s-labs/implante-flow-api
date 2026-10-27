import type { Database, Queryable } from '../db/database.js'

type Dated = string | Date

function dateOnly(value: Dated): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return value.slice(0, 10)
}

function appDate(value: Dated): string {
  return `${dateOnly(value)}T00:00:00.000`
}

function formatCro(cro: string, croUf: string): string {
  if (cro && croUf) return `${croUf} ${cro}`
  return cro
}

function noticeDelivery(statuses: string[]): 'falha' | 'aguardando' | 'revogada' | 'enviado' {
  if (statuses.includes('falha')) return 'falha'
  if (statuses.includes('aguardando')) return 'aguardando'
  if (statuses.includes('revogada')) return 'revogada'
  return 'enviado'
}

export async function readChart(database: Database, dentistId: string): Promise<Record<string, unknown>> {
  return database.withDentist(dentistId, (tx) => loadChart(tx))
}

async function loadChart(tx: Queryable): Promise<Record<string, unknown>> {
  const dentists = await tx.query<Record<string, unknown>>(
    `SELECT name, email, phone, cro, cro_uf, reminder_enabled, reminder_days_before, email_channel, push_channel
     FROM dentists`,
  )
  const dentist = dentists[0]
  if (!dentist) return { profile: null, patients: [], procedures: [] }
  const locations = await tx.query<Record<string, unknown>>(
    'SELECT id, name, address, active, is_default FROM care_locations ORDER BY name, id',
  )
  const patients = await tx.query<Record<string, unknown>>(
    `SELECT id, name, birth_date, phone, email, cpf, notes, guardian, notify_by_email, notify_by_phone
     FROM patients ORDER BY lower(name), id`,
  )
  const patientLocations = await tx.query<{ patient_id: string; location_id: string }>(
    'SELECT patient_id, location_id FROM patient_locations',
  )
  const procedures = await tx.query<Record<string, unknown>>(
    'SELECT * FROM procedures WHERE deleted_at IS NULL ORDER BY surgery_date DESC, id',
  )
  const procedureIds = procedures.map((procedure) => procedure['id'] as string)
  const sites =
    procedureIds.length === 0
      ? []
      : await tx.query<Record<string, unknown>>(
          'SELECT * FROM tooth_sites WHERE procedure_id = ANY($1::uuid[]) ORDER BY fdi',
          [procedureIds],
        )
  const siteIds = sites.map((site) => site['id'] as string)
  const pieces =
    siteIds.length === 0
      ? []
      : await tx.query<Record<string, unknown>>('SELECT * FROM implant_pieces WHERE site_id = ANY($1::uuid[])', [siteIds])
  const grafts =
    siteIds.length === 0
      ? []
      : await tx.query<Record<string, unknown>>('SELECT * FROM graft_materials WHERE site_id = ANY($1::uuid[])', [siteIds])
  const followUps =
    procedureIds.length === 0
      ? []
      : await tx.query<Record<string, unknown>>(
          'SELECT * FROM follow_ups WHERE procedure_id = ANY($1::uuid[]) ORDER BY scheduled_on, id',
          [procedureIds],
        )
  const visits =
    procedureIds.length === 0
      ? []
      : await tx.query<Record<string, unknown>>(
          'SELECT * FROM visits WHERE procedure_id = ANY($1::uuid[]) ORDER BY visited_on, id',
          [procedureIds],
        )
  const photos =
    procedureIds.length === 0
      ? []
      : await tx.query<Record<string, unknown>>(
          'SELECT id, procedure_id, visit_id, caption FROM photos WHERE procedure_id = ANY($1::uuid[]) ORDER BY created_at, id',
          [procedureIds],
        )
  const certificates =
    procedureIds.length === 0
      ? []
      : await tx.query<{ procedure_id: string; created_at: Dated }>(
          `SELECT DISTINCT ON (procedure_id) procedure_id, created_at
           FROM certificate_versions
           WHERE procedure_id = ANY($1::uuid[])
           ORDER BY procedure_id, version DESC`,
          [procedureIds],
        )
  const links =
    procedureIds.length === 0
      ? []
      : await tx.query<{ procedure_id: string; linked_procedure_id: string }>(
          'SELECT procedure_id, linked_procedure_id FROM procedure_links WHERE procedure_id = ANY($1::uuid[])',
          [procedureIds],
        )
  const implantLinks =
    procedureIds.length === 0
      ? []
      : await tx.query<{ procedure_id: string; implant_id: string }>(
          'SELECT procedure_id, implant_id FROM procedure_implant_links WHERE procedure_id = ANY($1::uuid[])',
          [procedureIds],
        )
  const implants = await tx.query<Record<string, unknown>>(
    `SELECT id, patient_id, fdi, origin, source_procedure_id, manufacturer, model, size, lot,
            installed_on, origin_clinic, notes, active
     FROM installed_implants
     ORDER BY active DESC, fdi, created_at, id`,
  )
  const notices =
    procedureIds.length === 0
      ? []
      : await tx.query<{
          id: string
          procedure_id: string
          stage_label: string
          created_at: Dated
          channels: string[]
          statuses: string[]
        }>(
          `SELECT events.id, events.procedure_id, events.stage_label, events.created_at,
                  array_agg(deliveries.channel ORDER BY deliveries.channel) AS channels,
                  array_agg(deliveries.status ORDER BY deliveries.channel) AS statuses
           FROM stage_notice_events events
           JOIN stage_notice_deliveries deliveries ON deliveries.event_id = events.id
           WHERE events.procedure_id = ANY($1::uuid[])
           GROUP BY events.id
           ORDER BY events.created_at, events.id`,
          [procedureIds],
        )

  const locationsOf = (patientId: string) =>
    patientLocations.filter((link) => link.patient_id === patientId).map((link) => link.location_id)

  const implantsOf = (patientId: string) =>
    implants
      .filter((implant) => implant['patient_id'] === patientId)
      .map((implant) => ({
        id: implant['id'],
        patientId: implant['patient_id'],
        fdi: implant['fdi'],
        origin: implant['origin'],
        sourceProcedureId: implant['source_procedure_id'],
        manufacturer: implant['manufacturer'],
        model: implant['model'],
        size: implant['size'],
        lot: implant['lot'],
        installedOn: implant['installed_on'] ? appDate(implant['installed_on'] as Dated) : null,
        originClinic: implant['origin_clinic'],
        notes: implant['notes'],
        active: implant['active'],
      }))

  return {
    profile: {
      name: dentist['name'],
      email: dentist['email'],
      phone: dentist['phone'],
      cro: formatCro(String(dentist['cro'] ?? ''), String(dentist['cro_uf'] ?? '')),
      reminderEnabled: dentist['reminder_enabled'],
      reminderDaysBefore: dentist['reminder_days_before'],
      emailChannel: dentist['email_channel'],
      pushChannel: dentist['push_channel'],
      locations: locations.map((location) => ({
        id: location['id'],
        name: location['name'],
        address: location['address'],
        active: location['active'],
        isDefault: location['is_default'],
      })),
    },
    patients: patients.map((patient) => ({
      id: patient['id'],
      name: patient['name'],
      phone: patient['phone'],
      email: patient['email'],
      cpf: patient['cpf'],
      locationIds: locationsOf(patient['id'] as string),
      notifyByEmail: patient['notify_by_email'],
      notifyByPhone: patient['notify_by_phone'],
      birthDate: appDate(patient['birth_date'] as Dated),
      notes: patient['notes'],
      guardian: patient['guardian'],
      implants: implantsOf(patient['id'] as string),
    })),
    procedures: procedures.map((procedure) => {
      const procedureId = procedure['id'] as string
      const procedureSites = sites.filter((site) => site['procedure_id'] === procedureId)
      const issued = certificates.find((certificate) => certificate.procedure_id === procedureId)
      const linkedImplantIds = implantLinks
        .filter((link) => link.procedure_id === procedureId)
        .map((link) => link.implant_id)
      const linkedFromImplants = linkedImplantIds
        .map((implantId) => implants.find((implant) => implant['id'] === implantId)?.['source_procedure_id'])
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
      const legacyLinks = links
        .filter((link) => link.procedure_id === procedureId)
        .map((link) => link.linked_procedure_id)
      return {
        id: procedureId,
        patientId: procedure['patient_id'],
        modality: procedure['modality'],
        subtype: procedure['subtype'],
        associatedGraft: procedure['associated_graft'],
        sinusLift: procedure['sinus_lift'],
        sinusLiftTechnique: procedure['sinus_lift_technique'],
        sinusLiftNote: procedure['sinus_lift_note'],
        linkedImplantIds,
        linkedProcedureIds: [...new Set([...legacyLinks, ...linkedFromImplants])],
        arch: procedure['arch'],
        surgeryDate: appDate(procedure['surgery_date'] as Dated),
        statusLabel: procedure['status_label'],
        notes: procedure['notes'],
        certificateIssuedAt: issued ? appDate(issued.created_at) : null,
        certificatePdfPath: null,
        sites: procedureSites.map((site) => {
          const piece = pieces.find((item) => item['site_id'] === site['id'])
          return {
            fdi: site['fdi'],
            role: site['role'],
            piece: piece
              ? {
                  manufacturer: piece['manufacturer'],
                  model: piece['model'],
                  reference: piece['reference'] ?? '',
                  size: piece['size'],
                  lot: piece['lot'],
                  manufacturedOn: piece['manufactured_on'] ? appDate(piece['manufactured_on'] as Dated) : null,
                  expiresOn: piece['expires_on'] ? appDate(piece['expires_on'] as Dated) : null,
                  anvisa: piece['anvisa'],
                }
              : null,
            grafts: grafts
              .filter((graft) => graft['site_id'] === site['id'])
              .map((graft) => ({
                origin: graft['origin'],
                processing: graft['processing'],
                presentation: graft['presentation'],
                manufacturer: graft['manufacturer'],
                model: graft['model'],
                productType: graft['product_type'],
                granulometry: graft['granulometry'],
                size: graft['size'],
                lot: graft['lot'],
                manufacturedOn: graft['manufactured_on'] ? appDate(graft['manufactured_on'] as Dated) : null,
                expiresOn: graft['expires_on'] ? appDate(graft['expires_on'] as Dated) : null,
                anvisa: graft['anvisa'],
                donorSite: graft['donor_site'],
              })),
          }
        }),
        visits: visits
          .filter((visit) => visit['procedure_id'] === procedureId)
          .map((visit) => ({
            id: visit['id'],
            date: appDate(visit['visited_on'] as Dated),
            note: visit['note'],
            statusLabel: visit['status_label'],
          })),
        followUps: followUps
          .filter((followUp) => followUp['procedure_id'] === procedureId)
          .map((followUp) => ({
            id: followUp['id'],
            date: appDate(followUp['scheduled_on'] as Dated),
            reason: followUp['reason'],
            status: followUp['status'],
            reminderEnabled: followUp['reminder_enabled'],
            reminderDaysBefore: followUp['reminder_days_before'],
            overdueNotified: followUp['overdue_notified'],
          })),
        photos: photos
          .filter((photo) => photo['procedure_id'] === procedureId)
          .map((photo) => ({
            id: photo['id'],
            caption: photo['caption'],
            path: '',
            visitId: photo['visit_id'],
          })),
        stageNotices: notices
          .filter((notice) => notice.procedure_id === procedureId)
          .map((notice) => ({
            id: notice.id,
            stageLabel: notice.stage_label,
            channels: [...new Set(notice.channels)],
            delivery: noticeDelivery(notice.statuses),
            createdAt: notice.created_at instanceof Date ? notice.created_at.toISOString() : notice.created_at,
          })),
      }
    }),
  }
}
