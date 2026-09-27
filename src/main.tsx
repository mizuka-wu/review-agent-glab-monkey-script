import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { GitLabAdapter } from './core/gitlab-adapter';
import { isGitLabDocument, parseGitLabUrl } from './core/gitlab-url';
import { loadSettings } from './core/settings';
import css from './index.css?inline';

async function mount() {
  const page = parseGitLabUrl(window.location.href, document);
  const shouldMount = isGitLabDocument(document);
  if (!shouldMount || document.getElementById('review-agent-glab-root')) return;

  const host = document.createElement('div');
  host.id = 'review-agent-glab-root';
  document.body.append(host);

  // Shadow DOM isolation: styles injected inside, no GitLab CSS interference
  const shadow = host.attachShadow({ mode: 'open' });

  // Inject Tailwind + component styles into Shadow DOM
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  // Container for React
  const container = document.createElement('div');
  shadow.appendChild(container);

  const settings = await loadSettings();
  ReactDOM.createRoot(container).render(
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
