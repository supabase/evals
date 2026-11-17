# build-docs-018-redirect-urls

## What this eval measures

The [Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls) guide, not the agent. The agent
gets a list of everywhere the team runs its app and a product request: sign-in links should bring
people back to where they started, and nowhere else. If an agent that read the page leaves links that
can't reach a preview, or that send people to someone else's site, the page didn't carry it.

## Do not reintroduce the vocabulary

The prompt leaves these out on purpose: redirect, redirectTo, Site URL, site_url, allow list,
additional_redirect_urls, wildcard, glob, `*`, `**`, config.toml.

"Live site", "preview" and "local dev" stay, because that's how the team would say it.

## What "refused" means

Auth doesn't reject a link to an unlisted destination. It quietly swaps in the Site URL. So the scorer
asks Auth for a sign-in link to each destination and reads back the one it kept. The page never
mentions this fallback, and it's why so many reports say the email "looks unchanged".

Two things are always allowed whatever the list says: the Site URL's own scheme, host and port, and
loopback IPs. That's why no test destination uses `127.0.0.1`, and why a broken live-site pattern only
shows up if the Site URL isn't the live site.

## The seed carries the contract

- `DEPLOYMENTS.md` lists the live site, the Vercel team slug with two example previews, and local dev,
  plus the two return paths. The paths are two segments deep, so `/*` misses them.
- `config.toml` is the `supabase init` default: Site URL `http://127.0.0.1:3000`. That's the
  "opens localhost" bug the prompt describes.

## Do not drop the positive controls

- "sign-in links refuse destinations the team doesn't own" passes for an empty list.
  "sign-in links can return to the live site, previews and local dev" is what makes it mean something,
  and the reverse is true for a `**` catch-all.
- The outsiders are someone else's site, a lookalike that starts with the live host
  (`book.harbourstudio.nz.evil.example.com`), and another Vercel team's preview.

## The scorer restarts the stack

Auth reads its settings when its container is created, so the scorer runs `supabase stop` then
`supabase start` inside the sandbox. The harness wrapper adds the eval's service excludes to `start`.
This was the first docs scorer to restart the stack.

## The guide has to actually be read

"the agent read the redirect URLs guide the prompt referenced" fails unless a docs call returned the
page's content. Read `docs.calls` before the score.

## What this eval does not score

- **Client code passing `redirectTo`.** There's no app in the seed. The claim is about what Auth accepts.
- **Email templates (`{{ .RedirectTo }}`).** A separate section of the page.
- **Mobile deep links and OAuth providers.** The prompt asks for neither.
- **Another Vercel account naming a project `x-harbour-studio`.** The page's own pattern accepts it, so
  it belongs in a docs ticket rather than a check.
- **The hosted dashboard setting.** The prompt asks for the local project.
