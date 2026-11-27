import fs from 'node:fs'
import path from 'node:path'

export function projectRoot(): string {
  return path.resolve(__dirname, '..')
}

export function defaultEnvPath(): string {
  return path.join(projectRoot(), '.env')
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const start = value[0]
    const end = value[value.length - 1]
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    const value = stripQuotes(line.slice(eq + 1).trim())
    result[key] = value
  }
  return result
}

export function loadEnvFile(
  filePath: string = defaultEnvPath(),
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  let parsed: Record<string, string> = {}
  try {
    parsed = parseEnvFile(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
    return parsed
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value
  }
  return parsed
}
