import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { GitLabAdapter } from './core/gitlab-adapter';
import { isGitLabDocument, parseGitLabUrl } from './core/gitlab-url';
import { loadSettings } from './core/settings';
import './index.css';

async function mount() {
  const page = parseGitLabUrl(window.location.href, document);
  const shouldMount = import.meta.env.DEV || isGitLabDocument(document);
  if (!shouldMount || document.getElementById('review-agent-glab-root')) return;

  const root = document.createElement('div');
  root.id = 'review-agent-glab-root';
  document.body.append(root);
  const settings = await loadSettings();
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App page={page} adapter={new GitLabAdapter(page, settings.gitlabToken)} />
    </React.StrictMode>,
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void mount(), { once: true });
} else {
  void mount();
}
