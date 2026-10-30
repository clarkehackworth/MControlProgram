// Minimal external MControlProgram plugin. Copy this directory to data/plugins/echo (or point
// MCONTROLPROGRAM_PLUGIN_DIRS at its parent) and click "Reload plugins" in the UI.
import { z } from 'zod';

export default {
  id: 'echo',
  name: 'Echo',
  version: '0.1.0',
  description: 'Example plugin: echoes input, demonstrates config, secrets, status and actions.',
  configSchema: {
    type: 'object',
    properties: {
      prefix: { type: 'string', title: 'Prefix', default: '> ' },
      apiKey: { type: 'string', title: 'Example secret', 'x-secret': true, description: 'Encrypted at rest, never shown to agents' },
      uppercase: { type: 'boolean', title: 'Uppercase output', default: false },
    },
  },
  defaultConfig: { prefix: '> ', uppercase: false },

  create(ctx) {
    let calls = 0;
    return {
      start() { ctx.log.info('echo plugin started'); },
      stop() { ctx.log.info('echo plugin stopped'); },
      // MControlProgram-wide defaults are available via ctx.global() (e.g. ctx.global().stateIdleSec for your own reaper)
      status: () => ({ calls, hasApiKey: !!ctx.config.apiKey, stateIdleSec: ctx.global().stateIdleSec }),
      actions: { reset: { title: 'Reset counter', async run() { calls = 0; return { calls }; } } },
      tools: [
        {
          name: 'say',
          description: 'Echo a message back.',
          inputSchema: { message: z.string() },
          annotations: { readOnlyHint: true },
          async handler({ message }, call) {
            calls++;
            call.log.debug('say called', { message });
            const out = ctx.config.prefix + message;
            return { content: [{ type: 'text', text: ctx.config.uppercase ? out.toUpperCase() : out }] };
          },
        },
      ],
    };
  },
};
