const upperArch = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28]
const lowerArch = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38]
const chipOrder = [...upperArch, ...lowerArch]

export function isValidFdi(fdi: number): boolean {
  return chipOrder.includes(fdi)
}

export const implantStatuses = [
  'planejado',
  'instalado',
  'osseointegracao',
  'reabertura',
  'protese',
  'concluido',
  'manutencao',
  'intercorrencia',
] as const

export const graftStatuses = [
  'planejado',
  'realizado',
  'maturacao',
  'prontoParaImplante',
  'intercorrencia',
] as const

export const followUpReasons = [
  'sutura',
  'osseointegracao',
  'instalarImplante',
  'instalarPonte',
  'instalarProtocolo',
  'controle',
  'reabertura',
] as const

export class ClinicValidationError extends Error {
  readonly statusCode = 400
  readonly code: string
  readonly validation: { message: string }[]

  constructor(message: string, code = 'validation_error') {
    super(message)
    this.name = 'ClinicValidationError'
    this.code = code
    this.validation = [{ message }]
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function clientUuid(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new ClinicValidationError('Identificador inválido.')
  }
  return value
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '')
}

export function normalizePhone(value: string): string {
  let digits = digitsOnly(value)
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2)
  }
  return digits
}

export function isValidPhone(value: string): boolean {
  return /^[1-9]{2}9?\d{8}$/.test(value) && (value.length === 10 || value.length === 11)
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export function isValidCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false
  const digits = [...value].map(Number)
  const check = (length: number) => {
    let sum = 0
    for (let index = 0; index < length; index += 1) sum += (digits[index] ?? 0) * (length + 1 - index)
    const mod = (sum * 10) % 11
    return (mod === 10 ? 0 : mod) === digits[length]
  }
  return check(9) && check(10)
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function todayInBrasilia(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now)
}

export function isMinor(birthDate: string, today = todayInBrasilia()): boolean {
  const [year, month, day] = birthDate.split('-').map(Number)
  const adultYear = (year ?? 0) + 18
  const adult = `${adultYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return isIsoDate(adult) ? adult > today : `${adultYear}-02-28` > today
}

function archOf(tooth: number): number[] {
  return upperArch.includes(tooth) ? upperArch : lowerArch
}

function sideOf(tooth: number): 'superior' | 'inferior' {
  return upperArch.includes(tooth) ? 'superior' : 'inferior'
}

export function isContiguousSpan(teeth: number[]): boolean {
  if (teeth.length < 2) return teeth.length === 1
  const arch = archOf(teeth[0] ?? 0)
  if (teeth.some((tooth) => !arch.includes(tooth))) return false
  const indexes = teeth.map((tooth) => arch.indexOf(tooth)).sort((a, b) => a - b)
  for (let index = 1; index < indexes.length; index += 1) {
    if (indexes[index] !== (indexes[index - 1] ?? 0) + 1) return false
  }
  return true
}

export type ToothSiteInput = {
  fdi: number
  role: 'pilar' | 'pontico'
  piece?: Record<string, unknown> | null
  grafts?: Record<string, unknown>[]
}

export function assertProcedureShape(input: {
  modality: string
  subtype?: string | null
  arch?: string | null
  sites: ToothSiteInput[]
}): void {
  const teeth = input.sites.map((site) => site.fdi)
  if (new Set(teeth).size !== teeth.length) throw new ClinicValidationError('Dente repetido no procedimento.')
  if (teeth.some((tooth) => !chipOrder.includes(tooth))) throw new ClinicValidationError('Dente fora da numeração FDI.')

  for (const site of input.sites) {
    if (site.role === 'pontico' && (site.piece || (site.grafts?.length ?? 0) > 0)) {
      throw new ClinicValidationError('Pôntico não recebe peça nem enxerto.')
    }
  }

  if (input.modality === 'enxerto') {
    if (input.subtype) throw new ClinicValidationError('Enxerto sozinho não tem subtipo.')
    if (input.sites.length < 1 || input.sites.some((site) => site.role !== 'pilar')) {
      throw new ClinicValidationError('Enxerto sozinho usa só dentes pilares.')
    }
    if (input.sites.some((site) => site.piece)) {
      throw new ClinicValidationError('Enxerto sozinho não recebe peça de implante.')
    }
    return
  }

  if (input.subtype === 'unitario') {
    if (input.sites.length < 1 || input.sites.some((site) => site.role !== 'pilar')) {
      throw new ClinicValidationError('Implante unitário usa só dentes pilares.')
    }
    return
  }

  if (input.subtype === 'ponte') {
    if (!isContiguousSpan(teeth) || teeth.length < 2) {
      throw new ClinicValidationError('Ponte fixa exige um trecho contínuo da mesma arcada.')
    }
    const ordered = [...input.sites].sort(
      (a, b) => chipOrder.indexOf(a.fdi) - chipOrder.indexOf(b.fdi),
    )
    if (ordered[0]?.role !== 'pilar' || ordered.at(-1)?.role !== 'pilar') {
      throw new ClinicValidationError('As extremidades da ponte são pilares.')
    }
    return
  }

  if (input.subtype === 'protocolo') {
    if (input.arch !== 'superior' && input.arch !== 'inferior') {
      throw new ClinicValidationError('Protocolo exige a arcada.')
    }
    const pillars = input.sites.filter((site) => site.role === 'pilar')
    if (pillars.length < 2) throw new ClinicValidationError('Protocolo exige ao menos dois implantes.')
    if (input.sites.some((site) => sideOf(site.fdi) !== input.arch)) {
      throw new ClinicValidationError('Os dentes do protocolo ficam na arcada escolhida.')
    }
    return
  }

  throw new ClinicValidationError('Modalidade do procedimento inválida.')
}

export function statusesFor(modality: string): readonly string[] {
  return modality === 'enxerto' ? graftStatuses : implantStatuses
}
