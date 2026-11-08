import type { PluginUi } from '@mcontrolprogram/ui'
import WebTraffic, { UrlRuleDialog, urlTarget } from './WebTraffic'

// Also imported by plugins that depend on web and reuse its rules panel (`@plugin/web`).
export { default as WebTraffic, UrlRuleDialog, urlTarget, urlNoQuery, fmt } from './WebTraffic'
export type { TrafficFlavor, Req, Target } from './WebTraffic'

const ui: PluginUi = {
  Page: () => <WebTraffic />,
  asks: {
    RuleDialog: ({ approval, action, onClose, onDone }) =>
      <UrlRuleDialog plugin={approval.plugin_id} init={urlTarget(approval.subject ?? {}, action)} onClose={onClose} onDone={onDone} />,
  },
}
export default ui
