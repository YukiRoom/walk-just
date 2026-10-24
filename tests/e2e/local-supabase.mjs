// ローカルE2E専用の「Supabase もどき」。本番では使わない。
//   /rest/v1/*  → 実物の PostgREST（実際の migration / RLS / 関数で動く）へ転送
//   /auth/v1/*  → 匿名ログイン・パスワードログイン・リフレッシュだけを実装した最小の Auth サーバー
// 使い方: node tests/e2e/local-supabase.mjs   （環境変数は下記の既定値を参照）
import { createServer, request as httpRequest } from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const PORT = Number(process.env.LOCAL_SUPABASE_PORT ?? 54321)
const POSTGREST = process.env.POSTGREST_URL ?? 'http://127.0.0.1:54322'
const JWT_SECRET = process.env.JWT_SECRET ?? 'local-e2e-secret-local-e2e-secret-0123456789'
const PSQL = ['-h', process.env.PGHOST ?? '127.0.0.1', '-p', process.env.PGPORT ?? '54329', '-U', process.env.PGUSER ?? 'postgres', '-d', process.env.PGDATABASE ?? 'walk_just_e2e_test', '-tAq', '-v', 'ON_ERROR_STOP=1']
// テスト用アカウント（ローカルDBにだけ存在）
const PASSWORDS = { 'admin@example.com': 'admin-pass', 'member@example.com': 'member-pass' }

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
export function signJwt(payload) {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64(payload)
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
function verifyJwt(token) {
  const [head, body, sig] = String(token).split('.')
  if (!sig || createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url') !== sig) return null
  return JSON.parse(Buffer.from(body, 'base64url').toString())
}
// psql 変数（:'p0'）で値を渡す（標準入力経由のときだけ展開される）
const sql = (query, ...params) => execFileSync('psql', [...PSQL, ...params.flatMap((p, i) => ['-v', `p${i}=${p}`])], { input: query, encoding: 'utf8' }).trim()

const refreshTokens = new Map()
function session(user) {
  const now = Math.floor(Date.now() / 1000)
  const claims = { sub: user.id, role: 'authenticated', aud: 'authenticated', exp: now + 3600, iat: now, is_anonymous: user.is_anonymous, email: user.email ?? '' }
  const refresh = randomUUID()
  refreshTokens.set(refresh, user)
  return {
    access_token: signJwt(claims), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh,
    user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email ?? '', is_anonymous: user.is_anonymous, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}
const readBody = (req) => new Promise((resolve) => { let data = ''; req.on('data', (c) => { data += c }); req.on('end', () => resolve(data)) })

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
      'access-control-expose-headers': 'content-range, content-profile',
      'access-control-max-age': '600',
    })
    return res.end()
  }

  if (url.pathname.startsWith('/rest/v1/')) {
    const target = new URL(url.pathname.slice('/rest/v1'.length) + url.search, POSTGREST)
    const headers = { ...req.headers, host: target.host }
    delete headers.apikey
    const upstream = httpRequest(target, { method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, { ...up.headers, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range, content-profile' })
      up.pipe(res)
    })
    upstream.on('error', () => send(res, 502, { message: 'postgrest unavailable' }))
    req.pipe(upstream)
    return
  }

  const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {}
  try {
    if (url.pathname === '/auth/v1/signup' && req.method === 'POST') {
      if (process.env.ANON_SIGNIN_DISABLED === '1') return send(res, 422, { code: 422, error_code: 'anonymous_provider_disabled', msg: 'Anonymous sign-ins are disabled' })
      const id = randomUUID()
      sql(`insert into auth.users (id, is_anonymous) values (:'p0', true)`, id)
      return send(res, 200, session({ id, email: null, is_anonymous: true }))
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      if (PASSWORDS[body.email] !== body.password) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 400, error_code: 'invalid_credentials' })
      const id = sql(`select id from auth.users where email = :'p0'`, body.email)
      return send(res, 200, session({ id, email: body.email, is_anonymous: false }))
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const user = refreshTokens.get(body.refresh_token)
      if (!user) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token', code: 400 })
      return send(res, 200, session(user))
    }
    if (url.pathname === '/auth/v1/user') {
      const claims = verifyJwt(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))
      if (!claims || claims.role !== 'authenticated') return send(res, 401, { msg: 'invalid JWT' })
      return send(res, 200, { id: claims.sub, aud: 'authenticated', role: 'authenticated', email: claims.email, is_anonymous: claims.is_anonymous, app_metadata: {}, user_metadata: {} })
    }
    if (url.pathname === '/auth/v1/logout') return send(res, 204)
    return send(res, 404, { msg: `not implemented: ${url.pathname}` })
  } catch (error) {
    return send(res, 500, { msg: String(error) })
  }
}).listen(PORT, '127.0.0.1', () => console.log(`local supabase on http://127.0.0.1:${PORT}`))
