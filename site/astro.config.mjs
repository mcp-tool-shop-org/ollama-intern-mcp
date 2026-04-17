// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://mcp-tool-shop-org.github.io',
  base: '/ollama-intern-mcp',
  integrations: [
    starlight({
      title: 'ollama-intern-mcp',
      description: 'MCP control plane for local cognitive labor — job-shaped tools with tiered Ollama models (instant/workhorse/deep/embed), server-enforced guardrails, and measured economics so Claude can delegate bulk work without losing control.',
      disable404Route: true,
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/mcp-tool-shop-org/ollama-intern-mcp' },
      ],
      sidebar: [
        {
          label: 'Handbook',
          autogenerate: { directory: 'handbook' },
        },
      ],
      customCss: ['./src/styles/starlight-custom.css'],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
