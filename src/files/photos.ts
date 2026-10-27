import { randomUUID } from 'node:crypto'
import type { Database } from '../db/database.js'
import { ClinicValidationError } from '../clinic/rules.js'
import { maxPhotoBytes, photoContentTypes, presignSeconds, type ObjectStore } from './object-store.js'

export async function createPhotoUpload(
  database: Database,
  store: ObjectStore,
  dentistId: string,
  procedureId: string,
  input: { contentType?: unknown; byteSize?: unknown; caption?: unknown; visitId?: unknown },
): Promise<{ photoId: string; uploadUrl: string; expiresIn: number } | null> {
  const contentType = typeof input.contentType === 'string' ? input.contentType : ''
  const byteSize = input.byteSize
  const caption = typeof input.caption === 'string' ? input.caption.trim() : ''
  const visitId = typeof input.visitId === 'string' ? input.visitId : null
  if (!photoContentTypes.includes(contentType as (typeof photoContentTypes)[number])) {
    throw new ClinicValidationError('A foto precisa ser JPEG, PNG ou WebP.')
  }
  if (typeof byteSize !== 'number' || !Number.isInteger(byteSize) || byteSize < 1 || byteSize > maxPhotoBytes) {
    throw new ClinicValidationError('A foto passa do tamanho permitido.')
  }
  const photoId = randomUUID()
  const key = `dentists/${dentistId}/procedures/${procedureId}/photos/${photoId}`
  return database.withDentist(dentistId, async (tx) => {
    const procedure = await tx.query(
      'SELECT id FROM procedures WHERE id = $1 AND deleted_at IS NULL',
      [procedureId],
    )
    if (!procedure[0]) return null
    if (visitId) {
      const visit = await tx.query('SELECT id FROM visits WHERE id = $1 AND procedure_id = $2', [visitId, procedureId])
      if (!visit[0]) throw new ClinicValidationError('Consulta da foto não encontrada.')
    }
    await tx.query(
      `INSERT INTO photos (id, dentist_id, procedure_id, visit_id, caption, object_key, content_type, byte_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [photoId, dentistId, procedureId, visitId, caption, key, contentType, byteSize],
    )
    const uploadUrl = await store.presignPut({ key, contentType, byteSize })
    return { photoId, uploadUrl, expiresIn: presignSeconds }
  })
}

export async function readPhotoUrl(
  database: Database,
  store: ObjectStore,
  dentistId: string,
  photoId: string,
): Promise<{ url: string; expiresIn: number } | null> {
  const rows = await database.withDentist(dentistId, (tx) =>
    tx.query<{ object_key: string }>('SELECT object_key FROM photos WHERE id = $1', [photoId]),
  )
  const key = rows[0]?.object_key
  if (!key || !key.startsWith(`dentists/${dentistId}/`)) return null
  return { url: await store.presignGet(key), expiresIn: presignSeconds }
}
