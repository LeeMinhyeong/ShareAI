export type SiwcStart = { name: string } | { accountId: string } | { retryFlowId: string }
export function createSiwcApi(adminKey: string, fetcher?: typeof fetch): {
  list(): Promise<{ accounts: { id: string; name: string }[] }>
  routing(id: string): Promise<{priority: number; weight: number}>
  setRouting(id: string, body: {priority: number; weight: number}): Promise<{priority: number; weight: number}>
  access(id: string): Promise<{enabled: boolean; scope: 'all' | 'selected'; userIds: string[]}>
  setAccess(id: string, body: {enabled: boolean; scope: 'all' | 'selected'; userIds: string[]}): Promise<{enabled: boolean; scope: 'all' | 'selected'; userIds: string[]}>
  logout(id: string): Promise<{localSignedOut: true; remoteRevoked: boolean}>
  start(body: SiwcStart): Promise<{ flowId: string; authorizationUrl: string }>
  status(id: string): Promise<{ status: string; retryable?: boolean; accountId?: string }>
  finish(id: string): Promise<{ accountId: string }>
}
