import path from 'node:path';

// ponytail: env-only global config; everything else lives in the DB and is edited via the UI.
export const config = {
  dataDir: process.env.MCONTROLPROGRAM_DATA_DIR ?? path.resolve('data'),
  adminHost: process.env.MCONTROLPROGRAM_ADMIN_HOST ?? '127.0.0.1',
  adminPort: Number(process.env.MCONTROLPROGRAM_ADMIN_PORT ?? 7700),
  /** Hex/base64 32-byte key. If unset, a keyfile is generated in dataDir. */
  masterKey: process.env.MCONTROLPROGRAM_MASTER_KEY,
  /** Optional non-interactive bootstrap. If password is unset, the UI shows a one-time setup page. */
  initialAdminUser: process.env.MCONTROLPROGRAM_ADMIN_USER ?? 'admin',
  initialAdminPassword: process.env.MCONTROLPROGRAM_ADMIN_PASSWORD,
  /** Extra directories to scan for plugins (colon separated). */
  pluginDirs: (process.env.MCONTROLPROGRAM_PLUGIN_DIRS ?? '').split(':').filter(Boolean),
  /** Public base URL for OAuth issuer, e.g. https://mcontrolprogram.example.com. Per-server override exists. */
  publicUrl: process.env.MCONTROLPROGRAM_PUBLIC_URL,
};
