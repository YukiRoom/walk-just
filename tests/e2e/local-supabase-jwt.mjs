// local-supabase.mjs と同じ秘密鍵で anon キー（JWT）を作る（ローカルE2E専用）
import { createHmac } from 'node:crypto'
const SECRET = process.env.JWT_SECRET ?? 'local-e2e-secret-local-e2e-secret-0123456789'
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
export function anonKey() {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ role: 'anon', iss: 'local-e2e', iat: 0, exp: 4102444800 })
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`
}
