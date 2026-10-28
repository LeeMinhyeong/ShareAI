import { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, RefreshCw, Copy } from 'lucide-react'

const API_BASE = '/api'

interface User {
  id: string
  name: string
  email: string
  tier: string
  dailyLimit: number
  enabled: boolean
  createdAt: string
}

export default function UsersPage({ adminKey, onUpdate }: { adminKey: string; onUpdate: () => void }) {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    email: '',
    tier: 'free',
    dailyLimit: 100
  })

  const fetchUsers = async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/users`, {
        headers: { 'Authorization': `Bearer ${adminKey}` }
      })
      if (res.ok) {
        const data = await res.json()
        setUsers(data.users)
      }
    } catch (e) {
      console.error('Failed to fetch users:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUsers()
  }, [adminKey])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const res = await fetch(`${API_BASE}/admin/users`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(form)
      })
      
      if (res.ok) {
        const data = await res.json()
        setCreatedKey(data.apiKey)
        setShowModal(false)
        setForm({ name: '', email: '', tier: 'free', dailyLimit: 100 })
        fetchUsers()
        onUpdate()
      }
    } catch (e) {
      console.error('Failed to create user:', e)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('정말 삭제하시겠습니까?')) return
    // Delete 구현
  }

  const copyKey = (key: string) => {
    navigator.clipboard.writeText(key)
    alert('API 키가 클립보드에 복사되었습니다.')
  }

  if (loading) return <div className="loading">데이터를 불러오는 중...</div>

  return (
    <>
      <div className="header">
        <h1>사용자 관리</h1>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          <Plus size={16} /> 사용자 추가
        </button>
      </div>

      <div className="table-container">
        <div className="table-header">
          <h2>사용자 목록 ({users.length})</h2>
          <button className="btn btn-secondary" onClick={fetchUsers}>
            <RefreshCw size={16} /> 새로고침
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>이름</th>
              <th>이메일</th>
              <th>티어</th>
              <th>일일 제한</th>
              <th>상태</th>
              <th>생성일</th>
              <th>작업</th>
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <tr key={user.id}>
                <td><strong>{user.name}</strong></td>
                <td>{user.email}</td>
                <td><span className={`tier-badge ${user.tier}`}>{user.tier}</span></td>
                <td>{user.dailyLimit}</td>
                <td>
                  <span className={`status-badge ${user.enabled ? 'active' : 'error'}`}>
                    {user.enabled ? '활성' : '비활성'}
                  </span>
                </td>
                <td>{new Date(user.createdAt).toLocaleDateString('ko-KR')}</td>
                <td>
                  <button className="btn btn-secondary" style={{ padding: 8 }}>
                    <Pencil size={14} />
                  </button>
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
              <h2>사용자 추가</h2>
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label>이름</label>
                  <input value={form.name} onChange={e => setForm({...form, name: e.target.value})} required />
                </div>
                <div className="form-group">
                  <label>이메일</label>
                  <input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} required />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>티어</label>
                    <select value={form.tier} onChange={e => setForm({...form, tier: e.target.value})}>
                      <option value="free">Free</option>
                      <option value="pro">Pro</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>일일 제한</label>
                    <input type="number" value={form.dailyLimit} onChange={e => setForm({...form, dailyLimit: parseInt(e.target.value)})} min="1" />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>취소</button>
                <button type="submit" className="btn btn-primary">추가</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {createdKey && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h2>API 키 생성 완료</h2>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: 16, color: 'var(--warning)' }}>
                ⚠️ 이 키는 한 번만 표시됩니다. 반드시 저장해주세요!
              </p>
              <div className="api-key">
                <code>{createdKey}</code>
                <button className="btn btn-secondary" onClick={() => copyKey(createdKey)}>
                  <Copy size={14} />
                </button>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setCreatedKey(null)}>확인</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}