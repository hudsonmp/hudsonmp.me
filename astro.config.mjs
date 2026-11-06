import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import localPublish from './integrations/local-publish.mjs';

export default defineConfig({
  integrations: [mdx(), localPublish()],
});
