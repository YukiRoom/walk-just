import { useEffect, useMemo, useRef, useState } from 'react'
import { TrackingDisplay } from './components/TrackingDisplay'
import { GpsTestTools } from './components/GpsTestTools'
import { InstallGuide } from './components/InstallGuide'
import { useScreenWakeLock } from './hooks/useScreenWakeLock'
import { useWalkTracker } from './hooks/useWalkTracker'
import { formatTime, secondsFromMinutesSeconds } from './lib/format'
import { createUuid, legacyNickname, loadProfile, nicknameError, nicknameLength, NICKNAME_MAX_LENGTH, registerProfile, updateNickname } from './lib/profile'
import type { Profile } from './lib/profile'
import { getRankings, saveResult } from './lib/results'
import type { ChallengeMode, ChallengeResult, DistanceFilter } from './types'

type Screen = 'home' | 'profile' | 'setup' | 'tracking' | 'steps-entry' | 'result' | 'ranking'

const DISTANCE_FILTERS: { value: DistanceFilter; label: string }[] = [
  { value: 'all', label: '全距離' }, { value: 500, label: '0.5km' }, { value: 1000, label: '1km' },
  { value: 2000, label: '2km' }, { value: 3000, label: '3km' }, { value: 5000, label: '5km' },
]

function inputError(distanceKm: number, mode: ChallengeMode, targetMin: number, targetSec: number, targetSteps: number): string | null {
  if (!Number.isFinite(distanceKm) || distanceKm < 0.1) return '目標距離は0.1km以上で入力してください。'
  if (distanceKm > 100) return '目標距離は100km以下で入力してください。'
  if (mode === 'time' && (!Number.isInteger(targetMin) || targetMin < 0 || !Number.isInteger(targetSec) || targetSec < 0 || targetSec > 59 || targetMin * 60 + targetSec <= 0)) return '目標タイムは秒を0〜59、合計1秒以上の整数で入力してください。'
  if (mode === 'steps' && (!Number.isInteger(targetSteps) || targetSteps <= 0)) return '目標歩数は1歩以上の整数で入力してください。'
  return null
}

