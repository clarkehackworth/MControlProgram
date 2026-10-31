import { useState } from 'react'
import { api } from '../api'
import { Alert, CopyButton, Field, Modal } from '../components/ui'

/**
 * Guided "add SSH host" flow for the ssh plugin. Each step is one stateless plugin action;
 * the private key is generated and stored on the server and never reaches the browser.
 */
type Step = 'details' | 'key' | 'install' | 'done'

export default function SshAddHost({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<Step>('details')
  const [f, setF] = useState({ name: '', host: '', port: 22, username: '', description: '', auth: 'key' as 'key' | 'password' | 'agent', password: '', keySource: 'generate' as 'generate' | 'manual', keyType: 'ed25519' as 'ed25519' | 'rsa', privateKey: '', passphrase: '' })
  const [result, setResult] = useState<any>()
  const [copyPw, setCopyPw] = useState('')
  const [copyResult, setCopyResult] = useState<any>()
  const [test, setTest] = useState<any>()
  const [err, setErr] = useState<string>()
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: any) => setF({ ...f, [k]: v })
  const act = async (fn: () => Promise<void>) => { setBusy(true); setErr(undefined); try { await fn() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) } }
  const action = (key: string, body: any) => api<{ result: any }>(`/plugins/ssh/actions/${key}`, { method: 'POST', body }).then((r) => r.result)

  const create = () => act(async () => {
    const r = await action('add_host', f)
    setResult(r)
    setStep(f.auth === 'key' ? 'install' : 'done')
  })

  return (
    <Modal title={`Add SSH host${f.name ? ` — ${f.name}` : ''}`} onClose={onClose}>
      <div className="row small muted" style={{ marginBottom: 12, gap: 12 }}>
        {(['details', 'key', 'install', 'done'] as Step[]).map((s, i) => <span key={s} style={{ fontWeight: step === s ? 700 : 400, color: step === s ? 'var(--fg)' : undefined }}>{i + 1}. {{ details: 'Host', key: 'Authentication', install: 'Install key', done: 'Done' }[s]}</span>)}
      </div>
      {err && <Alert kind="err">{err}</Alert>}

      {step === 'details' && (
        <>
          <div className="grid2">
            <Field label="Name" desc="What agents call it, e.g. prod-web-1"><input value={f.name} onChange={(e) => set('name', e.target.value.trim())} autoFocus /></Field>
            <Field label="Description (optional)"><input value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
            <Field label="Hostname / IP"><input value={f.host} onChange={(e) => set('host', e.target.value.trim())} /></Field>
            <Field label="Port"><input type="number" value={f.port} onChange={(e) => set('port', Number(e.target.value))} /></Field>
            <Field label="Username"><input value={f.username} onChange={(e) => set('username', e.target.value.trim())} /></Field>
          </div>
          <Field label="How should MControlProgram authenticate?">
            <div className="stack">
              <label className="check"><input type="radio" checked={f.auth === 'key'} onChange={() => set('auth', 'key')} /> SSH key (recommended) — MControlProgram holds the private key</label>
              <label className="check"><input type="radio" checked={f.auth === 'password'} onChange={() => set('auth', 'password')} /> Password — stored encrypted, used on every connection</label>
              <label className="check"><input type="radio" checked={f.auth === 'agent'} onChange={() => set('auth', 'agent')} /> Local ssh-agent of the MControlProgram process (SSH_AUTH_SOCK)</label>
            </div>
          </Field>
          {f.auth === 'password' && <Field label="Password"><input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" /></Field>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="primary" disabled={busy || !f.name || !f.host || !f.username || (f.auth === 'password' && !f.password)}
              onClick={() => (f.auth === 'key' ? setStep('key') : create())}>{f.auth === 'key' ? 'Next' : 'Add host'}</button>
          </div>
        </>
      )}

      {step === 'key' && (
        <>
          <Field label="Where does the key come from?">
            <div className="stack">
              <label className="check"><input type="radio" checked={f.keySource === 'generate'} onChange={() => set('keySource', 'generate')} /> Generate a new key pair in MControlProgram (private key never leaves the server)</label>
              <label className="check"><input type="radio" checked={f.keySource === 'manual'} onChange={() => set('keySource', 'manual')} /> Paste an existing private key</label>
            </div>
          </Field>
          {f.keySource === 'generate'
            ? <Field label="Key type"><select value={f.keyType} onChange={(e) => set('keyType', e.target.value)}><option value="ed25519">ed25519 (recommended)</option><option value="rsa">RSA 3072 (older servers)</option></select></Field>
            : <>
              <Field label="Private key (PEM / OpenSSH)"><textarea value={f.privateKey} onChange={(e) => set('privateKey', e.target.value)} style={{ minHeight: 140, fontFamily: 'monospace' }} /></Field>
              <Field label="Passphrase (if the key is encrypted)"><input type="password" value={f.passphrase} onChange={(e) => set('passphrase', e.target.value)} autoComplete="off" /></Field>
            </>}
          <div className="row between">
            <button onClick={() => setStep('details')}>Back</button>
            <button className="primary" disabled={busy || (f.keySource === 'manual' && !f.privateKey)} onClick={create}>{f.keySource === 'generate' ? 'Generate & add host' : 'Add host'}</button>
          </div>
        </>
      )}

      {step === 'install' && result && (
        <>
          <Alert kind="ok">Host <b>{result.name}</b> saved. Now install this public key on <code>{f.username}@{f.host}</code> so MControlProgram can log in.</Alert>
          <Field label="Public key"><div className="row"><code style={{ flex: 1, wordBreak: 'break-all' }}>{result.publicKey}</code><CopyButton text={result.publicKey} /></div></Field>
          <div className="card sub">
            <h3>Option A: install it with a password (like ssh-copy-id)</h3>
            <p className="muted small">MControlProgram logs in once with the password, appends the key to <code>~/.ssh/authorized_keys</code>, then verifies key login. The password is not stored.</p>
            <div className="row">
              <input type="password" placeholder={`password for ${f.username}`} value={copyPw} onChange={(e) => setCopyPw(e.target.value)} autoComplete="off" style={{ flex: 1 }} />
              <button className="primary" disabled={busy || !copyPw} onClick={() => act(async () => { setCopyResult(await action('copy_id', { name: result.name, password: copyPw })); setCopyPw('') })}>Install key</button>
            </div>
            {copyResult && <Alert kind={copyResult.keyLogin ? 'ok' : 'err'}>{copyResult.keyLogin ? 'Key installed and verified: MControlProgram can log in with the key.' : 'Key appended, but key login still failed. Check sshd config (PubkeyAuthentication, AuthorizedKeysFile) and home directory permissions.'}</Alert>}
          </div>
          <div className="card sub">
            <h3>Option B: install it manually</h3>
            <p className="muted small">Append the public key as one line to <code>{result.authorizedKeysPath}</code>. On the host, as <code>{f.username}</code>:</p>
            <div className="row"><pre style={{ flex: 1, margin: 0, whiteSpace: 'pre-wrap' }}>{result.oneLiner}</pre><CopyButton text={result.oneLiner} /></div>
            <ol className="small muted" style={{ marginTop: 8 }}>{result.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>
          </div>
          <div className="row between">
            <button disabled={busy} onClick={() => act(async () => setTest(await action('test_host', { name: result.name })))}>Test connection</button>
            {test && <span className={test.ok ? 'ok' : 'err'}>{test.ok ? `✓ connected in ${test.ms} ms` : 'failed'}</span>}
            <button className="primary" onClick={() => setStep('done')}>Finish</button>
          </div>
        </>
      )}

      {step === 'done' && (
        <>
          <Alert kind="ok">Host <b>{result?.name ?? f.name}</b> is in the inventory. Expose it on an MCP server by selecting it in that server's ssh plugin instance.</Alert>
          {result?.publicKey && <p className="muted small">Use "Pair server" on the host row to make it available to an MCP server.</p>}
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="primary" onClick={onDone}>Close</button></div>
        </>
      )}
    </Modal>
  )
}
