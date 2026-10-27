import { createHash } from 'node:crypto'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { Database, Queryable } from '../db/database.js'
import { ClinicValidationError, clientUuid } from '../clinic/rules.js'
import type { ObjectStore } from '../files/object-store.js'

export type DocumentSigner = (pdf: Uint8Array) => Promise<{ pdf: Uint8Array; signed: boolean } | null>

export type IssueCertificateInput = {
  copies?: unknown
  locationId?: unknown
}

export type IssuedCertificate = {
  version: number
  sha256: string
  signed: boolean
  downloadUrl: string
  copies: number
  location: { id: string; name: string; address: string } | null
}

type SiteRow = {
  id: string
  fdi: number
  role: string
}

type PieceRow = {
  site_id: string
  manufacturer: string
  model: string
  size: string
  manufactured_on: string | Date | null
  expires_on: string | Date | null
}

type GraftRow = {
  site_id: string
  origin: string
  manufacturer: string
  model: string
  lot: string
  expires_on: string | Date | null
  donor_site: string
}

type LocationSnapshot = {
  id: string
  name: string
  address: string
}

function day(value: string | Date | null): string {
  if (!value) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function parseCopies(value: unknown): 1 | 2 {
  if (value === undefined || value === null || value === '') return 1
  const copies = typeof value === 'number' ? value : Number(value)
  if (copies === 1 || copies === 2) return copies
  throw new ClinicValidationError('Quantidade de vias inválida.', 'CERTIFICATE_COPIES_INVALID')
}

export async function issueCertificate(
  database: Database,
  store: ObjectStore,
  dentistId: string,
  procedureId: string,
  input: IssueCertificateInput = {},
  signer?: DocumentSigner,
): Promise<IssuedCertificate | null> {
  const copies = parseCopies(input.copies)
  const requestedLocationId = clientUuid(input.locationId)

  return database.withDentist(dentistId, async (tx) => {
    const procedures = await tx.query<{
      patient_id: string
      modality: string
      surgery_date: string | Date
      patient_name: string
      birth_date: string | Date
      guardian: string
      cro: string
      cro_uf: string
      dentist_name: string
      dentist_phone: string
    }>(
      `SELECT procedures.patient_id, procedures.modality, procedures.surgery_date, patients.name AS patient_name,
              patients.birth_date, patients.guardian, dentists.cro, dentists.cro_uf, dentists.name AS dentist_name,
              dentists.phone AS dentist_phone
       FROM procedures
       JOIN patients ON patients.id = procedures.patient_id
       JOIN dentists ON dentists.id = procedures.dentist_id
       WHERE procedures.id = $1 AND procedures.deleted_at IS NULL
       FOR UPDATE`,
      [procedureId],
    )
    const procedure = procedures[0]
    if (!procedure) return null
    const sites = await tx.query<SiteRow>('SELECT id, fdi, role FROM tooth_sites WHERE procedure_id = $1 ORDER BY fdi', [
      procedureId,
    ])
    const siteIds = sites.map((site) => site.id)
    const pieces =
      siteIds.length === 0
        ? []
        : await tx.query<PieceRow>(
            `SELECT site_id, manufacturer, model, size, manufactured_on, expires_on
             FROM implant_pieces WHERE site_id = ANY($1::uuid[])`,
            [siteIds],
          )
    const grafts =
      siteIds.length === 0
        ? []
        : await tx.query<GraftRow>(
            `SELECT site_id, origin, manufacturer, model, lot, expires_on, donor_site
             FROM graft_materials WHERE site_id = ANY($1::uuid[])`,
            [siteIds],
          )

    assertCertificateReady(procedure, sites, pieces, grafts)

    const location = await resolveAttendanceLocation(
      tx,
      procedure.patient_id,
      requestedLocationId,
    )

    const original = await renderCertificatePdf(procedure, sites, pieces, grafts, location, copies)
    const signed = signer ? await signer(original) : null
    const bytes = signed?.pdf ?? original
    const isSigned = signed?.signed === true
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const versions = await tx.query<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM certificate_versions WHERE procedure_id = $1',
      [procedureId],
    )
    const version = versions[0]?.version ?? 1
    const key = `dentists/${dentistId}/procedures/${procedureId}/certificates/v${version}.pdf`
    await store.put({ key, body: bytes, contentType: 'application/pdf' })
    await tx.query(
      `INSERT INTO certificate_versions
         (dentist_id, procedure_id, version, object_key, sha256, signed, copies, location_id, location_name, location_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        dentistId,
        procedureId,
        version,
        key,
        sha256,
        isSigned,
        copies,
        location?.id ?? null,
        location?.name ?? '',
        location?.address ?? '',
      ],
    )
    return {
      version,
      sha256,
      signed: isSigned,
      downloadUrl: await store.presignGet(key),
      copies,
      location: location ? { id: location.id, name: location.name, address: location.address } : null,
    }
  })
}

function assertCertificateReady(
  procedure: {
    cro: string
    cro_uf: string
    patient_name: string
    surgery_date: string | Date
    modality: string
    guardian: string
    birth_date: string | Date
  },
  sites: SiteRow[],
  pieces: PieceRow[],
  grafts: GraftRow[],
): void {
  if (!procedure.cro || !procedure.cro_uf) {
    throw new ClinicValidationError(
      'Para emitir certificado, é necessário completar o cadastro',
      'DENTIST_CRO_REQUIRED',
    )
  }
  const missing = missingCertificateFields(procedure, sites, pieces, grafts)
  if (missing.length > 0) {
    throw new ClinicValidationError(`Faltam campos do certificado: ${missing.join(', ')}.`)
  }
}

function missingCertificateFields(
  procedure: {
    patient_name: string
    surgery_date: string | Date
    modality: string
    guardian: string
    birth_date: string | Date
  },
  sites: SiteRow[],
  pieces: PieceRow[],
  grafts: GraftRow[],
): string[] {
  const missing: string[] = []
  if (!procedure.patient_name) missing.push('paciente')
  if (!day(procedure.surgery_date)) missing.push('data da cirurgia')
  if (sites.length === 0) missing.push('dentes')

  const birth = day(procedure.birth_date)
  if (birth) {
    const ageMs = Date.now() - new Date(`${birth}T00:00:00Z`).getTime()
    const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000)
    if (ageYears < 18 && !procedure.guardian) missing.push('responsável legal')
  }

  const requirePieces = procedure.modality === 'implante'
  for (const site of sites.filter((item) => item.role === 'pilar')) {
    if (requirePieces) {
      const piece = pieces.find((item) => item.site_id === site.id)
      if (!piece?.manufacturer || !piece.model || !piece.size) {
        missing.push(`peça do dente ${site.fdi}`)
      }
    }
    for (const graft of grafts.filter((item) => item.site_id === site.id)) {
      if (graft.origin === 'autogeno' && !graft.donor_site) missing.push(`região doadora do dente ${site.fdi}`)
      if (
        graft.origin === 'biomaterial' &&
        (!graft.manufacturer || !graft.model || !graft.lot)
      ) {
        missing.push(`enxerto do dente ${site.fdi}`)
      }
    }
    if (procedure.modality === 'enxerto' && grafts.every((item) => item.site_id !== site.id)) {
      missing.push(`enxerto do dente ${site.fdi}`)
    }
  }
  return missing
}

async function resolveAttendanceLocation(
  tx: Queryable,
  patientId: string,
  requestedLocationId: string | null,
): Promise<LocationSnapshot | null> {
  const linked = await tx.query<LocationSnapshot>(
    `SELECT care_locations.id, care_locations.name, care_locations.address
     FROM patient_locations
     JOIN care_locations ON care_locations.id = patient_locations.location_id
     WHERE patient_locations.patient_id = $1 AND care_locations.active
     ORDER BY care_locations.name`,
    [patientId],
  )
  const candidates = linked.length
    ? linked
    : await tx.query<LocationSnapshot>(
        `SELECT id, name, address
         FROM care_locations
         WHERE active AND dentist_id = (SELECT dentist_id FROM patients WHERE id = $1)
         ORDER BY name`,
        [patientId],
      )

  if (requestedLocationId) {
    const match = candidates.find((item) => item.id === requestedLocationId)
    if (!match) {
      throw new ClinicValidationError(
        'Selecione um local de atendimento válido.',
        'CERTIFICATE_LOCATION_REQUIRED',
      )
    }
    return match
  }

  if (candidates.length === 1) return candidates[0] ?? null
  if (candidates.length > 1) {
    throw new ClinicValidationError(
      'Selecione o local de atendimento deste certificado.',
      'CERTIFICATE_LOCATION_REQUIRED',
    )
  }
  throw new ClinicValidationError(
    'Cadastre um local de atendimento para emitir o certificado.',
    'CERTIFICATE_LOCATION_REQUIRED',
  )
}

type CertificateProcedure = {
  dentist_name: string
  dentist_phone: string
  cro: string
  cro_uf: string
  patient_name: string
  birth_date: string | Date
  surgery_date: string | Date
}

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const MARGIN_X = 48
const MARGIN_BOTTOM = 48
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2
const LABEL_BOX_WIDTH = 220
const LABEL_BOX_HEIGHT = 78
const LABEL_GAP = 16
const DETAILS_WIDTH = CONTENT_WIDTH - LABEL_BOX_WIDTH - LABEL_GAP
const ink = rgb(0.12, 0.14, 0.18)
const muted = rgb(0.45, 0.48, 0.52)
const rule = rgb(0.78, 0.8, 0.84)

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`
  return value.trim()
}

function graftLine(graft: GraftRow): string {
  if (graft.origin === 'autogeno') return `Enxerto autógeno · região ${graft.donor_site}`
  const parts = [`${graft.manufacturer} ${graft.model}`.trim(), graft.lot ? `lote ${graft.lot}` : '']
  if (day(graft.expires_on)) parts.push(`validade ${day(graft.expires_on)}`)
  return `Enxerto · ${parts.filter(Boolean).join(' · ')}`
}

type SiteBlock =
  | { kind: 'pontico'; fdi: number }
  | { kind: 'implant'; fdi: number; manufacturer: string; model: string; size: string; grafts: string[] }
  | { kind: 'graft_only'; fdi: number; grafts: string[] }

function buildSiteBlocks(sites: SiteRow[], pieces: PieceRow[], grafts: GraftRow[]): SiteBlock[] {
  const blocks: SiteBlock[] = []
  for (const site of sites) {
    const siteGrafts = grafts.filter((item) => item.site_id === site.id).map(graftLine)
    if (site.role === 'pontico') {
      blocks.push({ kind: 'pontico', fdi: site.fdi })
      continue
    }
    const piece = pieces.find((item) => item.site_id === site.id)
    if (piece?.manufacturer || piece?.model || piece?.size) {
      blocks.push({
        kind: 'implant',
        fdi: site.fdi,
        manufacturer: piece.manufacturer,
        model: piece.model,
        size: piece.size,
        grafts: siteGrafts,
      })
      continue
    }
    if (siteGrafts.length > 0) {
      blocks.push({ kind: 'graft_only', fdi: site.fdi, grafts: siteGrafts })
    }
  }
  return blocks
}

function blockHeight(block: SiteBlock): number {
  if (block.kind === 'pontico') return 28
  if (block.kind === 'graft_only') return 36 + block.grafts.length * 14
  const detailsHeight = 18 + 15 * 3
  const rowHeight = Math.max(detailsHeight, LABEL_BOX_HEIGHT)
  return rowHeight + block.grafts.length * 14 + 20
}

async function renderCertificatePdf(
  procedure: CertificateProcedure,
  sites: SiteRow[],
  pieces: PieceRow[],
  grafts: GraftRow[],
  location: LocationSnapshot | null,
  copies: 1 | 2,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const blocks = buildSiteBlocks(sites, pieces, grafts)

  for (let copy = 1; copy <= copies; copy += 1) {
    let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    let y = drawHeader(page, font, bold, procedure, location, copies === 2 ? copy : null)

    for (const block of blocks) {
      const needed = blockHeight(block)
      if (y - needed < MARGIN_BOTTOM) {
        page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
        y = PAGE_HEIGHT - 56
        drawText(page, 'Certificado de procedência (continuação)', MARGIN_X, y, 11, bold)
        y -= 28
      }
      y = drawSiteBlock(page, font, bold, block, y)
    }
  }

  return pdf.save()
}

function drawHeader(
  page: PDFPage,
  font: PDFFont,
  bold: PDFFont,
  procedure: CertificateProcedure,
  location: LocationSnapshot | null,
  via: number | null,
): number {
  let y = PAGE_HEIGHT - 52
  if (via !== null) {
    drawText(page, `${via}ª via`, PAGE_WIDTH - MARGIN_X - bold.widthOfTextAtSize(`${via}ª via`, 10), y + 18, 10, bold, muted)
  }
  drawText(page, 'Certificado de procedência', MARGIN_X, y, 18, bold)
  y -= 28

  drawText(page, `Cirurgião-dentista: ${procedure.dentist_name}`, MARGIN_X, y, 11, font)
  y -= 16
  drawText(page, `CRO/UF: ${procedure.cro} ${procedure.cro_uf}`, MARGIN_X, y, 11, font)
  y -= 16
  const phone = formatPhone(procedure.dentist_phone)
  if (phone) {
    drawText(page, `Telefone: ${phone}`, MARGIN_X, y, 11, font)
    y -= 16
  }
  if (location) {
    drawText(page, `Local: ${location.name}`, MARGIN_X, y, 11, font)
    y -= 16
    if (location.address.trim()) {
      for (const line of wrapText(location.address.trim(), font, 11, CONTENT_WIDTH)) {
        drawText(page, line, MARGIN_X, y, 11, font)
        y -= 15
      }
    }
  }

  y -= 6
  page.drawLine({
    start: { x: MARGIN_X, y },
    end: { x: PAGE_WIDTH - MARGIN_X, y },
    thickness: 0.75,
    color: rule,
  })
  y -= 18

  drawText(page, `Paciente: ${procedure.patient_name}`, MARGIN_X, y, 11, font)
  y -= 16
  const birth = day(procedure.birth_date)
  if (birth) {
    drawText(page, `Nascimento: ${birth}`, MARGIN_X, y, 11, font)
    y -= 16
  }
  drawText(page, `Data da cirurgia: ${day(procedure.surgery_date)}`, MARGIN_X, y, 11, font)
  y -= 16

  y -= 4
  page.drawLine({
    start: { x: MARGIN_X, y },
    end: { x: PAGE_WIDTH - MARGIN_X, y },
    thickness: 0.75,
    color: rule,
  })
  y -= 22
  return y
}

function drawSiteBlock(page: PDFPage, font: PDFFont, bold: PDFFont, block: SiteBlock, y: number): number {
  if (block.kind === 'pontico') {
    drawText(page, `Dente ${block.fdi}: pôntico`, MARGIN_X, y, 11, font, muted)
    return y - 28
  }

  if (block.kind === 'implant') {
    const top = y
    const boxBottom = top - LABEL_BOX_HEIGHT + 4
    const boxX = MARGIN_X + DETAILS_WIDTH + LABEL_GAP
    drawLabelBox(page, font, boxX, boxBottom)

    let textY = top
    drawText(page, `Dente ${block.fdi}`, MARGIN_X, textY, 12, bold)
    textY -= 18
    const details = [
      block.manufacturer ? `Fabricante: ${block.manufacturer}` : '',
      block.model ? `Modelo: ${block.model}` : '',
      block.size ? `Tamanho: ${block.size}` : '',
    ].filter(Boolean)
    for (const line of details) {
      for (const wrapped of wrapText(line, font, 11, DETAILS_WIDTH)) {
        drawText(page, wrapped, MARGIN_X, textY, 11, font)
        textY -= 15
      }
    }

    y = Math.min(textY, boxBottom) - 8
  } else {
    drawText(page, `Dente ${block.fdi}`, MARGIN_X, y, 12, bold)
    y -= 18
  }

  for (const line of block.grafts) {
    drawText(page, line, MARGIN_X, y, 10, font, muted)
    y -= 14
  }
  return y - 16
}

function drawLabelBox(page: PDFPage, font: PDFFont, x: number, boxBottom: number): void {
  const width = LABEL_BOX_WIDTH
  page.drawRectangle({
    x,
    y: boxBottom,
    width,
    height: LABEL_BOX_HEIGHT,
    color: rgb(0.97, 0.97, 0.98),
  })
  const dash = 5
  const gap = 4
  const top = boxBottom + LABEL_BOX_HEIGHT
  for (let cursor = x; cursor < x + width; cursor += dash + gap) {
    const end = Math.min(cursor + dash, x + width)
    page.drawLine({ start: { x: cursor, y: top }, end: { x: end, y: top }, thickness: 1, color: muted })
    page.drawLine({
      start: { x: cursor, y: boxBottom },
      end: { x: end, y: boxBottom },
      thickness: 1,
      color: muted,
    })
  }
  for (let cursor = boxBottom; cursor < top; cursor += dash + gap) {
    const end = Math.min(cursor + dash, top)
    page.drawLine({ start: { x, y: cursor }, end: { x, y: end }, thickness: 1, color: muted })
    page.drawLine({
      start: { x: x + width, y: cursor },
      end: { x: x + width, y: end },
      thickness: 1,
      color: muted,
    })
  }
  const label = 'Cole aqui a etiqueta'
  const size = 10
  const textWidth = font.widthOfTextAtSize(label, size)
  drawText(
    page,
    label,
    x + (width - textWidth) / 2,
    boxBottom + LABEL_BOX_HEIGHT / 2 - size / 2,
    size,
    font,
    muted,
  )
}

function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  color = ink,
): void {
  page.drawText(text, { x, y, size, font, color })
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const lines: string[] = []
  let current = words[0] ?? ''
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate
    } else {
      lines.push(current)
      current = word
    }
  }
  lines.push(current)
  return lines
}
