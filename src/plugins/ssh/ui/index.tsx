import { useState } from 'react'
import { api, type PluginUi } from '@mcontrolprogram/ui'
import SshAddHost from './SshAddHost'
import SshCommands, { SshRuleDialog } from './SshCommands'
import SshDeleteHost from './SshDeleteHost'
import SshPublicKey from './SshPublicKey'

/** Prefill for the rule dialog from an ask: block the programs; allow the narrowest thing that lets this line run (written files may still need their own rule). */
function sshTarget(s: any, action: 'allow' | 'block') {
  const progs: string[] = s.programs ?? []
  if (action === 'allow' && s.single) return { action, kind: 'prefix' as const, value: s.single as string, host: s.host, command: s.command }
  return { action, kind: progs.length ? 'program' as const : 'prefix' as const, value: progs.join(' ') || s.command, host: s.host, command: s.command }
}

const ui: PluginUi = {
  Page: ({ plugin }) => <SshCommands hosts={((plugin.globalConfig?.hosts ?? []) as { name: string }[]).map((h) => h.name)} />,
  inventory: {
    hosts: {
      AddButton: function AddHost({ reload }) {
        const [open, setOpen] = useState(false)
        return <>
          <button className="primary" onClick={() => setOpen(true)}>+ Add host (guided)</button>
          {open && <SshAddHost onClose={() => setOpen(false)} onDone={async () => { setOpen(false); await reload() }} />}
        </>
      },
      EditExtra: ({ item }) => (item.auth === 'key' ? <SshPublicKey name={item.name} /> : null),
      // key-auth hosts: offer to remove our public key from the remote authorized_keys first
      Delete: {
        when: (item) => item.auth === 'key',
        Dialog: ({ item, onClose, remove }) => <SshDeleteHost name={item.name} onClose={onClose} onDone={async (removeKey, password) => {
          if (removeKey) await api(`/plugins/ssh/actions/remove_key`, { method: 'POST', body: { name: item.name, password: password || undefined } })
          await remove()
        }} />,
      },
    },
  },
  asks: {
    RuleDialog: ({ approval, action, onClose, onDone }) =>
      approval.feature === 'command' ? <SshRuleDialog init={sshTarget(approval.subject ?? {}, action)} onClose={onClose} onDone={onDone} /> : null,
  },
}
export default ui
