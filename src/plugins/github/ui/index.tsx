import { api, type PluginUi } from '@mcontrolprogram/ui'
import { ToolRules } from '@plugin/mcp'

const ui: PluginUi = {
  Page: ({ plugin }) => <ToolRules plugin="github" groupLabel="repo" refresh="tool_rules"
    upstreams={((plugin.globalConfig?.repos ?? []) as { name: string }[]).map((r) => r.name)} />,
  asks: {
    // one call asks once for every feature it touches (push + force + sensitive paths): Enable/Disable sets them all
    direct: (a) => a.feature === 'github_tool',
    setRule: async (a, rule) => {
      for (const tool of (a.subject?.features ?? [a.subject?.tool]) as string[])
        await api(`/plugins/github/actions/set_tool_rule`, { method: 'POST', body: { upstream: a.subject?.upstream, tool, action: rule } })
    },
  },
}
export default ui
