import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './design/tokens.css';
import './ui/app.css';
import './editor/editor.css';
import 'prosemirror-view/style/prosemirror.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Élément racine #root introuvable dans index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
