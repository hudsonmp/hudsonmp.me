/**
 * Serves /__card/* on the dev server (`npm run dev`) with the same handler as the deployed api/cards.mjs.
 * Needs CARD_KEY and CARD_PASSWORD_<SLUG> in .env.local (see server/cards.mjs).
 */
import { fileURLToPath } from 'node:url';
import { serveCards } from '../server/cards.mjs';
import { loadEnv } from './local-publish.mjs';

export default function localCards() {
  let root = process.cwd();
  return {
    name: 'local-cards',
    hooks: {
      'astro:config:done': ({ config }) => {
        root = fileURLToPath(config.root);
      },
      'astro:server:setup': ({ server }) => {
        server.middlewares.use((req, res, next) => {
          if (!(req.url ?? '').startsWith('/__card/')) return next();
          return serveCards(req, res, { env: loadEnv(root), root, local: true });
        });
      },
    },
  };
}
