/** Password-gated cards on the deployed site; vercel.json maps /__card/:action here. Logic: server/cards.mjs. */
import { serveCards } from '../server/cards.mjs';

export default function handler(req, res) {
  return serveCards(req, res, { env: process.env, root: process.cwd() });
}
