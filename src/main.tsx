// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import 'katex/dist/katex.min.css';
// Warm Bento kit first: Writer's tokens.css is an alias layer over it, so it must come after.
import './design/warm-bento/tokens.css';
import './design/warm-bento/components.css';
import './design/tokens.css';
import './ui/app.css';
import './ui/editor/editor.css';

const container = document.getElementById('root');
if (!container) throw new Error('Élément racine introuvable.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
