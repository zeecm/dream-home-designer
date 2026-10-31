import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Welcome } from './Welcome';
import './welcome.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Welcome />
    </StrictMode>,
  );
}
