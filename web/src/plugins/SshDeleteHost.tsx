import { useState } from 'react'
import { Alert, Modal } from '../components/ui'

/** Delete-host flow for key-auth SSH hosts: optionally remove the public key from the remote authorized_keys first. */
export default function SshDeleteHost({ name, onClose, onDone }: { name: string; onClose: () => void; onDone: (removeKey: boolean, password: string) => Promise<void> }) {
  const [removeKey, setRemoveKey] = useState(true)
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string>()
  const [busy, setBusy] = useState(false)
  const go = async () => { setBusy(true); setErr(undefined); try { await onDone(removeKey, pw) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) } }
  return (
    <Modal title={`Delete SSH host — ${name}`} onClose={onClose}>
      {err && <Alert kind="err">{err}</Alert>}
      <label><input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} /> Also remove this host's public key from <code>~/.ssh/authorized_keys</code> on the remote machine</label>
      {removeKey && <>
        <p className="muted small">Uses the stored key to log in. If the key no longer works, enter the account password instead (optional).</p>
        <input type="password" placeholder="password (optional)" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" style={{ width: '100%' }} />
      </>}
      <div className="row between" style={{ marginTop: 12 }}>
        <button onClick={onClose}>Cancel</button>
        <button className="danger" disabled={busy} onClick={go}>{removeKey ? 'Remove key & delete' : 'Delete host'}</button>
      </div>
    </Modal>
  )
}
