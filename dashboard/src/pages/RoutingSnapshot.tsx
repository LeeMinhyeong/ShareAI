import { useEffect, useState } from 'react'

type Entry = {kind:'upstream'|'siwc'; id:string; state:'open'|'restricted'|'cooldown_until'|'no_known_block'|'unavailable'|'unknown'; cooldown_until?:number}
type Snapshot = {as_of:string; note:string; accounts:Entry[]}
export const ROUTING_SNAPSHOT_URL = '/api/admin/routing-snapshot'

function utc(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return 'invalid timestamp'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? `${date.toISOString()} (UTC)` : 'invalid timestamp'
}

export function RoutingSnapshotView({snapshot}: {snapshot:Snapshot}) {
  return <>
    <p>Routing snapshot · {utc(snapshot.as_of)}</p>
    <p>{snapshot.note}</p>
    <p>현재 시점의 참고 정보이며 자동 라우팅이나 복구를 보장하지 않습니다. 시스템 시계가 변경되면 시각도 영향을 받습니다.</p>
    <table><thead><tr><th>종류</th><th>계정 ID</th><th>관찰된 상태</th></tr></thead>
      <tbody>{snapshot.accounts.map(account => <tr key={`${account.kind}:${account.id}`}>
        <td>{account.kind}</td><td>{account.id}</td><td>{account.state === 'open' ? 'OPEN' : account.state === 'restricted' ? <span title="제한 해제 시점은 알 수 없습니다. 관찰 프로세스가 재시작되면 대기 시간이 다시 시작될 수 있습니다.">429 제한 (해제 시점 미상)</span> : account.state === 'cooldown_until' ? `cooldown until ${utc(account.cooldown_until)}` : account.state}</td>
      </tr>)}</tbody>
    </table>
  </>
}

export default function RoutingSnapshot({adminKey}: {adminKey:string}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState(false)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setSnapshot(null); setError(false)
    fetch(ROUTING_SNAPSHOT_URL, {headers:{Authorization:`Bearer ${adminKey}`},signal:controller.signal,cache:'no-store'})
      .then(response => { if (!response.ok) throw new Error('snapshot unavailable'); return response.json() })
      .then(data => { if (!controller.signal.aborted) setSnapshot(data) })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [adminKey,version])
  return <section className="table-container">
    <div className="table-header"><h2>계정 라우팅 스냅샷</h2><button type="button" className="btn btn-secondary" onClick={() => setVersion(v => v + 1)}>새로고침</button></div>
    {error ? <p role="status">라우팅 스냅샷을 불러오지 못했습니다.</p> : snapshot ? <RoutingSnapshotView snapshot={snapshot} /> : <p>불러오는 중...</p>}
  </section>
}
