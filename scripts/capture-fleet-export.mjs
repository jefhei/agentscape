#!/usr/bin/env node
/**
 * Capture the real `debian2_bot` fleet run from the Supabase `agent_messages`
 * table (M5-T3, the dogfood).
 *
 * AgentScape ingests exactly one format — an `agent_messages` export — so the
 * dogfood run is a *snapshot of the real table*, captured here and committed at
 * `src/fixtures/real/debian2-fleet.export.json`. This script is the provenance:
 * re-run it to refresh the snapshot, and read it to see exactly which
 * transformations the committed bytes went through.
 *
 * ## Redaction (the repo is public, the table is not)
 *
 * The export is real coordination traffic between the author's own agents, so it
 * is captured VERBATIM apart from three documented transformations:
 *
 * 1. **Credential values.** A JSON body key that names a credential
 *    (`credential_value`, `api_key`, `token`, `secret`, `password`, …) has its
 *    value replaced with `[redacted]`. One handoff row in the real table carries
 *    an API key; it must never reach a public repo.
 * 2. **Key-shaped text.** Anything that still looks like a bearer/API key
 *    (`sk-…`, `sbp_…`, `ghp_…`, an `eyJ…` JWT) becomes `[redacted-key]`.
 * 3. **Home directory paths.** `/<home>/<account>/…` becomes `~/…` — the same
 *    path, without putting an account name on the internet.
 *
 * Nothing else is touched: row ids, timestamps, agents, subjects and bodies are
 * as recorded, which is what makes the run a real trace rather than a fixture.
 *
 * ## Usage
 *
 *   SUPABASE_ANON_KEY=… node scripts/capture-fleet-export.mjs
 *   node scripts/capture-fleet-export.mjs --out src/fixtures/real/debian2-fleet.export.json
 *
 * The key is read from `SUPABASE_ANON_KEY` or from `~/.hermes/.env` (the same
 * place the pipeline's other tools read it). This script is a capture probe, not
 * part of the app or its gate: it needs the network.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

const SUPABASE_URL = 'https://kgluqrkrxujjkcuwhuvo.supabase.co'
const TABLE = 'agent_messages'
const DEFAULT_OUT = 'src/fixtures/real/debian2-fleet.export.json'
const PAGE = 2000

/** `--flag value` / `--flag=value`, with a default per flag. */
function arg(name, fallback) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

function readKey() {
  if (process.env.SUPABASE_ANON_KEY) return process.env.SUPABASE_ANON_KEY.trim()
  try {
    for (const line of readFileSync(resolve(homedir(), '.hermes/.env'), 'utf8').split(
      '\n',
    )) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const [key, ...rest] = trimmed.split('=')
      if (key.trim() === 'SUPABASE_ANON_KEY') return rest.join('=').trim()
    }
  } catch {
    // fall through to the error below
  }
  throw new Error('SUPABASE_ANON_KEY not set (env var or ~/.hermes/.env)')
}

// ── Redaction ───────────────────────────────────────────────────────────────

/** A JSON body key that names a credential, whatever it is surrounded by. */
const CREDENTIAL_KEY =
  /"([A-Za-z0-9_]*(?:credential|secret|token|api[_-]?key|password|passwd)[A-Za-z0-9_]*)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/gi

/**
 * Names that *describe* a credential rather than hold one (`credential_name`).
 * Those stay readable — the interesting fact is *which* secret was handed over.
 */
const CREDENTIAL_LABEL = /_name$/i

/** Strings that are key-shaped whatever the column calls them. */
const KEY_SHAPED =
  /\b(?:sk|sbp|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_\-.]{6,}|\bsk-[A-Za-z0-9_\-.]{12,}|\beyJ[A-Za-z0-9_-]{16,}/g

/** An absolute home path: `/<user>/<account>/…` → `~/…`. */
const HOME_PATH = /\/home\/[A-Za-z0-9._-]+\//g
const ROOT_HOME_PATH = /\/root\//g

/**
 * Apply the three documented transformations to one row's text columns.
 * Returns the redacted row and how many substitutions each rule made.
 */
export function redactRow(row, homeDir = homedir()) {
  const counts = { credential: 0, key: 0, path: 0 }
  const redact = (text) => {
    if (typeof text !== 'string' || text === '') return text
    let out = text
    out = out.replace(CREDENTIAL_KEY, (_m, name, sep) => {
      if (CREDENTIAL_LABEL.test(name)) return _m
      counts.credential += 1
      return `"${name}"${sep}"[redacted]"`
    })
    out = out.replace(KEY_SHAPED, () => {
      counts.key += 1
      return '[redacted-key]'
    })
    const home = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`^${home}/`, 'g'), '~/')
    out = out.replace(HOME_PATH, '~/').replace(ROOT_HOME_PATH, '~/')
    if (out !== text) counts.path += 1
    return out
  }

  return {
    row: {
      ...row,
      subject: redact(row.subject),
      body: redact(row.body),
    },
    counts,
  }
}

/** Redact a whole export, reporting the totals. */
export function redactExport(rows, homeDir = homedir()) {
  const totals = { credential: 0, key: 0, path: 0, rows: rows.length }
  const redacted = rows.map((row) => {
    const { row: clean, counts } = redactRow(row, homeDir)
    totals.credential += counts.credential
    totals.key += counts.key
    totals.path += counts.path
    return clean
  })
  return { rows: redacted, totals }
}

// ── Capture ─────────────────────────────────────────────────────────────────

async function main() {
  const out = resolve(arg('out', DEFAULT_OUT))
  const key = readKey()

  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?select=*&order=created_at.asc&limit=${PAGE}`
  const response = await fetch(url, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${await response.text()}`)
  }
  const rows = await response.json()
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('the export came back empty — refusing to overwrite the snapshot')
  }

  const { rows: clean, totals } = redactExport(rows)

  // Postcondition: never write an export that still looks like it carries a
  // secret or an account name. A regex tweak that stops matching must fail the
  // capture, not quietly publish the raw row.
  const text = clean.map((row) => `${row.subject ?? ''}\n${row.body ?? ''}`).join('\n')
  const leaked = [
    [/\/home\/[A-Za-z0-9._-]+\//, 'a home directory path'],
    [/\bsk-[A-Za-z0-9_-]{12,}/, 'an sk- key'],
    [/\bsbp_[A-Za-z0-9]{8,}/, 'a Supabase personal token'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
    [/\beyJ[A-Za-z0-9_-]{20,}/, 'a JWT'],
  ].filter(([pattern]) => pattern.test(text))
  if (leaked.length > 0) {
    throw new Error(
      `refusing to write: the redacted export still matches ${leaked
        .map(([, what]) => what)
        .join(', ')}`,
    )
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(clean, null, 2)}\n`)

  const agents = new Set()
  for (const row of clean) {
    agents.add(row.from_agent)
    if (row.to_agent) agents.add(row.to_agent)
  }
  console.log(`captured ${clean.length} ${TABLE} rows -> ${out}`)
  console.log(
    `agents ${agents.size} · ${clean[0]?.created_at} -> ${clean.at(-1)?.created_at}`,
  )
  console.log(
    `redactions: ${totals.credential} credential value(s), ${totals.key} key-shaped, ${totals.path} row(s) with a home path`,
  )
}

// Only capture when run directly (`node scripts/capture-fleet-export.mjs`); the
// redaction helpers above are importable (and unit-tested) on their own.
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main().catch((error) => {
    console.error(`capture failed: ${error.message}`)
    process.exitCode = 1
  })
}
