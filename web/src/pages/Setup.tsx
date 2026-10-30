import { useState } from 'react'
import { api } from '../api'
import { Alert, Field } from '../components/ui'

export default function Setup({ onDone }: { onDone: (u: string) => void }) {
  const [username, setU] = useState('admin'); const [password, setP] = useState(''); const [confirm, setC] = useState(''); const [err, setErr] = useState<string>()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirm) return setErr('passwords do not match')
    try { const r = await api<{ username: string }>('/setup', { method: 'POST', body: { username, password } }); onDone(r.username) }
    catch (ex) { setErr((ex as Error).message) }
  }
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>🛡 MControlProgram setup</h1>
        <p className="muted">No administrator exists yet. Create the admin account that will manage this gateway. This page disappears once an admin exists.</p>
        {err && <Alert kind="err">{err}</Alert>}
        <Field label="Admin username"><input type="text" value={username} onChange={(e) => setU(e.target.value)} autoFocus autoComplete="username" required /></Field>
        <Field label="Password (min 8 chars)"><input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="new-password" minLength={8} required /></Field>
        <Field label="Confirm password"><input type="password" value={confirm} onChange={(e) => setC(e.target.value)} autoComplete="new-password" required /></Field>
        <button className="primary" type="submit" style={{ width: '100%' }}>Create admin and continue</button>
      </form>
    </div>
  )
}
