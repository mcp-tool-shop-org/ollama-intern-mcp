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
      // Starlight emits og:title/description/url and twitter:card, but never an
      // image — so `summary_large_image` was promising an image well it then
      // left blank on every share. Point both at the brand mark (absolute URL:
      // relative og: URLs are not resolved by most unfurlers).
      head: [
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content:
              'https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/ollama-intern-mcp/readme.png',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:image',
            content:
              'https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/ollama-intern-mcp/readme.png',
          },
        },
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/mcp-tool-shop-org/ollama-intern-mcp' },
      ],
      sidebar: [
        {
          label: 'Handbook',
          items: [{ autogenerate: { directory: 'handbook' } }],
        },
      ],
      customCss: ['./src/styles/starlight-custom.css'],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
