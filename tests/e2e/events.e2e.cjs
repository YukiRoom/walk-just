// イベント機能のE2Eテスト（ローカル専用）。tests/e2e/setup-local.sh で環境を起動してから実行する。
//   NODE_PATH=$(npm root -g) node tests/e2e/events.e2e.cjs
// 実物の PostgREST + migration 済み PostgreSQL に対して、ブラウザ（390px幅）で操作する。
const { chromium } = require('playwright')
const { execFileSync } = require('node:child_process')

const APP = process.env.E2E_APP_URL ?? 'http://127.0.0.1:4180/'
const SHOTS = process.env.E2E_SHOTS ?? null
const PSQL = ['-h', process.env.PGHOST ?? '127.0.0.1', '-p', process.env.PGPORT ?? '54329', '-U', process.env.PGUSER ?? 'postgres', '-d', process.env.PGDATABASE ?? 'walk_just_e2e_test', '-tAq', '-v', 'ON_ERROR_STOP=1']
const sql = (query) => execFileSync('psql', PSQL, { input: query, encoding: 'utf8' }).trim()
const M = 1 / 111320

const GEO_MOCK = `(() => {
  const watchers = new Map(); let nextId = 1
  navigator.geolocation.watchPosition = (ok) => { const id = nextId++; watchers.set(id, ok); return id }
  navigator.geolocation.clearWatch = (id) => watchers.delete(id)
  navigator.geolocation.getCurrentPosition = () => {}
  window.__emit = (lat, lon, ts, acc = 5) => { for (const cb of watchers.values()) cb({ coords: { latitude: lat, longitude: lon, accuracy: acc, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: ts }) }
})()`

const results = []
const check = (name, cond, detail = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  (${detail})`}`); if (!cond) process.exitCode = 1 }
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
const pageErrors = []

async function newPage(browser, nickname) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: 'Asia/Tokyo', locale: 'ja-JP', serviceWorkers: 'block' })
  await ctx.addInitScript(GEO_MOCK)
  if (nickname) {
    await ctx.addInitScript(([name, id]) => {
      if (!localStorage.getItem('walk-just-nickname')) { localStorage.setItem('walk-just-nickname', name); localStorage.setItem('walk-just-anonymous-user-id', id) }
    }, [nickname, crypto.randomUUID()])
  }
  const page = await ctx.newPage()
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('dialog', (dialog) => void dialog.accept())
  return page
}

async function localInput(page, offsetMinutes) {
  return page.evaluate((offset) => {
    const d = new Date(Date.now() + offset * 60000)
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  }, offsetMinutes)
}

async function createEvent(page, options) {
  await page.getByRole('button', { name: '＋ 新しいイベント' }).click()
  await page.getByLabel('イベント名').fill(options.name)
  await page.getByLabel('説明').fill(options.description ?? '')
  await page.getByLabel('開始日時').fill(await localInput(page, options.startOffset ?? -60))
  await page.getByLabel('終了日時').fill(await localInput(page, 24 * 60))
  await page.getByLabel('エントリー締切').fill(await localInput(page, 12 * 60))
  await page.getByLabel('種目').selectOption(options.modes)
  await page.getByLabel('参加方式').selectOption(options.entryMode)
  await page.getByLabel('目標方式').selectOption(options.targetMode)
  if (options.targetMode === 'fixed') {
    const time = page.locator('fieldset', { hasText: 'TIME の統一目標' })
    await time.getByLabel('目標距離（km）').fill('0.1')
    await time.getByLabel('分').fill('1')
    await time.getByLabel('秒').fill('10')
    const steps = page.locator('fieldset', { hasText: 'STEP の統一目標' })
    await steps.getByLabel('目標距離（km）').fill('0.1')
    await steps.getByLabel('目標歩数').fill('150')
  }
  await page.getByLabel('ランキング公開').selectOption(options.visibility)
  await page.getByLabel('挑戦回数').selectOption(options.attempts)
  await page.getByRole('button', { name: '作成する' }).click()
  await page.locator('.share-url').waitFor()
  const url = await page.locator('.share-url').inputValue()
  return new URL(url).searchParams.get('event')
}

