import { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, RefreshCw } from 'lucide-react'
import SubscriptionOnboarding from './SubscriptionOnboarding'

const API_BASE = 'http://localhost:20101'

interface Account {
  id: string
  name: string
  provider: string
  credentialType: string
  status: string
  dailyQuota: number
  usedToday: number
  priority: number
  weight: number
  lastUsed: string | null
}

export default function Accounts({ adminKey, onUpdate }: { adminKey: string; onUpdate: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Account | null>(null)
  const [form, setForm] = useState({
    name: '',
    provider: 'anthropic',
    credentialType: 'cookie',
    credentials: '',
    dailyQuota: 50,
    priority: 1,
    weight: 1
  })

  const fetchAccounts = async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/accounts`, {
        headers: { 'Authorization': `Bearer ${adminKey}` }
      })
      if (res.ok) {
        const data = await res.json()
        setAccounts(data.accounts)
      }
    } catch (e) {
      console.error('Failed to fetch accounts:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAccounts()
  }, [adminKey])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const url = editing 
        ? `${API_BASE}/admin/accounts/${editing.id}`
        : `${API_BASE}/admin/accounts`
      const method = editing ? 'PATCH' : 'POST'
      
      const res = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${adminKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(form)
      })
      
      if (res.ok) {
        setShowModal(false)
        setEditing(null)
        setForm({ name: '', provider: 'anthropic', credentialType: 'cookie', credentials: '', dailyQuota: 50, priority: 1, weight: 1 })
        fetchAccounts()
        onUpdate()
      }
    } catch (e) {
      console.error('Failed to save account:', e)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('정말 삭제하시겠습니까?')) return
    try {
      const res = await fetch(`${API_BASE}/admin/accounts/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${adminKey}` }
      })
      if (res.ok) {
        fetchAccounts()
        onUpdate()
      }
    } catch (e) {
      console.error('Failed to delete account:', e)
    }
  }

  const openEdit = (account: Account) => {
    setEditing(account)
    setForm({
      name: account.name,
      provider: account.provider,
      credentialType: account.credentialType,
      credentials: '',
      dailyQuota: account.dailyQuota,
      priority: account.priority,
      weight: account.weight
    })
    setShowModal(true)
  }

  if (loading) return <div className="loading">데이터를 불러오는 중...</div>

  return (
    <>
      <div className="header">
        <h1>계정 관리</h1>
        <button className="btn btn-primary" onClick={() => { setEditing(null); setShowModal(true) }}>
          <Plus size={16} /> 계정 추가
        </button>
      </div>

      <SubscriptionOnboarding adminKey={adminKey} onUpdate={() => { fetchAccounts(); onUpdate() }} />
      <div className="table-container">
        <div className="table-header">
          <h2>업스트림 계정 ({accounts.length})</h2>
          <button className="btn btn-secondary" onClick={fetchAccounts}>
            <RefreshCw size={16} /> 새로고침
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>이름</th>
              <th>제공자</th>
              <th>인증방식</th>
              <th>상태</th>
              <th>사용량</th>
              <th>우선순위</th>
              <th>가중치</th>
              <th>마지막 사용</th>
              <th>작업</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map(account => (
              <tr key={account.id}>
                <td><strong>{account.name}</strong></td>
                <td>{account.provider === 'anthropic' ? 'Claude' : account.provider === 'openai' ? 'ChatGPT' : 'Gemini'}</td>
                <td>{account.credentialType}</td>
                <td>
                  <span className={`status-badge ${account.status}`}>
                    {account.status === 'active' ? '활성' : account.status === 'quota_exceeded' ? '할당량초과' : '오류'}
                  </span>
                </td>
                <td>
                  <div style={{ width: 100 }}>
                    <div style={{ fontSize: 12, marginBottom: 4 }}>
                      {account.usedToday} / {account.dailyQuota === 0 ? '∞' : account.dailyQuota}
                    </div>
                    <div className="progress-bar">
                      <div 
                        className={`progress-fill ${account.dailyQuota > 0 && account.usedToday / account.dailyQuota > 0.8 ? 'danger' : ''}`}
                        style={{ width: account.dailyQuota > 0 ? `${Math.min(100, (account.usedToday / account.dailyQuota) * 100)}%` : '0%' }}
                      />
                    </div>
                  </div>
                </td>
                <td>{account.priority}</td>
                <td>{account.weight}</td>
                <td>{account.lastUsed ? new Date(account.lastUsed).toLocaleString('ko-KR') : '-'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-secondary" style={{ padding: 8 }} onClick={() => openEdit(account)}>
                      <Pencil size={14} />
                    </button>
                    <button className="btn btn-danger" style={{ padding: 8 }} onClick={() => handleDelete(account.id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editing ? '계정 수정' : '계정 추가'}</h2>
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label>이름</label>
                  <input value={form.name} onChange={e => setForm({...form, name: e.target.value})} required placeholder="Claude-A" />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>제공자</label>
                    <select value={form.provider} onChange={e => setForm({...form, provider: e.target.value})}>
                      <option value="anthropic">Claude (Anthropic)</option>
                      <option value="openai">ChatGPT (OpenAI)</option>
                      <option value="google">Gemini (Google)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>인증방식</label>
                    <select value={form.credentialType} onChange={e => setForm({...form, credentialType: e.target.value})}>
                      <option value="cookie">Cookie</option>
                      <option value="session_token">Session Token</option>
                      <option value="api_key">API Key</option>
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label>자격증명 {editing && '(비워두면 기존 값 유지)'}</label>
                  <input value={form.credentials} onChange={e => setForm({...form, credentials: e.target.value})} placeholder={editing ? "••••••••" : "세션 토큰 또는 쿠키"} />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>일일 할당량 (0=무제한)</label>
                    <input type="number" value={form.dailyQuota} onChange={e => setForm({...form, dailyQuota: parseInt(e.target.value)})} min="0" />
                  </div>
                  <div className="form-group">
                    <label>우선순위 (낮을수록 먼저)</label>
                    <input type="number" value={form.priority} onChange={e => setForm({...form, priority: parseInt(e.target.value)})} min="1" />
                  </div>
                </div>
                <div className="form-group">
                  <label>가중치 (라운드로빈 비율)</label>
                  <input type="number" value={form.weight} onChange={e => setForm({...form, weight: parseInt(e.target.value)})} min="1" />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>취소</button>
                <button type="submit" className="btn btn-primary">{editing ? '수정' : '추가'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}