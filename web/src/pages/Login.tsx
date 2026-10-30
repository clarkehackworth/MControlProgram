import { useState } from 'react'
import { api } from '../api'
import { Alert, Field } from '../components/ui'

export default function Login({ onLogin }: { onLogin: (u: string) => void }) {
  const [username, setU] = useState(''); const [password, setP] = useState(''); const [err, setErr] = useState<string>()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try { const r = await api<{ username: string }>('/auth/login', { method: 'POST', body: { username, password } }); onLogin(r.username) }
    catch (ex) { setErr((ex as Error).message) }
  }
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>🛡 MControlProgram</h1>
        {err && <Alert kind="err">{err}</Alert>}
        <Field label="Username"><input type="text" value={username} onChange={(e) => setU(e.target.value)} autoFocus autoComplete="username" /></Field>
        <Field label="Password"><input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></Field>
        <button className="primary" type="submit" style={{ width: '100%' }}>Sign in</button>
      </form>
    </div>
  )
}
