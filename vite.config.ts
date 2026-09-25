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
        match: ['https://*/*', 'http://*/*'],
        grant: ['GM.getValue', 'GM.setValue', 'GM.deleteValue', 'GM.xmlHttpRequest'],
        'run-at': 'document-idle',
        noframes: true,
      },
    }),
  ],
});
