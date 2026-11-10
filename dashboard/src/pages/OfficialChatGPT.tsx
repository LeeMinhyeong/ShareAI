import { useEffect, useRef, useState } from 'react'
import { createSiwcApi } from '../siwc-api.mjs'

type Account = { id: string; name: string }
type Flow = { id: string; status: string; retryable?: boolean }
const safeError = (error: unknown, fallback: string) => error instanceof Error && /^요청 실패 \(HTTP \d{3}\)$/.test(error.message) ? error.message : fallback

export default function OfficialChatGPT({ adminKey, onUpdate }: { adminKey: string; onUpdate: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selected, setSelected] = useState('')
  const [name, setName] = useState('')
  const [flow, setFlow] = useState<Flow | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const logoutPending = useRef(false)
  const [access, setAccess] = useState<{enabled: boolean; scope: 'all' | 'selected'; userIds: string[]} | null>(null)
  const [userIds, setUserIds] = useState('')
  const [routing, setRouting] = useState<{priority: string; weight: string} | null>(null)
  const api = createSiwcApi(adminKey)

  const refresh = async () => {
    try {
      const data = await api.list()
      setAccounts(data.accounts)
    } catch (error) { setMessage(safeError(error, '계정 목록을 불러오지 못했습니다.')) }
  }
  useEffect(() => { setAccounts([]); setSelected(''); setFlow(null); void refresh() }, [adminKey])
  useEffect(() => {
    let current = true
    setAccess(null); setUserIds('')
    if (selected) createSiwcApi(adminKey).access(selected).then(value => {
      if (current) { setAccess(value); setUserIds(value.userIds.join('\n')) }
    }).catch(() => { if (current) setMessage('공유 설정을 불러오지 못했습니다.') })
    return () => { current = false }
  }, [selected, adminKey])
  useEffect(() => {
    let current = true
    setRouting(null)
    if (selected) createSiwcApi(adminKey).routing(selected).then(value => {
      if (current) setRouting({priority:String(value.priority), weight:String(value.weight)})
    }).catch(() => { if (current) setMessage('라우팅 설정을 불러오지 못했습니다.') })
    return () => { current = false }
  }, [selected, adminKey])
  const saveRouting = async () => {
    if (!selected || !routing) return
    if (!/^\d+$/.test(routing.priority) || !/^\d+$/.test(routing.weight) || Number(routing.priority) > 1000 || Number(routing.weight) < 1 || Number(routing.weight) > 100) { setMessage('우선순위는 0~1000, 가중치는 1~100의 정수여야 합니다.'); return }
    setBusy(true); setMessage('')
    try {
      const result = await api.setRouting(selected, {priority:Number(routing.priority), weight:Number(routing.weight)})
      setRouting({priority:String(result.priority),weight:String(result.weight)}); setMessage('라우팅 설정을 저장했습니다.'); onUpdate()
    } catch (error) { setMessage(safeError(error, '라우팅 설정을 저장하지 못했습니다.')) }
    finally { setBusy(false) }
  }
  const saveAccess = async () => {
    if (!selected || !access) return
    setBusy(true); setMessage('')
    try {
      const result = await api.setAccess(selected, {...access, userIds: access.scope === 'all' ? [] : userIds.split('\n').map(id => id.trim()).filter(Boolean)})
      setAccess(result); setUserIds(result.userIds.join('\n')); setMessage('공유 설정을 저장했습니다.')
    } catch (error) { setMessage(safeError(error, '공유 설정을 저장하지 못했습니다.')) }
    finally { setBusy(false) }
  }

  const logout = async () => {
    if (logoutPending.current || !selected || !window.confirm('선택한 공식 ChatGPT 계정에서 로그아웃할까요? 이미 진행 중인 요청은 계속될 수 있습니다.')) return
    logoutPending.current = true
    setBusy(true); setMessage('')
    try {
      const result = await api.logout(selected)
      onUpdate()
      setMessage(result.remoteRevoked ? '이 서버에서 로그아웃했으며 원격 세션 종료가 확인되었습니다. 이미 진행 중인 요청은 계속될 수 있습니다.' : '이 서버에서 로그아웃했지만 원격 세션 종료는 확인되지 않았습니다. ChatGPT 설정에서 앱 연결을 해제하세요. 이미 진행 중인 요청은 계속될 수 있습니다.')
    } catch (error) { setMessage(safeError(error, '로그아웃 결과를 확인하지 못했습니다. 상태를 새로고침하세요.')) }
    finally { logoutPending.current = false; setBusy(false) }
  }

  const start = async (body: { name: string } | { accountId: string } | { retryFlowId: string }) => {
    setMessage('')
    if ('name' in body && !body.name.trim()) { setMessage('계정 이름을 입력하세요.'); return }
    const popup = window.open('', '_blank')
    if (!popup) { setMessage('로그인 팝업이 차단되었습니다. 팝업을 허용하고 다시 시도하세요.'); return }
    popup.opener = null
    setBusy(true)
    try {
      const result = await api.start(body)
      const url = new URL(result.authorizationUrl)
      if (url.origin !== 'https://auth.openai.com' || typeof result.flowId !== 'string') throw new Error('유효하지 않은 로그인 응답입니다.')
      popup.location.replace(url.href)
      setFlow({ id: result.flowId, status: 'pending' })
      setMessage('로그인 창에서 완료한 후 상태 확인을 누르세요.')
    } catch (error) {
      popup.close()
      setMessage(safeError(error, '로그인을 시작하지 못했습니다.'))
    } finally { setBusy(false) }
  }
  const check = async () => {
    if (!flow) return
    setBusy(true); setMessage('')
    try {
      const result = await api.status(flow.id)
      const status = ['pending', 'exchanging', 'complete', 'failed'].includes(result.status) ? result.status : 'unknown'
      setFlow({ id: flow.id, status, retryable: result.retryable })
      if (result.status === 'complete') {
        await api.finish(flow.id)
        setFlow(null); setName(''); setMessage('공식 ChatGPT 계정 연결이 완료되었습니다.')
        await refresh(); onUpdate()
      } else if (result.status === 'failed') setMessage('로그인에 실패했습니다. 다시 시도하세요.')
      else if (result.status === 'pending' || result.status === 'exchanging') setMessage(result.status === 'pending' ? '로그인을 기다리는 중입니다.' : '로그인 정보를 확인하는 중입니다.')
      else setMessage('알 수 없는 로그인 상태입니다. 다시 확인하세요.')
    } catch (error) { setMessage(safeError(error, '상태 확인에 실패했습니다.')) }
    finally { setBusy(false) }
  }

  return <details className="table-container" open>
    <summary>공식 ChatGPT 플랜 로그인</summary>
    <div style={{ padding: 16, display: 'grid', gap: 8 }}>
      <p>공식 Sign in with ChatGPT 연결은 기존 Codex 로그인/가져오기와 별도의 계정 저장소입니다. 계정을 활성화하고 사용자에게 공유하면 명시적 계정 지정이 없는 OpenAI 요청에도 라우팅 전략에 따라 자동 선택될 수 있습니다.</p>
      <p>로그인 콜백은 서버의 127.0.0.1에서 수신됩니다. 브라우저와 서버가 같은 컴퓨터에 있어야 합니다.</p>
      {message && <p role="status">{message}</p>}
      <label>새 계정 이름 <input value={name} maxLength={200} onChange={e => setName(e.target.value)} /></label>
      <div><button className="btn btn-primary" type="button" disabled={busy || !!flow} onClick={() => start({ name: name.trim() })}>공식 로그인 시작</button></div>
      <label>공식 계정 선택 <select disabled={busy} value={selected} onChange={e => setSelected(e.target.value)}><option value="">계정 선택</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} ({account.id})</option>)}</select></label>
      {routing && <fieldset disabled={busy}>
        <legend>계정 라우팅 설정</legend>
        <p>우선순위 전략은 숫자가 작을수록 먼저 선택합니다. 가중치는 라운드로빈의 선택 비율에 적용됩니다. 공유 권한과 활성화 설정은 별도로 필요합니다.</p>
        <label>우선순위 (0~1000) <input type="number" min={0} max={1000} step={1} value={routing.priority} onChange={e => setRouting({...routing,priority:e.target.value})} /></label>{' '}
        <label>가중치 (1~100) <input type="number" min={1} max={100} step={1} value={routing.weight} onChange={e => setRouting({...routing,weight:e.target.value})} /></label>{' '}
        <button type="button" className="btn btn-secondary" onClick={saveRouting}>라우팅 설정 저장</button>
      </fieldset>}
      {access && <fieldset disabled={busy}>
        <legend>계정 공유 권한</legend>
        <p>신규 및 기존 계정은 명시적 설정 전 비공유입니다. 사용자 ID는 사용자 관리 화면에서 확인하세요.</p>
        <label><input type="checkbox" checked={access.enabled} onChange={e => setAccess({...access, enabled:e.target.checked})} /> 계정 사용 활성화</label>{' '}
        <label>공유 범위 <select value={access.scope} onChange={e => setAccess({...access, scope:e.target.value as 'all' | 'selected'})}><option value="selected">특정 사용자</option><option value="all">전체 사용자</option></select></label>
        {access.scope === 'selected' && <label>허용 사용자 ID (한 줄에 하나)<textarea value={userIds} onChange={e => setUserIds(e.target.value)} /></label>}
        <button type="button" className="btn btn-secondary" onClick={saveAccess}>공유 설정 저장</button>
      </fieldset>}
      <div><button className="btn btn-secondary" type="button" disabled={busy || !!flow || !selected} onClick={() => start({ accountId: selected })}>선택 계정 재인증</button>{' '}<button className="btn btn-secondary" type="button" disabled={busy || !selected} onClick={logout}>선택 계정 로그아웃</button>{' '}<button className="btn btn-secondary" type="button" disabled={busy} onClick={() => { setMessage(''); void refresh() }}>목록 새로고침</button></div>
      {selected && <p>특정 계정을 지정하려면 요청에 <code>router_options.siwc_account_id</code> 값으로 <code>{selected}</code>를 명시하세요. 목록 API는 계정의 인증 유효 상태를 제공하지 않습니다.</p>}
      {flow && <div><p>로그인 상태: {flow.status}</p><button className="btn btn-secondary" type="button" disabled={busy} onClick={check}>상태 확인</button>{' '}{flow.status === 'failed' && flow.retryable && <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => start({ retryFlowId: flow.id })}>이 시도 재시도</button>}{' '}<button className="btn btn-secondary" type="button" disabled={busy} onClick={() => { setFlow(null); setMessage('화면에서 시도를 닫았습니다. 서버 시도는 만료될 때까지 유지됩니다.') }}>닫기</button></div>}
    </div>
  </details>
}