/** START → (サーバーで挑戦開始) → 開始時刻を過去にずらす → GPS準備 → 100m歩く（7秒/10m） */
async function walkChallenge(page, { backdate = true } = {}) {
  await page.getByRole('button', { name: 'START' }).click()
  await page.getByText('GPS準備中…').waitFor()
  if (backdate) sql(`update public.walk_just_event_attempts set started_at = now() - interval '10 minutes' where submitted_at is null and started_at > now() - interval '1 minute'`)
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.__emit(35, 139.7, Date.now()))
  await page.getByRole('button', { name: '計測スタート' }).click()
  await page.getByText('チャレンジ中').waitFor()
  const t0 = await page.evaluate(() => Date.now())
  for (let i = 1; i <= 11; i++) await page.evaluate(([lat, ts]) => window.__emit(lat, 139.7, ts), [35 + i * 10 * M, t0 + i * 7000])
}

async function participantToken(page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('sb-') && k.endsWith('-auth-token'))
    return key ? JSON.parse(localStorage.getItem(key)).access_token : null
  })
}

;(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' })
  const normalResultsBefore = Number(sql('select count(*) from public.challenge_results'))

  // ------------------------------------------------------------ 管理者
  const admin = await newPage(browser, null)
  await admin.goto(APP + '?admin=1')
  await admin.getByRole('heading', { name: '管理者ログイン' }).waitFor()
  check('?admin=1 はニックネーム未登録でも管理者ログインを表示', true)
  await admin.getByLabel('メールアドレス').fill('admin@example.com')
  await admin.getByLabel('パスワード').fill('wrong')
  await admin.getByRole('button', { name: 'ログイン' }).click()
  await admin.getByText('メールアドレスまたはパスワードが違います。').waitFor()
  check('パスワード違いはログイン不可', true)
  await admin.getByLabel('メールアドレス').fill('member@example.com')
  await admin.getByLabel('パスワード').fill('member-pass')
  await admin.getByRole('button', { name: 'ログイン' }).click()
  await admin.getByText('管理者として登録されていません').waitFor()
  check('管理者未登録のアカウントは管理画面に入れない（サーバー判定）', true)
  await admin.getByRole('button', { name: 'ログアウト' }).click()
  await admin.getByLabel('メールアドレス').fill('admin@example.com')
  await admin.getByLabel('パスワード').fill('admin-pass')
  await admin.getByRole('button', { name: 'ログイン' }).click()
  await admin.getByRole('heading', { name: 'イベント管理' }).waitFor()
  check('管理者ログイン', true)
  check('管理画面 390px 横スクロールなし', await noHScroll(admin))

  const e1 = await createEvent(admin, { name: '春のJUSTウォーク', description: '公園を1周', modes: 'both', entryMode: 'open', targetMode: 'fixed', visibility: 'realtime', attempts: 'single' })
  check('イベント作成（自由参加・統一目標・両種目・1回）', /^[0-9a-f-]{36}$/.test(e1 ?? ''))
  check('参加用QRコードを表示', await admin.locator('img.event-qr').isVisible())
  check('イベント管理画面 390px 横スクロールなし', await noHScroll(admin))
  if (SHOTS) await admin.screenshot({ path: `${SHOTS}/admin-manage.png`, fullPage: true })
  await admin.getByRole('button', { name: '← イベント一覧' }).click()
  const e2 = await createEvent(admin, { name: '承認制タイムアタック', modes: 'time', entryMode: 'approval', targetMode: 'personal', visibility: 'after_end', attempts: 'best' })
  check('イベント作成（承認制・個人目標・TIMEのみ・複数回・終了後公開）', Boolean(e2))
  check('created_by はサーバーで管理者IDに', sql(`select created_by from public.walk_just_events where id = '${e1}'`) === 'a0000000-0000-4000-8000-0000000000a1')

  // ------------------------------------------------------------ 参加者1：自由参加・統一目標
  const p1 = await newPage(browser, 'ユーザー1')
  await p1.goto(APP)
  await p1.getByRole('button', { name: '🏁 イベントに参加する' }).click()
  await p1.getByText('春のJUSTウォーク').click()
  await p1.getByRole('button', { name: 'エントリーする' }).waitFor()
  check('ホーム→イベント一覧→イベント詳細', true)
  check('イベント詳細 390px 横スクロールなし', await noHScroll(p1))
  if (SHOTS) await p1.screenshot({ path: `${SHOTS}/event-detail.png`, fullPage: true })
  await p1.getByRole('button', { name: 'エントリーする' }).click()
  await p1.getByText('✅ エントリー済み（ユーザー1）').waitFor()
  check('自由参加は即エントリー完了', true)
  const p1Uid = sql(`select user_id from public.walk_just_event_entries where event_id = '${e1}'`)
  check('参加者は Supabase 匿名ユーザー（auth.uid）で登録', sql(`select is_anonymous from auth.users where id = '${p1Uid}'`) === 't')
  check('旧 anonymousUserId は参考情報として保存', sql(`select legacy_anonymous_user_id is not null from public.walk_just_event_entries where user_id = '${p1Uid}'`) === 't')

  await p1.getByRole('button', { name: /TIMEで挑戦/ }).click()
  check('統一目標：距離・タイムは変更不可', await p1.getByLabel('目標距離（km）').isDisabled() && (await p1.getByLabel('分').inputValue()) === '1' && (await p1.getByLabel('秒').inputValue()) === '10')
  check('イベント名を表示', (await p1.locator('.event-banner').innerText()).includes('春のJUSTウォーク'))
  await walkChallenge(p1)
  await p1.getByText('チャレンジ結果').waitFor({ timeout: 10000 })
  const p1Time = sql(`select actual_value || ':' || error_value from public.walk_just_event_results where user_id = '${p1Uid}' and mode = 'time'`)
  check(`TIME記録をサーバーで保存・誤差をサーバー計算 (${p1Time})`, p1Time === '70:0')
  await p1.getByRole('button', { name: 'イベントランキングを見る' }).click()
  await p1.locator('.ranking-list li').first().waitFor()
  const r1 = await p1.locator('.ranking-list li').first().innerText()
  check(`イベントランキングに自分（YOU）を表示 (${r1.replace(/\n/g, ' ')})`, r1.includes('ユーザー1') && r1.includes('YOU') && r1.includes('±0秒'))
  check('ランキング 390px 横スクロールなし', await noHScroll(p1))
  await p1.getByRole('button', { name: '← 戻る' }).click()
  await p1.getByRole('button', { name: /TIMEで挑戦/ }).waitFor()
  check('1回のみ：TIMEは「挑戦済み」で押せない', await p1.getByRole('button', { name: /TIMEで挑戦/ }).isDisabled())

  await p1.getByRole('button', { name: /STEPで挑戦/ }).click()
  check('統一目標：歩数は変更不可', await p1.getByLabel('目標歩数').isDisabled() && (await p1.getByLabel('目標歩数').inputValue()) === '150')
  await walkChallenge(p1)
  await p1.getByText('何歩で歩きましたか？').waitFor({ timeout: 10000 })
  await p1.getByPlaceholder('実際の歩数').fill('140')
  await p1.getByRole('button', { name: '記録する' }).click()
  await p1.getByText('チャレンジ結果').waitFor()
  check('STEP記録（誤差10歩）', sql(`select error_value from public.walk_just_event_results where user_id = '${p1Uid}' and mode = 'steps'`) === '10')
  check('イベント記録は通常ランキング（challenge_results）に入らない', Number(sql('select count(*) from public.challenge_results')) === normalResultsBefore)

  // APIを直接叩く不正操作（UIを経由しない）
  const token = await participantToken(p1)
  const api = async (path, method, body) => p1.evaluate(async ([path, method, body, token]) => {
    const res = await fetch(`http://127.0.0.1:54321/rest/v1/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, text: await res.text() }
  }, [path, method, body, token])
  const esc = await api('walk_just_admins', 'POST', { user_id: p1Uid })
  check(`参加者は管理者に昇格できない (HTTP ${esc.status})`, esc.status >= 400 && Number(sql('select count(*) from public.walk_just_admins')) === 1)
  const approveSelf = await api('rpc/walk_just_set_entry_status', 'POST', { p_entry_id: sql(`select id from public.walk_just_event_entries where user_id = '${p1Uid}'`), p_status: 'approved' })
  check(`参加者は承認関数を実行できない (${approveSelf.text.slice(0, 60)})`, approveSelf.text.includes('walk_just:forbidden'))
  const fake = await api('walk_just_event_results', 'POST', { event_id: e1, entry_id: p1Uid, attempt_id: p1Uid, user_id: p1Uid, mode: 'time', target_distance_m: 100, target_value: 70, actual_value: 70, error_value: 0, elapsed_seconds: 70 })
  check(`記録の直接書き込み（偽装）は拒否 (HTTP ${fake.status})`, fake.status >= 400)
  const tamper = await api(`walk_just_events?id=eq.${e1}`, 'PATCH', { name: '乗っ取り' })
  check('参加者はイベントを書き換えられない', tamper.text === '[]' && sql(`select name from public.walk_just_events where id = '${e1}'`) === '春のJUSTウォーク')

  // ------------------------------------------------------------ 参加者3：応答が失われた保存の再試行でも重複しない
  const p3 = await newPage(browser, 'ユーザー3')
  await p3.goto(APP + `?event=${e1}`)
  await p3.getByRole('button', { name: 'エントリーする' }).click()
  await p3.getByText('✅ エントリー済み').waitFor()
  let dropped = false
  await p3.route('**/rest/v1/rpc/walk_just_submit_event_result', async (route) => {
    if (dropped) return route.continue()
    dropped = true
    await route.fetch() // サーバーには届いて保存されるが…
    await route.abort('failed') // …応答が端末に届かない
  })
  await p3.getByRole('button', { name: /TIMEで挑戦/ }).click()
  await walkChallenge(p3)
  await p3.getByRole('button', { name: 'もう一度保存する' }).waitFor({ timeout: 10000 })
  check('保存失敗時に「もう一度保存する」を表示', true)
  await p3.getByRole('button', { name: 'もう一度保存する' }).click()
  await p3.getByText('チャレンジ結果').waitFor()
  const p3Uid = sql(`select user_id from public.walk_just_event_entries where event_id = '${e1}' and nickname = 'ユーザー3'`)
  check('再試行しても記録は1件（重複保存なし）', sql(`select count(*) from public.walk_just_event_results where user_id = '${p3Uid}'`) === '1')

  // ------------------------------------------------------------ 参加者4：サーバー時刻と矛盾する記録は拒否
  const p4 = await newPage(browser, 'ユーザー4')
  await p4.goto(APP + `?event=${e1}`)
  await p4.getByRole('button', { name: 'エントリーする' }).click()
  await p4.getByText('✅ エントリー済み').waitFor()
  await p4.getByRole('button', { name: /TIMEで挑戦/ }).click()
  await walkChallenge(p4, { backdate: false }) // 端末上は70秒だが、サーバー上は数秒しか経っていない
  await p4.getByText('記録時間が不自然なため保存できませんでした。').waitFor({ timeout: 10000 })
  check('サーバーの開始時刻より長いタイムは保存されない（偽装防止）', sql(`select count(*) from public.walk_just_event_results r join public.walk_just_event_entries e on e.id = r.entry_id where e.nickname = 'ユーザー4'`) === '0')

  // ------------------------------------------------------------ 参加者2：承認制・個人目標・複数回・終了後公開
  const p2 = await newPage(browser, 'ユーザー2')
  await p2.goto(APP + `?event=${e2}`)
  await p2.getByRole('button', { name: 'エントリーする' }).click()
  await p2.getByText('⏳ 承認待ちです').waitFor()
  check('承認制：承認待ちでは挑戦ボタンなし', (await p2.getByRole('button', { name: /で挑戦/ }).count()) === 0)
  // 管理者は作成直後の「承認制タイムアタック」管理画面にいる
  await admin.getByRole('button', { name: '再読み込み' }).click()
  await admin.getByText('ユーザー2').waitFor()
  await admin.locator('.entry-list li', { hasText: 'ユーザー2' }).getByRole('button', { name: '承認' }).click()
  await admin.locator('.entry-list li', { hasText: 'ユーザー2' }).getByText('承認済み').waitFor()
  check('管理者が承認', true)
  await p2.reload()
  await p2.getByText('✅ エントリー済み（ユーザー2）').waitFor()
  check('承認後に挑戦可能・TIMEのみ', (await p2.getByRole('button', { name: /TIMEで挑戦/ }).count()) === 1 && (await p2.getByRole('button', { name: /STEPで挑戦/ }).count()) === 0)
  await p2.getByRole('button', { name: /TIMEで挑戦/ }).click()
  check('個人目標：目標を自分で設定できる', await p2.getByLabel('目標距離（km）').isEnabled())
  await p2.getByLabel('目標距離（km）').fill('0.1')
  await p2.getByLabel('分').fill('1')
  await p2.getByLabel('秒').fill('0')
  await walkChallenge(p2)
  await p2.getByText('チャレンジ結果').waitFor({ timeout: 10000 })
  await p2.getByRole('button', { name: 'イベントへ戻る' }).click()
  await p2.getByRole('button', { name: /TIMEで挑戦/ }).click()
  await p2.getByLabel('秒').fill('10')
  await walkChallenge(p2)
  await p2.getByText('チャレンジ結果').waitFor({ timeout: 10000 })
  check('複数回挑戦（2回）', sql(`select count(*) from public.walk_just_event_results where event_id = '${e2}'`) === '2')
  await p2.getByRole('button', { name: 'イベントランキングを見る' }).click()
  await p2.getByText('ランキングはイベント終了後に公開されます。').waitFor()
  check('終了後公開：開催中は参加者に非公開', true)

  await admin.getByRole('button', { name: /ランキング（管理者/ }).click()
  await admin.locator('.ranking-list li').first().waitFor()
  const ra = await admin.locator('.ranking-list li').first().innerText()
  check(`管理者は開催中も閲覧可・ベスト記録・挑戦回数 (${ra.replace(/\n/g, ' ')})`, ra.includes('ユーザー2') && ra.includes('±0秒') && ra.includes('2回挑戦'))
  await admin.getByRole('button', { name: '← 戻る' }).click()
  await admin.getByRole('button', { name: 'イベントを終了する' }).click()
  await admin.getByText('終了', { exact: true }).first().waitFor()
  check('管理者がイベントを終了', sql(`select ended_at is not null from public.walk_just_events where id = '${e2}'`) === 't')

  await p2.getByRole('button', { name: '← 戻る' }).click()
  await p2.getByRole('button', { name: 'イベントランキングを見る' }).click()
  await p2.locator('.ranking-list li').first().waitFor()
  const r2 = await p2.locator('.ranking-list li').first().innerText()
  check(`終了後は参加者もランキング閲覧可 (${r2.replace(/\n/g, ' ')})`, r2.includes('ユーザー2') && r2.includes('YOU') && r2.includes('±0秒'))
  await p2.getByRole('button', { name: '← 戻る' }).click()
  await p2.getByText('✅ エントリー済み').waitFor()
  check('終了後は挑戦ボタンなし', (await p2.getByRole('button', { name: /で挑戦/ }).count()) === 0)

  const late = await newPage(browser, '遅刻')
  await late.goto(APP + `?event=${e2}`)
  await late.getByText('エントリーの受付は終了しました。').waitFor()
  check('終了後はエントリー不可', true)

  // ------------------------------------------------------------ 匿名ログイン無効・migration未適用
  const noAnon = await newPage(browser, '匿名無効')
  await noAnon.route('**/auth/v1/signup', (route) => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ code: 422, error_code: 'anonymous_provider_disabled', msg: 'Anonymous sign-ins are disabled' }) }))
  await noAnon.goto(APP + `?event=${e1}`)
  await noAnon.getByRole('button', { name: 'エントリーする' }).click()
  await noAnon.getByText(/匿名ログインが無効/).waitFor()
  check('Supabaseで匿名ログインが無効な場合は案内を表示', true)

  const legacy = await newPage(browser, '通常ユーザー')
  await legacy.route('**/rest/v1/walk_just_events**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.walk_just_events' in the schema cache" }) }))
  await legacy.goto(APP)
  await legacy.getByText('通常ユーザーさん').waitFor()
  await legacy.waitForTimeout(500)
  check('migration未適用ならイベントボタンを表示しない', (await legacy.getByRole('button', { name: '🏁 イベントに参加する' }).count()) === 0)
  await legacy.getByRole('button', { name: /TIME CHALLENGE/ }).click()
  check('通常モードの目標は自由に設定できる', await legacy.getByLabel('目標距離（km）').isEnabled())
  await legacy.getByLabel('目標距離（km）').fill('0.1')
  await legacy.getByRole('button', { name: 'START' }).click()
  for (let i = 0; i < 3; i++) await legacy.evaluate(() => window.__emit(35, 139.7, Date.now()))
  await legacy.getByRole('button', { name: '計測スタート' }).click()
  const t0 = await legacy.evaluate(() => Date.now())
  for (let i = 1; i <= 11; i++) await legacy.evaluate(([lat, ts]) => window.__emit(lat, 139.7, ts), [35 + i * 10 * M, t0 + i * 7000])
  await legacy.getByText('チャレンジ結果').waitFor({ timeout: 10000 })
  await legacy.getByRole('button', { name: 'ランキングを見る' }).click()
  await legacy.locator('.ranking-list li').first().waitFor()
  check('通常モード：Supabaseの通常ランキングへ保存・表示（従来どおり）',
    (await legacy.locator('.ranking-list li').first().innerText()).includes('通常ユーザー') && Number(sql('select count(*) from public.challenge_results')) === normalResultsBefore + 1)

  check(`ページエラーなし ${pageErrors.length ? JSON.stringify(pageErrors) : ''}`, pageErrors.length === 0)
  await browser.close()
  console.log(results.join('\n'))
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length} passed, ${results.filter((r) => r.startsWith('FAIL')).length} failed`)
})().catch((error) => { console.log(results.join('\n')); console.error(error); process.exit(1) })
