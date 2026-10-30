// Minimal Supabase-like environment on PGlite for migration tests.
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync, readdirSync } from 'node:fs'

const SHIM = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb, email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
grant select on auth.users to service_role;
create publication supabase_realtime;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on functions to service_role;
`

export async function createDb(migrationsDir) {
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(SHIM)
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
  for (const file of files) {
    try { await db.exec(readFileSync(`${migrationsDir}/${file}`, 'utf8')) }
    catch (e) { throw new Error(`${file}: ${e.message}`) }
  }
  // Tables created before default privileges were granted
  await db.exec('grant all on all tables in schema public to service_role; grant all on all functions in schema public to service_role;')
  return { db, files }
}

export async function as(db, userId, fn) {
  await db.exec('begin')
  try {
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId || ''])
    await db.query(`select set_config('request.jwt.claim.role', $1, true)`, [userId ? 'authenticated' : 'service_role'])
    await db.exec(userId ? 'set local role authenticated' : 'set local role service_role')
    const result = await fn()
    await db.exec('commit')
    return result
  } catch (e) { await db.exec('rollback'); throw e }
}

export function makeTest() {
  let passed = 0, failed = 0
  const t = async (name, fn) => {
    try { await fn(); passed++; console.log('  ok  ', name) }
    catch (e) { failed++; console.log('  FAIL', name, '→', e.message) }
  }
  const done = () => { console.log(`\n${passed} passed, ${failed} failed`); if (failed) process.exit(1) }
  return { t, done }
}
export function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }
export async function rejects(promise, pattern) {
  try { await promise } catch (e) {
    if (pattern && !pattern.test(e.message)) throw new Error(`wrong error: ${e.message}`)
    return
  }
  throw new Error('expected an error')
}