export default function App() {
  const debugEnabled = useMemo(() => new URLSearchParams(window.location.search).get('debug') === '1', [])
  const [screen, setScreen] = useState<Screen>('home')
  const [mode, setMode] = useState<ChallengeMode>('time')
  const [profile, setProfile] = useState<Profile | null>(() => loadProfile())
  const [nicknameDraft, setNicknameDraft] = useState(() => (profile ? profile.nickname : legacyNickname()))
  const [nicknameMessage, setNicknameMessage] = useState<string | null>(null)
  const [distanceKm, setDistanceKm] = useState(1)
  const [targetMin, setTargetMin] = useState(12)
  const [targetSec, setTargetSec] = useState(0)
  const [targetSteps, setTargetSteps] = useState(1300)
  const [actualSteps, setActualSteps] = useState('')
  const [lastResult, setLastResult] = useState<ChallengeResult | null>(null)
  const [rankingMode, setRankingMode] = useState<ChallengeMode>('time')
  const [distanceFilter, setDistanceFilter] = useState<DistanceFilter>('all')
  const [rankings, setRankings] = useState<ChallengeResult[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const commitStarted = useRef(false)

  const targetDistanceM = Math.round(distanceKm * 1000)
  const tracker = useWalkTracker(Number.isFinite(targetDistanceM) ? Math.max(100, targetDistanceM) : 100, debugEnabled)
  // 計測画面でGPS計測中の間だけ画面の自動スリープを防ぐ（ゴール・中止・画面離脱で解除）
  const wakeLock = useScreenWakeLock(screen === 'tracking' && tracker.status === 'tracking')
  const timeTargetSeconds = useMemo(
    () => secondsFromMinutesSeconds(targetMin, targetSec),
    [targetMin, targetSec],
  )
  const validationMessage = inputError(distanceKm, mode, targetMin, targetSec, targetSteps)

  useEffect(() => {
    if (tracker.status !== 'finished' || screen !== 'tracking' || commitStarted.current) return
    commitStarted.current = true
    if (mode === 'steps') {
      setScreen('steps-entry')
      return
    }
    void commitTimeResult()
  }, [tracker.status, screen, mode])

  async function persistResult(result: ChallengeResult): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      await saveResult(result)
      setLastResult(result)
      setScreen('result')
    } catch {
      commitStarted.current = false
      setMessage('記録を保存できませんでした。通信状態を確認して、もう一度お試しください。')
    } finally {
      setBusy(false)
    }
  }

  async function commitTimeResult(): Promise<void> {
    if (!profile) return
    const actualSeconds = Math.max(0, Math.round(tracker.elapsedMs / 1000))
    await persistResult({
      id: createUuid(), playerName: profile.nickname, anonymousUserId: profile.anonymousUserId, mode: 'time', targetDistanceM,
      targetValue: timeTargetSeconds, actualValue: actualSeconds,
      errorValue: Math.abs(actualSeconds - timeTargetSeconds), elapsedSeconds: actualSeconds,
      createdAt: new Date().toISOString(),
    })
  }

  async function commitStepsResult(): Promise<void> {
    if (!profile) return
    const steps = Number(actualSteps)
    if (!Number.isInteger(steps) || steps <= 0) {
      setMessage('実際の歩数を1歩以上の整数で入力してください。')
      return
    }
    if (commitStarted.current && busy) return
    commitStarted.current = true
    const elapsedSeconds = Math.max(0, Math.round(tracker.elapsedMs / 1000))
    await persistResult({
      id: createUuid(), playerName: profile.nickname, anonymousUserId: profile.anonymousUserId, mode: 'steps', targetDistanceM,
      targetValue: targetSteps, actualValue: steps, errorValue: Math.abs(steps - targetSteps),
      elapsedSeconds, createdAt: new Date().toISOString(),
    })
  }

  function openSetup(nextMode: ChallengeMode): void {
    setMode(nextMode)
    setActualSteps('')
    setMessage(null)
    commitStarted.current = false
    tracker.cancel()
    setScreen('setup')
  }

  function startChallenge(): void {
    if (validationMessage) {
      setMessage(validationMessage)
      return
    }
    setMessage(null)
    commitStarted.current = false
    setScreen('tracking')
    tracker.start()
    // ユーザー操作（STARTタップ）の中で要求する。失敗してもGPS計測は継続する
    wakeLock.request()
  }

  function submitRegistration(): void {
    const error = nicknameError(nicknameDraft)
    if (error) {
      setNicknameMessage(error)
      return
    }
    const next = registerProfile(nicknameDraft)
    setProfile(next)
    setNicknameDraft(next.nickname)
    setNicknameMessage(null)
    setScreen('home')
  }

  function openProfile(): void {
    if (!profile) return
    setNicknameDraft(profile.nickname)
    setNicknameMessage(null)
    setScreen('profile')
  }

  function submitNicknameChange(): void {
    if (!profile) return
    const error = nicknameError(nicknameDraft)
    if (error) {
      setNicknameMessage(error)
      return
    }
    const next = updateNickname(profile, nicknameDraft)
    setProfile(next)
    setNicknameDraft(next.nickname)
    setNicknameMessage('ニックネームを変更しました。')
  }

  async function openRanking(nextMode: ChallengeMode, filter: DistanceFilter = distanceFilter): Promise<void> {
    setRankingMode(nextMode)
    setDistanceFilter(filter)
    setBusy(true)
    setMessage(null)
    setScreen('ranking')
    try {
      setRankings(await getRankings(nextMode, filter))
    } catch {
      setRankings([])
      setMessage('ランキングを取得できませんでした。')
    } finally {
      setBusy(false)
    }
  }

  if (!profile) {
    const draftError = nicknameError(nicknameDraft)
    return (
      <main className="app-shell">
        <section className="panel hero register-panel">
          <h1>WALK JUST!</h1>
          <p>ランキングで使うニックネームを登録してください</p>
          <form onSubmit={(event) => { event.preventDefault(); submitRegistration() }} noValidate>
            <label>ニックネーム<input value={nicknameDraft} onChange={(event) => { setNicknameDraft(event.target.value); setNicknameMessage(null) }} placeholder="例：YUKI" autoComplete="nickname" enterKeyHint="done" aria-describedby="nickname-hint" /></label>
            <small id="nickname-hint" className={`field-hint${nicknameLength(nicknameDraft) > NICKNAME_MAX_LENGTH ? ' over' : ''}`}>{nicknameLength(nicknameDraft)} / {NICKNAME_MAX_LENGTH}文字</small>
            {nicknameMessage && <p className="error" role="alert">{nicknameMessage}</p>}
            <button className="primary" type="submit" disabled={Boolean(draftError)}>登録してはじめる</button>
          </form>
          <p className="note">メールアドレスやパスワードは不要です。ニックネームはあとから変更できます。</p>
        </section>
      </main>
    )
  }

  const nicknameDraftError = nicknameError(nicknameDraft)
  const nicknameUnchanged = nicknameDraft.trim() === profile.nickname

  return (
    <main className="app-shell">
      {screen === 'home' && (
        <section className="panel hero">
          <div className="home-top">
            <div className="eyebrow">WALK JUST!</div>
            <button className="profile-chip" onClick={openProfile} aria-label={`${profile.nickname}さん（ニックネームを変更）`}><span>{profile.nickname}さん</span><small>変更</small></button>
          </div>
          <h1>速さじゃない。<br />ピッタリを競おう。</h1>
          <p>自分で決めた目標に、どれだけ正確に合わせられるかを競うウォーキングゲーム。</p>
          <div className="grid">
            <button className="mode-card" onClick={() => openSetup('time')}><strong>⏱ TIME CHALLENGE</strong><span>目標距離と目標タイムを自分で設定</span></button>
            <button className="mode-card" onClick={() => openSetup('steps')}><strong>👟 STEP CHALLENGE</strong><span>目標距離と目標歩数を自分で設定</span></button>
          </div>
          <div className="row">
            <button className="secondary" onClick={() => void openRanking('time')}>タイムランキング</button>
            <button className="secondary" onClick={() => void openRanking('steps')}>歩数ランキング</button>
          </div>
          <InstallGuide />
        </section>
      )}

      {screen === 'profile' && (
        <section className="panel">
          <button className="text-button" onClick={() => setScreen('home')}>← 戻る</button>
          <div className="eyebrow">PROFILE</div>
          <h2>プロフィール設定</h2>
          <form onSubmit={(event) => { event.preventDefault(); submitNicknameChange() }} noValidate>
            <label>ニックネーム<input value={nicknameDraft} onChange={(event) => { setNicknameDraft(event.target.value); setNicknameMessage(null) }} autoComplete="nickname" enterKeyHint="done" aria-describedby="nickname-hint" /></label>
            <small id="nickname-hint" className={`field-hint${nicknameLength(nicknameDraft) > NICKNAME_MAX_LENGTH ? ' over' : ''}`}>{nicknameLength(nicknameDraft)} / {NICKNAME_MAX_LENGTH}文字</small>
            {nicknameMessage && <p className={nicknameMessage === 'ニックネームを変更しました。' ? 'success' : 'error'} role="status">{nicknameMessage}</p>}
            <button className="primary" type="submit" disabled={Boolean(nicknameDraftError) || nicknameUnchanged}>変更を保存</button>
          </form>
          <p className="note">変更後のニックネームは、これから保存する記録に使われます。過去の記録の表示名は変わりません。</p>
          <p className="note device-id">端末ID：{profile.anonymousUserId.slice(0, 8)}…（変更されません）</p>
        </section>
      )}

      {screen === 'setup' && (
        <section className="panel">
          <button className="text-button" onClick={() => setScreen('home')}>← 戻る</button>
          <div className="eyebrow">{mode === 'time' ? 'TIME CHALLENGE' : 'STEP CHALLENGE'}</div>
          <h2>目標を設定</h2>
          <div className="player-line"><span>プレイヤー</span><strong>{profile.nickname}さん</strong></div>
          <label>目標距離（km）<input type="number" inputMode="decimal" min="0.1" max="100" step="0.1" value={distanceKm} onChange={(event) => setDistanceKm(event.target.valueAsNumber)} /></label>
          {mode === 'time' ? (
            <div><span className="label-title">目標タイム</span><div className="row">
              <label className="grow">分<input type="number" inputMode="numeric" min="0" step="1" value={targetMin} onChange={(event) => setTargetMin(event.target.valueAsNumber)} /></label>
              <label className="grow">秒<input type="number" inputMode="numeric" min="0" max="59" step="1" value={targetSec} onChange={(event) => setTargetSec(event.target.valueAsNumber)} /></label>
            </div></div>
          ) : (
            <label>目標歩数<input type="number" inputMode="numeric" min="1" step="1" value={targetSteps} onChange={(event) => setTargetSteps(event.target.valueAsNumber)} /></label>
          )}
          <div className="summary"><span>今回の目標</span><strong>{Number.isFinite(distanceKm) ? distanceKm.toFixed(2) : '—'}km ／ {mode === 'time' ? formatTime(Math.max(0, timeTargetSeconds) * 1000) : `${Number.isFinite(targetSteps) ? targetSteps.toLocaleString() : '—'}歩`}</strong></div>
          {message && <p className="error" role="alert">{message}</p>}
          <button className="primary" disabled={Boolean(validationMessage)} onClick={startChallenge}>START</button>
        </section>
      )}

      {screen === 'tracking' && <TrackingDisplay mode={mode} distanceM={tracker.distanceM} targetDistanceM={targetDistanceM} elapsedMs={tracker.elapsedMs} error={tracker.error ?? message} debugInfo={debugEnabled ? tracker.debugInfo : undefined} wakeLock={wakeLock} onCancel={() => { tracker.cancel(); setScreen('home') }} />}

      {screen === 'steps-entry' && (
        <section className="panel"><div className="eyebrow">GOAL!</div><h2>何歩で歩きましたか？</h2><p>目標：{targetSteps.toLocaleString()}歩</p>
          <input className="big-input" type="number" inputMode="numeric" min="1" step="1" placeholder="実際の歩数" value={actualSteps} onChange={(event) => setActualSteps(event.target.value)} />
          {message && <p className="error" role="alert">{message}</p>}
          <button className="primary" disabled={busy} onClick={() => void commitStepsResult()}>{busy ? '保存中…' : '記録する'}</button>
          {debugEnabled && <GpsTestTools mode={mode} targetDistanceM={targetDistanceM} measuredDistanceM={tracker.debugInfo.cumulativeDistanceM} elapsedMs={tracker.elapsedMs} debugInfo={tracker.debugInfo} wakeLock={wakeLock} />}
        </section>
      )}

      {screen === 'result' && lastResult && (
        <section className="panel result"><div className="eyebrow">GOAL!</div><h2>チャレンジ結果</h2>
          <div className="result-score"><span>誤差</span><strong>{lastResult.errorValue}{lastResult.mode === 'time' ? '秒' : '歩'}</strong></div>
          <div className="distance-result">目標距離 {(lastResult.targetDistanceM / 1000).toFixed(2)}km</div>
          <div className="result-grid"><div><span>目標</span><strong>{lastResult.mode === 'time' ? formatTime(lastResult.targetValue * 1000) : `${lastResult.targetValue.toLocaleString()}歩`}</strong></div><div><span>実績</span><strong>{lastResult.mode === 'time' ? formatTime(lastResult.actualValue * 1000) : `${lastResult.actualValue.toLocaleString()}歩`}</strong></div></div>
          <button className="primary" onClick={() => void openRanking(lastResult.mode)}>ランキングを見る</button><button className="secondary full" onClick={() => setScreen('home')}>ホームへ</button>
          {debugEnabled && <GpsTestTools mode={lastResult.mode} targetDistanceM={lastResult.targetDistanceM} measuredDistanceM={tracker.debugInfo.cumulativeDistanceM} elapsedMs={tracker.elapsedMs} debugInfo={tracker.debugInfo} wakeLock={wakeLock} />}
        </section>
      )}

      {screen === 'ranking' && (
        <section className="panel ranking-panel"><button className="text-button" onClick={() => setScreen('home')}>← 戻る</button><div className="eyebrow">RANKING</div><h2>{rankingMode === 'time' ? 'タイム誤差ランキング' : '歩数誤差ランキング'}</h2>
          <div className="tabs"><button className={rankingMode === 'time' ? 'active' : ''} onClick={() => void openRanking('time')}>TIME</button><button className={rankingMode === 'steps' ? 'active' : ''} onClick={() => void openRanking('steps')}>STEPS</button></div>
          <div className="filter-row" aria-label="距離フィルタ">{DISTANCE_FILTERS.map((filter) => <button key={filter.label} className={distanceFilter === filter.value ? 'active' : ''} onClick={() => void openRanking(rankingMode, filter.value)}>{filter.label}</button>)}</div>
          {message && <p className="error" role="alert">{message}</p>}
          <ol className="ranking-list">{rankings.map((item, index) => <li key={item.id} className={item.anonymousUserId && item.anonymousUserId === profile.anonymousUserId ? 'mine' : undefined}><b>#{index + 1}</b><div><strong>{item.playerName}{item.anonymousUserId && item.anonymousUserId === profile.anonymousUserId && <em className="you-badge">YOU</em>}</strong><small>{(item.targetDistanceM / 1000).toFixed(2)}km</small><small>目標 {item.mode === 'time' ? formatTime(item.targetValue * 1000) : `${item.targetValue.toLocaleString()}歩`} ／ 実績 {item.mode === 'time' ? formatTime(item.actualValue * 1000) : `${item.actualValue.toLocaleString()}歩`}</small></div><span className="rank-error">±{item.errorValue}{rankingMode === 'time' ? '秒' : '歩'}</span></li>)}</ol>
          {busy && <p className="empty">読み込み中…</p>}{!busy && rankings.length === 0 && !message && <p className="empty">まだ記録がありません。</p>}
        </section>
      )}
    </main>
  )
}
