/**
 * PwnFox-for-Chromium extensions (header tagger + frame theme), generated per profile colour.
 * Templates come from the PwnFox For Chromium Burp extension (browser-extensions/{header-extension,theme}-template);
 * Burp reads the x-pwnfox-color request header to colour that profile's traffic.
 */
export const PWNFOX_COLORS = ['blue', 'cyan', 'green', 'magenta', 'orange', 'pink', 'yellow'] as const;
export type PwnfoxColor = (typeof PWNFOX_COLORS)[number];
const RGB: Record<PwnfoxColor, string> = { blue: '0, 102, 255', cyan: '0, 200, 220', green: '0, 170, 60', magenta: '210, 0, 210', orange: '255, 140, 0', pink: '255, 105, 180', yellow: '240, 210, 0' };

const RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];

/** Extension dir name → files, ready to be written under <profile dir>/pwnfox/. */
export function pwnfoxExtensions(color: PwnfoxColor): Record<string, Record<string, string>> {
  return {
    [`header-${color}`]: {
      'manifest.json': JSON.stringify({ manifest_version: 3, name: `X-PwnFox-Color Header - ${color}`, version: '1.0', permissions: ['declarativeNetRequest'], host_permissions: ['<all_urls>'], background: { service_worker: 'background.js' } }, null, 2),
      'background.js': `chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ operation: 'set', header: 'x-pwnfox-color', value: '${color}' }] },
    condition: { urlFilter: '*', resourceTypes: ${JSON.stringify(RESOURCE_TYPES)} },
  }],
});
`,
    },
    [`theme-${color}`]: {
      'manifest.json': JSON.stringify({
        name: `PwnFox - ${color}`, version: '1.0', description: 'PwnFox profile colour', manifest_version: 3,
        theme: {
          colors: { frame: RGB[color].split(', ').map(Number), toolbar: [255, 255, 255], tab_text: [60, 64, 67], tab_background_text: [60, 64, 67], bookmark_text: [60, 64, 67], ntp_background: [255, 255, 255], ntp_text: [0, 0, 0], ntp_link: [6, 55, 116], button_background: [0, 0, 0, 0] },
          tints: { buttons: [0, 0, 0.44] },
          properties: { ntp_background_alignment: 'bottom', ntp_background_repeat: 'no-repeat' },
        },
      }, null, 2),
    },
  };
}
