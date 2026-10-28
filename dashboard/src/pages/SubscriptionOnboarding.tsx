import { useState } from 'react'

const API_BASE = 'http://localhost:20101'
export default function SubscriptionOnboarding({ adminKey, onUpdate }: { adminKey: string; onUpdate: () => void }) {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState('anthropic')
  const [credentials, setCredentials] = useState('')
  const [code, setCode] = useState('')
  const [flow, setFlow] = useState<{ flowId: string; authUrl: string; callbackListening: boolean } | null>(null)
  const [message, setMessage] = useState('')
  const request = async (path: string, body?: object) => {
    const response = await fetch(`${API_BASE}/admin/accounts/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    const data = await response.json()
    if (!response.ok) throw new Error('request failed')
    return data
  }
  const begin = async (importing: boolean) => {
    setMessage('')
    if (!name.trim()) { setMessage('계정 이름을 입력하세요.'); return }
    try {
      const data = await request(importing ? 'import' : 'oauth/start', { name, provider, ...(importing ? { credentials } : {}) })
      setCredentials('')
      if (importing) { setName(''); setMessage('계정이 추가되었습니다.'); onUpdate() }
      else setFlow(data)
    } catch { setMessage('계정을 연결하지 못했습니다. 입력값을 확인하세요.') }
  }
  const check = async (finish: boolean) => {
    if (!flow) return
    try {
      const data = await request(`oauth/${flow.flowId}${finish ? '/finish' : ''}`, finish ? { code } : undefined)
      setCode('')
      if (data.status === 'done') { setFlow(null); setName(''); setMessage('계정이 추가되었습니다.'); onUpdate() }
      else setMessage(data.status === 'error' ? '로그인에 실패했습니다. 다시 시작하세요.' : '로그인 완료를 기다리는 중입니다.')
    } catch { setCode(''); setMessage('로그인 확인에 실패했습니다. 세션과 코드를 확인하세요.') }
  }
  return <details className="table-container">
    <summary>Claude / ChatGPT 구독 계정 연결</summary>
    <div style={{ padding: 16, display: 'grid', gap: 8 }}>
      {message && <p role="status">{message}</p>}
      {flow ? <>
        <a href={flow.authUrl} target="_blank" rel="noopener noreferrer">로그인 창 열기</a>
        <p>{flow.callbackListening ? '로그인 후 완료 확인을 누르세요. 자동 콜백이 실패하면 URL을 붙여넣으세요.' : '로그인 후 code#state 또는 콜백 URL 전체를 붙여넣으세요.'}</p>
        <input type="password" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} placeholder="code#state 또는 콜백 URL" />
        <div><button type="button" onClick={() => check(true)}>코드 제출</button>{' '}<button type="button" onClick={() => check(false)}>완료 확인</button>{' '}<button type="button" onClick={() => { setFlow(null); setCode(''); setMessage('') }}>취소</button></div>
      </> : <>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="계정 이름" />
        <select value={provider} onChange={e => setProvider(e.target.value)}><option value="anthropic">Claude</option><option value="openai">ChatGPT</option></select>
        <button type="button" onClick={() => begin(false)}>브라우저 로그인</button>
        <textarea autoComplete="off" value={credentials} onChange={e => setCredentials(e.target.value)} placeholder="또는 Claude/Codex 자격증명 JSON 붙여넣기" />
        <button type="button" onClick={() => begin(true)}>자격증명 가져오기</button>
      </>}
    </div>
  </details>
}
