import { useState, useEffect } from 'react'
import { Users, CreditCard, Activity, Settings, BarChart3, Plus, RefreshCw } from 'lucide-react'
import Dashboard from './pages/Dashboard'
import Accounts from './pages/Accounts'
import UsersPage from './pages/Users'
import Stats from './pages/Stats'

const API_BASE = 'http://localhost:20101'

type Page = 'dashboard' | 'accounts' | 'users' | 'stats'

interface Stats {
  users: { total: number; enabled: number; free: number; pro: number }
  accounts: { total: number; byProvider: Record<string, number>; byStatus: Record<string, number> }
}

function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [stats, setStats] = useState<Stats | null>(null)
  const [adminKey, setAdminKey] = useState('')
  const [showKeyModal, setShowKeyModal] = useState(!localStorage.getItem('adminKey'))

  useEffect(() => {
    const saved = localStorage.getItem('adminKey')
    if (saved) {
      setAdminKey(saved)
      setShowKeyModal(false)
    }
  }, [])

  const saveKey = (key: string) => {
    localStorage.setItem('adminKey', key)
    setAdminKey(key)
    setShowKeyModal(false)
  }

  const refreshStats = async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/stats`, {
        headers: { 'Authorization': `Bearer ${adminKey}` }
      })
      if (res.ok) {
        const data = await res.json()
        setStats(data)
      }
    } catch (e) {
      console.error('Failed to fetch stats:', e)
    }
  }

  useEffect(() => {
    if (adminKey) {
      refreshStats()
      const interval = setInterval(refreshStats, 30000)
      return () => clearInterval(interval)
    }
  }, [adminKey])

  const navItems = [
    { id: 'dashboard', label: '대시보드', icon: BarChart3 },
    { id: 'accounts', label: '계정 관리', icon: CreditCard },
    { id: 'users', label: '사용자 관리', icon: Users },
    { id: 'stats', label: '사용 통계', icon: Activity },
  ]

  if (showKeyModal) {
    return (
      <div className="modal-overlay">
        <div className="modal">
          <div className="modal-header">
            <h2>관리자 키 입력</h2>
          </div>
          <div className="modal-body">
            <p style={{ marginBottom: 16, color: 'var(--text-secondary)' }}>
              관리자 대시보드에 접근하려면 API 키가 필요합니다.
            </p>
            <div className="form-group">
              <label>Admin API Key</label>
              <input
                type="password"
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
                placeholder="admin_dev_key_change_in_production"
              />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-primary" onClick={() => saveKey(adminKey)}>
              확인
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-icon">
            <RefreshCw size={20} />
          </div>
          다계정 라우터
        </div>
        
        <nav className="nav">
          {navItems.map(item => (
            <div
              key={item.id}
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => setPage(item.id as Page)}
            >
              <item.icon size={18} />
              {item.label}
            </div>
          ))}
        </nav>

        <div style={{ marginTop: 'auto', padding: 16 }}>
          <button className="btn btn-secondary" style={{ width: '100%' }} onClick={refreshStats}>
            <RefreshCw size={16} /> 새로고침
          </button>
          <button
            className="btn"
            style={{ width: '100%', marginTop: 8, background: 'transparent', color: 'var(--text-secondary)' }}
            onClick={() => { localStorage.removeItem('adminKey'); setShowKeyModal(true); }}
          >
            키 변경
          </button>
        </div>
      </aside>

      <main className="main">
        {page === 'dashboard' && <Dashboard stats={stats} />}
        {page === 'accounts' && <Accounts adminKey={adminKey} onUpdate={refreshStats} />}
        {page === 'users' && <UsersPage adminKey={adminKey} onUpdate={refreshStats} />}
        {page === 'stats' && <Stats adminKey={adminKey} />}
      </main>
    </div>
  )
}

export default App