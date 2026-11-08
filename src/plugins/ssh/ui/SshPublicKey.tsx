import { useEffect, useState } from 'react'
import { CopyButton, Field, api } from '@mcontrolprogram/ui'

/** Shows the stored key's public half for an existing SSH host (the private key itself never reaches the browser). */
export default function SshPublicKey({ name }: { name: string }) {
  const [key, setKey] = useState<string>()
  const [err, setErr] = useState<string>()
  useEffect(() => {
    api<{ result: { publicKey: string } }>(`/plugins/ssh/actions/public_key`, { method: 'POST', body: { name } })
      .then((r) => setKey(r.result.publicKey), (e) => setErr(e.message))
  }, [name])
  return (
    <Field label="Public key" desc="Install this in the remote account's ~/.ssh/authorized_keys.">
      {key ? <div className="row"><code style={{ flex: 1, wordBreak: 'break-all' }}>{key}</code><CopyButton text={key} /></div> : <span className="muted small">{err ?? 'Loading…'}</span>}
    </Field>
  )
}
