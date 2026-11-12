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

Request size on Vercel is capped (about 4.5 MB), so images are uploaded one at a time and split into ~3 MB pieces when larger (25 MB per image maximum).

## Cards (password-gated pages, e.g. `/mom-birthday-2026`)

A photo of a two-page letter behind a password, optionally with a "click here" box on it that opens a collage of
photos (tap one to enlarge; arrows or swipe to move between them; back returns to the letter). Wide screens show the
letter whole, with pinch/click to zoom and drag/scroll to pan; portrait screens split it at the fold into two stacked
pages and keep the phone's own pinch-zoom. The repo is public, so everything is committed only as ciphertext
(`cards/<slug>/*.card`); the password is checked by `api/cards.mjs` (logic in `server/cards.mjs`) and never reaches
the browser.

Vercel environment variables (type *Secret*, Production and Preview), and the same lines in `.env.local`:

| variable | value |
| --- | --- |
| `CARD_KEY` | base64 of 32 random bytes; encrypts every card. Lose it and the cards must be re-sealed. |
| `CARD_PASSWORD_MOM_BIRTHDAY_2026` | the reader password for that card (slug upper-cased, `-` becomes `_`); case-sensitive |

To make or update a card, keep the originals in `.private/cards/<slug>/` (gitignored) and run

```
node scripts/seal-card.mjs <slug> .private/cards/<slug>/photo.jpeg --split 0.499 \
  --hotspot x,y,w,h --photos .private/cards/<slug>/collage --preview /tmp/check.png
```

then commit `cards/<slug>/`. `--split` is where the left page ends and `--hotspot` is the "click here" box, both as
fractions of the letter photo (`--preview` draws them so they can be checked). Collage photos (jpg, png, heic) appear
in file-name order. A new card also needs `src/pages/<slug>.astro` (`<Card slug="<slug>" />`) and its password
variable in Vercel.

Readers stay signed in for 30 days (an HttpOnly cookie scoped to `/__card`); changing the password signs them out.
