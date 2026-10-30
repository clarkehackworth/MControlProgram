import { useCallback, useEffect, useState } from 'react'

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg) } }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    method: opts.method ?? 'GET', credentials: 'include',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  if (res.status === 401 && !path.startsWith('/auth/')) { window.location.href = '/login'; throw new ApiError(401, 'unauthorized') }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
  if (!res.ok || (data && typeof data === 'object' && 'error' in data && data.error)) throw new ApiError(res.status, data?.error ?? res.statusText)
  return data as T
}

/** Fetch + optional polling. Returns [data, reload, error]. */
export function useApi<T = any>(path: string | null, pollMs = 0): [T | undefined, () => Promise<void>, string | undefined] {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const reload = useCallback(async () => {
    if (!path) return
    try { setData(await api<T>(path)); setError(undefined) } catch (e) { setError((e as Error).message) }
  }, [path])
  useEffect(() => {
    void reload()
    if (!pollMs) return
    const t = setInterval(() => void reload(), pollMs)
    return () => clearInterval(t)
  }, [reload, pollMs])
  return [data, reload, error]
}

export const fmtTime = (v?: string | number | null) => (v ? new Date(v).toLocaleString() : '—')
export const copy = async (s: string) => {
  // navigator.clipboard is undefined on insecure (plain http, non-localhost) origins
  if (navigator.clipboard) return navigator.clipboard.writeText(s)
  const t = document.createElement('textarea')
  t.value = s
  t.style.position = 'fixed'
  t.style.opacity = '0'
  document.body.appendChild(t)
  t.select()
  document.execCommand('copy')
  t.remove()
}

// ---- shared types (mirror backend) ----
export interface PluginMeta { id: string; name: string; version: string; description: string; configSchema: any; defaultConfig: Record<string, any>; source: string; globalConfigSchema?: any; globalConfig?: Record<string, any>; globalActions: { key: string; title: string }[] }
export interface ApprovalPolicy { mode: 'none' | 'writes' | 'all' | 'list'; tools?: string[] }
export interface Instance { id: string; server_id: string; plugin_id: string; name: string; enabled: boolean; config: Record<string, any>; position: number; approval: ApprovalPolicy }
export interface Approval { id: string; server_id: string; instance_id: string; instance_name: string; tool: string; principal: string; session_id?: string; args: any; status: string; attempts: number; decided_by?: string; created_at: number; decided_at?: number; expires_at: number }
export interface InstanceStatus { id: string; name: string; plugin: string; error?: string; tools: string[]; toolInfo?: { name: string; description: string }[]; status?: any; actions?: { key: string; title: string }[] }
export interface Session { id: string; principal: string; client?: string; startedAt: number; lastSeen: number; calls: number }
export interface Server {
  id: string; name: string; description: string; host: string; port: number; enabled: boolean
  auth_mode: 'none' | 'bearer' | 'oauth' | 'both'; log_level: 'off' | 'connections' | 'tools' | 'full'; public_url: string | null; instructions: string
  status: { running: boolean; url?: string; error?: string; startedAt?: number; sessions: Session[]; instances: InstanceStatus[] }
  instances: Instance[]
}
export interface LogRow { id: number; ts: string; level: string; category: string; server_id?: string; plugin_instance_id?: string; session_id?: string; message: string; data?: string | null }
