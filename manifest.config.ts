import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

// SpotRecall — Chrome MV3 manifest.
// Zero runtime network dependency: the embedding model is bundled and loaded
// only from packaged resources (see offscreen/embedder + CSP wasm-unsafe-eval).
export default defineManifest({
  manifest_version: 3,
  name: 'SpotRecall',
  description: 'Local-First Context & Entry Recall — find where you were before.',
  version: pkg.version,
  minimum_chrome_version: '116',
  icons: {
    '16': 'src/ui/assets/icon16.png',
    '48': 'src/ui/assets/icon48.png',
    '128': 'src/ui/assets/icon128.png',
  },
  action: {
    default_title: 'SpotRecall',
    default_icon: {
      '16': 'src/ui/assets/icon16.png',
      '48': 'src/ui/assets/icon48.png',
      '128': 'src/ui/assets/icon128.png',
    },
    default_popup: 'src/ui/palette-page.html',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/capture.ts'],
      run_at: 'document_idle',
      all_frames: true,
      match_about_blank: false,
    },
  ],
  options_page: 'src/ui/options.html',
  commands: {
    // Special command that opens the action popup (anchored dropdown panel).
    _execute_action: {
      suggested_key: {
        default: 'Ctrl+Shift+K',
        mac: 'Command+Shift+K',
      },
    },
  },
  permissions: [
    'tabs',
    'storage',
    'unlimitedStorage',
    'webNavigation',
    'offscreen',
    'alarms',
    'favicon',
  ],
  host_permissions: ['<all_urls>'],
  content_security_policy: {
    // wasm-unsafe-eval required for Transformers.js WASM backend in offscreen.
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
});
