import { Users, CreditCard, CheckCircle, XCircle } from 'lucide-react'

interface Stats {
  users: { total: number; enabled: number; free: number; pro: number }
  accounts: { total: number; byProvider: Record<string, number>; byStatus: Record<string, number> }
}

export default function Dashboard({ stats }: { stats: Stats | null }) {
  if (!stats) {
    return <div className="loading">데이터를 불러오는 중...</div>
  }

  const { users, accounts } = stats
  
  return (
    <>
      <div className="header">
        <h1>대시보드</h1>
      </div>

      <div className="stats-grid">
        <div className="card">
          <div className="stat-card">
            <div className="stat-icon blue">
              <Users size={24} />
            </div>
            <div>
              <div className="stat-value">{users.total}</div>
              <div className="stat-label">전체 사용자</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="stat-card">
            <div className="stat-icon green">
              <CheckCircle size={24} />
            </div>
            <div>
              <div className="stat-value">{users.enabled}</div>
              <div className="stat-label">활성 사용자</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="stat-card">
            <div className="stat-icon orange">
              <CreditCard size={24} />
            </div>
            <div>
              <div className="stat-value">{accounts.total}</div>
              <div className="stat-label">전체 계정</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="stat-card">
            <div className="stat-icon green">
              <CheckCircle size={24} />
            </div>
            <div>
              <div className="stat-value">{accounts.byStatus.active || 0}</div>
              <div className="stat-label">활성 계정</div>
            </div>
          </div>
        </div>
      </div>

      <div className="stats-grid">
        <div className="card">
          <h3 style={{ marginBottom: 20 }}>제공자별 계정</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Claude (Anthropic)</span>
              <strong>{accounts.byProvider.anthropic || 0}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>ChatGPT (OpenAI)</span>
              <strong>{accounts.byProvider.openai || 0}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Gemini (Google)</span>
              <strong>{accounts.byProvider.google || 0}</strong>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 20 }}>계정 상태</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="status-badge active">활성</span>
              <strong>{accounts.byStatus.active || 0}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="status-badge quota_exceeded">할당량 초과</span>
              <strong>{accounts.byStatus.quota_exceeded || 0}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="status-badge error">오류</span>
              <strong>{accounts.byStatus.error || 0}</strong>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 20 }}>사용자 티어</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="tier-badge pro">Pro</span>
              <strong>{users.pro || 0}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="tier-badge free">Free</span>
              <strong>{users.free || 0}</strong>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}