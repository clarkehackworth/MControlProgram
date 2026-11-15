import { api, type PluginUi } from '@mcontrolprogram/ui'
import McpTools from './McpTools'

// Also imported by plugins that depend on mcp and reuse its tool rules panel (`@plugin/mcp`).
export { default as ToolRules } from './McpTools'

const ui: PluginUi = {
  Page: ({ plugin }) => <McpTools upstreams={((plugin.globalConfig?.servers ?? []) as { name: string }[]).map((s) => s.name)} />,
  asks: {
    // an upstream tool's rule is one switch: Enable / Disable tool, no dialog
    direct: (a) => a.feature === 'mcp_tool',
    setRule: async (a, rule) => { await api(`/plugins/mcp/actions/set_tool_rule`, { method: 'POST', body: { upstream: a.subject?.upstream, tool: a.subject?.tool, action: rule } }) },
  },
}
export default ui
