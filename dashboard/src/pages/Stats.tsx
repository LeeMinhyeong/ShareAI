import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'

const API_BASE = 'http://localhost:20101'

interface UsageLog {
  id: string
  timestamp: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  success: boolean
  latencyMs: number
}

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444']

export default function Stats({ adminKey }: { adminKey: string }) {
  const [accountStats, setAccountStats] = useState<any[]>([])
  const [recentLogs, setRecentLogs] = useState<UsageLog[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStats()
  }, [adminKey])

  const fetchStats = async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/accounts`, {
        headers: { 'Authorization': `Bearer ${adminKey}` }
      })
      if (res.ok) {
        const data = await res.json()
        setAccountStats(data.accounts)
      }
    } catch (e) {
      console.error('Failed to fetch stats:', e)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <div className="loading">데이터를 불러오는 중...</div>

  // Provide별 데이터
  const providerData = [
    { name: 'Claude', value: accountStats.filter(a => a.provider === 'anthropic').length },
    { name: 'ChatGPT', value: accountStats.filter(a => a.provider === 'openai').length },
    { name: 'Gemini', value: accountStats.filter(a => a.provider === 'google').length },
  ].filter(d => d.value > 0)

  // 상태별 데이터
  const statusData = [
    { name: '활성', value: accountStats.filter(a => a.status === 'active').length },
    { name: '할당량초과', value: accountStats.filter(a => a.status === 'quota_exceeded').length },
    { name: '오류', value: accountStats.filter(a => a.status === 'error').length },
  ].filter(d => d.value > 0)

  return (
    <>
      <div className="header">
        <h1>사용 통계</h1>
      </div>

      <div className="stats-grid">
        <div className="card">
          <h3 style={{ marginBottom: 20 }}>제공자별 계정</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={providerData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60}>
                {providerData.map((_, index) => (
                  <Cell key={index} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 16 }}>
            {providerData.map((item, idx) => (
              <div key={item.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: 2, background: COLORS[idx] }} />
                <span style={{ fontSize: 12 }}>{item.name}: {item.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 20 }}>계정 상태</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60}>
                {statusData.map((_, index) => (
                  <Cell key={index} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 16 }}>
            {statusData.map((item, idx) => (
              <div key={item.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 12, height: 12, borderRadius: 2, background: COLORS[idx] }} />
                <span style={{ fontSize: 12 }}>{item.name}: {item.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ gridColumn: 'span 2' }}>
          <h3 style={{ marginBottom: 20 }}>계정별 사용량</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={accountStats.slice(0, 6)}>
              <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 12 }} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} />
              <Tooltip 
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                labelStyle={{ color: '#f1f5f9' }}
              />
              <Bar dataKey="usedToday" name="오늘 사용" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="table-container" style={{ marginTop: 24 }}>
        <div className="table-header">
          <h2>계정별 상세</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>계정</th>
              <th>제공자</th>
              <th>상태</th>
              <th>오늘 사용</th>
              <th>일일 할당량</th>
              <th>리셋 시간</th>
            </tr>
          </thead>
          <tbody>
            {accountStats.map(account => (
              <tr key={account.id}>
                <td><strong>{account.name}</strong></td>
                <td>{account.provider}</td>
                <td>
                  <span className={`status-badge ${account.status}`}>
                    {account.status}
                  </span>
                </td>
                <td>{account.usedToday}</td>
                <td>{account.dailyQuota === 0 ? '∞' : account.dailyQuota}</td>
                <td>{account.quotaResetAt ? new Date(account.quotaResetAt).toLocaleTimeString('ko-KR') : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}