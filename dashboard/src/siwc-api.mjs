export function createSiwcApi(adminKey, fetcher = fetch) {
  const request = async (path, body, base = '/admin/accounts/siwc') => {
    const response = await fetcher(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok) throw new Error(`요청 실패 (HTTP ${response.status})`)
    return response.json()
  }
  return {
    list: () => request('/accounts'),
    routing: id => request(`/accounts/${encodeURIComponent(id)}/routing`),
    setRouting: (id, body) => request(`/accounts/${encodeURIComponent(id)}/routing`, body),
    access: id => request(`/accounts/${encodeURIComponent(id)}/access`),
    setAccess: (id, body) => request(`/accounts/${encodeURIComponent(id)}/access`, body),
    logout: async id => {
      const result = await request(`/accounts/${encodeURIComponent(id)}/logout`, {}, '/admin/siwc')
      if (result?.localSignedOut !== true || typeof result.remoteRevoked !== 'boolean') throw new Error('Invalid logout response')
      return { localSignedOut: true, remoteRevoked: result.remoteRevoked }
    },
    start: body => request('/start', body),
    status: id => request(`/${encodeURIComponent(id)}`),
    finish: id => request(`/${encodeURIComponent(id)}/finish`, {})
  }
}
