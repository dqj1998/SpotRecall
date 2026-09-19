// Standalone palette window (no page injection). Opened by the toolbar icon or
// the toggle command. Reuses the shared PaletteApp component.

import './palette-page.css';
import { render } from 'preact';
import { PaletteApp } from './palette-app';

render(<PaletteApp onClose={() => window.close()} />, document.getElementById('app')!);
