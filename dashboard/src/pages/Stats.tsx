import { useState, useEffect, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'

const API_BASE = 'http://localhost:20101'

interface AccountStats {
  id: string
  name: string
  provider: 'anthropic' | 'openai' | 'google'
  status: 'active' | 'quota_exceeded' | 'error' | 'disabled'
  usedToday: number
  dailyQuota: number
  quotaResetAt: string
}

export function isAccountStatsResponse(value: unknown): value is { accounts: AccountStats[] } {
  if (!value || typeof value !== 'object' || !('accounts' in value) || !Array.isArray(value.accounts)) return false
  return value.accounts.every((account: unknown) => {
    if (!account || typeof account !== 'object') return false
    const a = account as Record<string, unknown>
    return typeof a.id === 'string' && typeof a.name === 'string' &&
      typeof a.provider === 'string' && ['anthropic', 'openai', 'google'].includes(a.provider) &&
      typeof a.status === 'string' && ['active', 'quota_exceeded', 'error', 'disabled'].includes(a.status) &&
      Number.isSafeInteger(a.usedToday) && (a.usedToday as number) >= 0 &&
      typeof a.dailyQuota === 'number' && Number.isFinite(a.dailyQuota) &&
      typeof a.quotaResetAt === 'string' && Number.isFinite(Date.parse(a.quotaResetAt))
  })
}

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444']

export default function Stats({ adminKey }: { adminKey: string }) {
  // A new identity on every key transition also distinguishes A → B → A.
  const request = useMemo(() => ({}), [adminKey])
  const [result, setResult] = useState<{ request: object; accounts: AccountStats[] | null } | null>(null)

  useEffect(() => {
    let active = true

    const fetchStats = async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/accounts`, {
          headers: { 'Authorization': `Bearer ${adminKey}` }
        })
        if (!res.ok) throw new Error('Request failed')
        const data = await res.json()
        if (!isAccountStatsResponse(data)) throw new Error('Invalid response')
        if (active) setResult({ request, accounts: data.accounts })
      } catch {
        if (active) setResult({ request, accounts: null })
      }
    }
    fetchStats()
    return () => { active = false }
  }, [adminKey, request])

  if (!result || result.request !== request) return <div className="loading">데이터를 불러오는 중...</div>
  if (!result.accounts) return <div role="alert">통계를 불러오지 못했습니다. 페이지를 새로고침해 주세요.</div>
  const accountStats = result.accounts

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
    { name: '비활성', value: accountStats.filter(a => a.status === 'disabled').length },
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
            <BarChart data={accountStats.slice(0, 6).map(({ name, usedToday }) => ({ name, usedToday }))}>
              <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 12 }} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} />
              <Tooltip 
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                labelStyle={{ color: '#f1f5f9' }}
              />
              <Bar dataKey="usedToday" name="기존 성공 기록" fill="#3b82f6" radius={[4, 4, 0, 0]} />
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
              <th>기존 성공 기록 (일일 보장 안 됨)</th>
              <th>일일 할당량</th>
              <th>기록된 기존 리셋 시각 (일일 할당량과 별개)</th>
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
                <td>{!Number.isSafeInteger(account.dailyQuota) || account.dailyQuota < 0 ? '알 수 없음' : account.dailyQuota === 0 ? '∞' : account.dailyQuota}</td>
                <td>{account.quotaResetAt ? new Date(account.quotaResetAt).toLocaleTimeString('ko-KR') : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}