import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from './database.js'

export function migrationsDirectory(): string {
  return join(fileURLToPath(new URL('../../migrations', import.meta.url)))
}

export async function migrate(database: Database, directory = migrationsDirectory()): Promise<string[]> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const applied = new Set(
    (await database.query<{ id: string }>('SELECT id FROM schema_migrations')).map((row) => row.id),
  )
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  const ran: string[] = []

  for (const file of files) {
    if (applied.has(file)) continue
    const sql = readFileSync(join(directory, file), 'utf8')
    await database.exec(sql)
    await database.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file])
    ran.push(file)
  }

  return ran
}
