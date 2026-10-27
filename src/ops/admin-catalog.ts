import type { Database, Queryable } from '../db/database.js'

export type CatalogManufacturer = {
  id: string
  name: string
  active: boolean
  modelCount: number
}

export type CatalogModel = {
  id: string
  manufacturerId: string
  name: string
  active: boolean
}

export type CatalogSize = {
  id: string
  label: string
  active: boolean
}

export type ClinicalCounts = {
  patients: number
  procedures: number
  installedImplants: number
  implantPieces: number
  manufacturers: number
  models: number
  sizes: number
  references: number
}

export function slugifyId(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export async function countClinicalAndCatalog(database: Database): Promise<ClinicalCounts> {
  const rows = await database.query<{
    patients: string
    procedures: string
    installed_implants: string
    implant_pieces: string
    manufacturers: string
    models: string
    sizes: string
    ref_count: string
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM patients) AS patients,
       (SELECT COUNT(*)::text FROM procedures WHERE deleted_at IS NULL) AS procedures,
       (SELECT COUNT(*)::text FROM installed_implants) AS installed_implants,
       (SELECT COUNT(*)::text FROM implant_pieces) AS implant_pieces,
       (SELECT COUNT(*)::text FROM implant_manufacturers WHERE active) AS manufacturers,
       (SELECT COUNT(*)::text FROM implant_models WHERE active) AS models,
       (SELECT COUNT(*)::text FROM implant_sizes WHERE active) AS sizes,
       (SELECT COUNT(*)::text FROM implant_references WHERE active) AS ref_count`,
  )
  const row = rows[0]
  return {
    patients: Number.parseInt(row?.patients ?? '0', 10),
    procedures: Number.parseInt(row?.procedures ?? '0', 10),
    installedImplants: Number.parseInt(row?.installed_implants ?? '0', 10),
    implantPieces: Number.parseInt(row?.implant_pieces ?? '0', 10),
    manufacturers: Number.parseInt(row?.manufacturers ?? '0', 10),
    models: Number.parseInt(row?.models ?? '0', 10),
    sizes: Number.parseInt(row?.sizes ?? '0', 10),
    references: Number.parseInt(row?.ref_count ?? '0', 10),
  }
}

export async function listManufacturers(
  database: Queryable,
  options: { includeInactive?: boolean } = {},
): Promise<CatalogManufacturer[]> {
  const includeInactive = Boolean(options.includeInactive)
  const rows = await database.query<{
    id: string
    name: string
    active: boolean
    model_count: string
  }>(
    `SELECT m.id, m.name, m.active,
            COUNT(md.id)::text AS model_count
     FROM implant_manufacturers m
     LEFT JOIN implant_models md
       ON md.manufacturer_id = m.id AND ($1 OR md.active)
     WHERE ($1 OR m.active)
     GROUP BY m.id, m.name, m.active
     ORDER BY m.name`,
    [includeInactive],
  )
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
    modelCount: Number.parseInt(row.model_count ?? '0', 10),
  }))
}

export async function createManufacturer(
  database: Queryable,
  input: { name: string; id?: string },
): Promise<CatalogManufacturer> {
  const name = input.name.trim()
  if (!name) throw new CatalogValidationError('Informe o nome do fabricante.')
  const id = (input.id?.trim() || slugifyId(name)).slice(0, 80)
  if (!id) throw new CatalogValidationError('Não foi possível gerar o id do fabricante.')
  try {
    await database.query(
      `INSERT INTO implant_manufacturers (id, name, active) VALUES ($1, $2, true)`,
      [id, name],
    )
  } catch (error) {
    throw mapUniqueViolation(error, 'Fabricante já existe.')
  }
  return { id, name, active: true, modelCount: 0 }
}

export async function updateManufacturer(
  database: Queryable,
  id: string,
  input: { name?: string; active?: boolean },
): Promise<CatalogManufacturer | null> {
  const current = await database.query<{ id: string; name: string; active: boolean }>(
    `SELECT id, name, active FROM implant_manufacturers WHERE id = $1`,
    [id],
  )
  const row = current[0]
  if (!row) return null
  const name = input.name?.trim() ?? row.name
  const active = input.active ?? row.active
  if (!name) throw new CatalogValidationError('Informe o nome do fabricante.')
  try {
    await database.query(
      `UPDATE implant_manufacturers SET name = $2, active = $3 WHERE id = $1`,
      [id, name, active],
    )
  } catch (error) {
    throw mapUniqueViolation(error, 'Já existe fabricante com este nome.')
  }
  const listed = await listManufacturers(database, { includeInactive: true })
  return listed.find((item) => item.id === id) ?? { id, name, active, modelCount: 0 }
}

export async function listModels(
  database: Queryable,
  manufacturerId: string,
  options: { includeInactive?: boolean } = {},
): Promise<CatalogModel[]> {
  const rows = await database.query<{
    id: string
    manufacturer_id: string
    name: string
    active: boolean
  }>(
    `SELECT id, manufacturer_id, name, active
     FROM implant_models
     WHERE manufacturer_id = $1 AND ($2 OR active)
     ORDER BY name`,
    [manufacturerId, Boolean(options.includeInactive)],
  )
  return rows.map((row) => ({
    id: row.id,
    manufacturerId: row.manufacturer_id,
    name: row.name,
    active: row.active,
  }))
}

export async function createModel(
  database: Queryable,
  manufacturerId: string,
  input: { name: string; id?: string },
): Promise<CatalogModel> {
  const name = input.name.trim()
  if (!name) throw new CatalogValidationError('Informe o nome do modelo.')
  const parent = await database.query<{ id: string }>(
    `SELECT id FROM implant_manufacturers WHERE id = $1`,
    [manufacturerId],
  )
  if (!parent[0]) throw new CatalogValidationError('Fabricante não encontrado.')
  const id = (input.id?.trim() || `${manufacturerId}-${slugifyId(name)}`).slice(0, 120)
  if (!id) throw new CatalogValidationError('Não foi possível gerar o id do modelo.')
  try {
    await database.query(
      `INSERT INTO implant_models (id, manufacturer_id, name, active) VALUES ($1, $2, $3, true)`,
      [id, manufacturerId, name],
    )
  } catch (error) {
    throw mapUniqueViolation(error, 'Modelo já existe para este fabricante.')
  }
  return { id, manufacturerId, name, active: true }
}

export async function updateModel(
  database: Queryable,
  id: string,
  input: { name?: string; active?: boolean },
): Promise<CatalogModel | null> {
  const current = await database.query<{
    id: string
    manufacturer_id: string
    name: string
    active: boolean
  }>(`SELECT id, manufacturer_id, name, active FROM implant_models WHERE id = $1`, [id])
  const row = current[0]
  if (!row) return null
  const name = input.name?.trim() ?? row.name
  const active = input.active ?? row.active
  if (!name) throw new CatalogValidationError('Informe o nome do modelo.')
  try {
    await database.query(`UPDATE implant_models SET name = $2, active = $3 WHERE id = $1`, [
      id,
      name,
      active,
    ])
  } catch (error) {
    throw mapUniqueViolation(error, 'Já existe modelo com este nome neste fabricante.')
  }
  return {
    id: row.id,
    manufacturerId: row.manufacturer_id,
    name,
    active,
  }
}

export async function listSizes(
  database: Queryable,
  options: { includeInactive?: boolean } = {},
): Promise<CatalogSize[]> {
  const rows = await database.query<{ id: string; label: string; active: boolean }>(
    `SELECT id, label, active
     FROM implant_sizes
     WHERE ($1 OR active)
     ORDER BY label`,
    [Boolean(options.includeInactive)],
  )
  return rows.map((row) => ({ id: row.id, label: row.label, active: row.active }))
}

export async function createSize(
  database: Queryable,
  input: { label: string; id?: string },
): Promise<CatalogSize> {
  const label = input.label.trim()
  if (!label) throw new CatalogValidationError('Informe o tamanho (ex.: 4.0 × 10 mm).')
  const id = (input.id?.trim() || slugifyId(label.replace(/×/g, 'x').replace(/\s*mm\s*/gi, ''))).slice(
    0,
    80,
  )
  if (!id) throw new CatalogValidationError('Não foi possível gerar o id do tamanho.')
  try {
    await database.query(`INSERT INTO implant_sizes (id, label, active) VALUES ($1, $2, true)`, [
      id,
      label,
    ])
  } catch (error) {
    throw mapUniqueViolation(error, 'Tamanho já existe.')
  }
  return { id, label, active: true }
}

export async function updateSize(
  database: Queryable,
  id: string,
  input: { label?: string; active?: boolean },
): Promise<CatalogSize | null> {
  const current = await database.query<{ id: string; label: string; active: boolean }>(
    `SELECT id, label, active FROM implant_sizes WHERE id = $1`,
    [id],
  )
  const row = current[0]
  if (!row) return null
  const label = input.label?.trim() ?? row.label
  const active = input.active ?? row.active
  if (!label) throw new CatalogValidationError('Informe o tamanho.')
  try {
    await database.query(`UPDATE implant_sizes SET label = $2, active = $3 WHERE id = $1`, [
      id,
      label,
      active,
    ])
  } catch (error) {
    throw mapUniqueViolation(error, 'Já existe tamanho com este rótulo.')
  }
  return { id, label, active }
}

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogValidationError'
  }
}

function mapUniqueViolation(error: unknown, message: string): Error {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  ) {
    return new CatalogValidationError(message)
  }
  return error instanceof Error ? error : new Error(String(error))
}
