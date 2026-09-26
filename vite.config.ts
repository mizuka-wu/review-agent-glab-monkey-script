import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import monkey from 'vite-plugin-monkey';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    monkey({
      entry: 'src/main.tsx',
      userscript: {
        name: 'Review Agent for GitLab',
        namespace: 'review-agent-glab',
        description: 'Real GitLab diff review, selection chat, and confirmed discussion publishing.',
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
