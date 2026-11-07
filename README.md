# hudsonmp.me

## Publishing (essays and readings)

The editors live at `/essays/add` and `/readings/add` (no links to them; password protected).

**On hudsonmp.me**: every save is one commit to GitHub via `api/publish.mjs` (logic in `server/`), and Vercel
redeploys about a minute later. It needs two environment variables in the Vercel project (Settings, Environment Variables, Production):

| variable | value |
| --- | --- |
| `PUBLISH_PASSWORD` | the editor password, 12+ characters. Never put it in the repo. |
| `GITHUB_TOKEN` | a fine-grained personal access token for this repository only, permission *Contents: Read and write* |

Optional: `GITHUB_REPO` (default `hudsonmp/hudsonmp.me`), `GITHUB_BRANCH` (default `main`). Without the variables
the endpoints refuse with a message saying what is missing. Wrong passwords are slowed down and locked out after a few tries.

**Locally** (`npm run dev`): the same editors write files into the working tree and you commit them yourself.
Put the same `PUBLISH_PASSWORD` in `.env.local` (ignored by git). Without it the old local-only password still works,
but it is too weak to protect the reader-password list (see below).

**Private essays** are stored encrypted (`src/lib/seal.js`); readers unlock them in the browser. The list of reader
passwords is stored sealed with the publish password in `src/data/reader-passwords.json`, so the same list works
locally and on the site. Signing in locally with a strong `PUBLISH_PASSWORD` migrates an old `.private/essay-passwords.json`
into that file once; commit it. The site and your checkout share a branch, so `git pull` before committing locally
after publishing from the site.

Request size on Vercel is capped (about 4.5 MB), so images are uploaded one at a time: a single image over roughly 3 MB can't be published from the site.
