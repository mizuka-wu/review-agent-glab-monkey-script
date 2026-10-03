import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '#components': resolve(import.meta.dirname, 'src/components'),
      '#lib': resolve(import.meta.dirname, 'src/lib'),
    },
  },
  plugins: [
    react(),
    monkey({
      entry: 'src/main.tsx',
      userscript: {
        name: 'Review Agent for GitLab',
        namespace: 'review-agent-glab',
        description: 'GitLab MR review: local deterministic rules (zero tokens, no API key needed) plus optional streamed AI review, symbol search/call chains, draft-then-publish line discussions.',
        author: 'Review Agent contributors',
        icon: 'https://about.gitlab.com/images/press/press-kit-icon.svg',
        homepage: 'https://github.com/mizuka-wu/review-agent-glab-monkey-script',
        homepageURL: 'https://github.com/mizuka-wu/review-agent-glab-monkey-script',
        supportURL: 'https://github.com/mizuka-wu/review-agent-glab-monkey-script/issues',
        downloadURL: 'https://github.com/mizuka-wu/review-agent-glab-monkey-script/releases/latest/download/review-agent-glab-monkey-script.user.js',
        updateURL: 'https://github.com/mizuka-wu/review-agent-glab-monkey-script/releases/latest/download/review-agent-glab-monkey-script.meta.js',
        match: ['https://*/*', 'http://*/*'],
        grant: ['GM.getValue', 'GM.setValue', 'GM.deleteValue', 'GM.xmlHttpRequest'],
        'run-at': 'document-idle',
        noframes: true,
      },
    }),
  ],
});
