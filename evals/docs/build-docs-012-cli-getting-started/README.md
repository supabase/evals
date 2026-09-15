# build-docs-012-cli-getting-started

## What this eval measures

The subject is [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), not the
agent. The prompt is a product request plus the page's url, and the checks say whether an agent that read the page
produced working code. A gap in the page counts as a failure here.

One claim: the next person to clone the repository ends up on the same CLI as the person who set it up.

The page leads with installing the CLI into the project rather than onto the machine, and gives pinning the version
as the reason. That is the claim, and it is the half of a local setup that the person who did the setup never
notices is missing.

## Do not reintroduce the vocabulary

The prompt names the outcome. It never names the mechanism, because whether the page transmits the mechanism is the
measurement. Keep all of these out of `PROMPT.md`:

CLI, `supabase init`, `npm`, `npx`, install, dev dependency, `devDependencies`, `package.json`, pin, version,
global, Homebrew, Scoop, Docker, `config.toml`, package runner, project-scoped.

The seed may carry product vocabulary the user would already have in front of them. The line is the prompt.

## The seed carries the contract

`local/` is a small Node project with a `package.json`, a `README.md` that documents `npm install` and `npm run
dev`, and no `supabase/` directory. Two things follow from that.

- **There is a manifest to pin into.** The claim is about what a fresh clone gets, and a repository with no
  `package.json` has nowhere for that to live. The page's recommended method and the seed's existing workflow agree.
- **Supabase is genuinely absent.** `supabase init` has something real to do, and `the repository has a Supabase
  project in it` is the agent's work rather than the seed's.

`skipCliInstall: true` is load-bearing. The harness normally installs the CLI into the sandbox before the agent
starts, which would hand the agent the machine-wide command whose absence is the whole measurement. `projectRunning:
false` follows from it, because the harness cannot start a stack with no CLI.

## Do not drop the positive controls

`the CLI is pinned in the project rather than only on the machine` reads a manifest and is satisfied by a line of
JSON. What makes it mean something is `the pinned CLI is installed in the repository` and `the repository's own copy
of the CLI runs`: together they say the pin corresponds to a binary that exists and works, rather than to a version
string nobody fetched.

`the repository's own copy of the CLI runs` invokes `./node_modules/.bin/supabase` by path. An earlier version ran
`npx --no-install supabase`, which resolves a globally installed binary as happily as a local one, so it passed on a
workspace with no CLI in it at all. The `--no-install` flag stops npx fetching from the registry. It does not stop
it reaching outside the repository.

## The guide has to actually be read

The last check resolves the guide through the harness's own docs result, because a `search_docs` hit carries the url
in its result rather than its request. It requires retrieved content, not just a url that was reached.

Read `docs.calls` before reading the score. Docs evals run on one experiment and it is a no-skills one, so there is
no second arm to rule out prior knowledge. An empty `docs.calls` means the run measured nothing about the page,
whatever the checks say.

## What this eval does not score

- **Whether the stack starts.** `supabase start` is the page's payoff and it is deliberately out of scope. The CLI
  wrapper that restricts the local stack to an eval's declared services is skipped when the agent owns the install,
  so a start here would bring up every service and spend most of the run's budget pulling images. The setup is what
  is scored; `build-docs-002-rls-guide` and its siblings all exercise a running stack.
- **Which install method a machine-wide setup used.** Homebrew, Scoop and the Linux packages are all on the page and
  none of them pins a version per project. The checks ask for the project-scoped outcome the prompt requests, not
  for npm specifically.
- **Whether a global CLI is also present.** Having one is not wrong, and `the repository's own copy of the CLI runs`
  is indifferent to it.
- **Connecting to a hosted project.** The page's own subtitle promises deploying to the platform and the page never
  covers `login` or `link`. That is a gap in the page rather than something an agent following it could satisfy, so
  no check asks for it.

## A risk worth knowing

**This is the narrowest eval in the docs set, and deliberately so.** Four checks, none of which runs the stack. The
page's distinctive content is the install shape, and the rest of it is two commands that a model is unlikely to get
wrong. Expect saturation, and read the fixtures rather than the score for evidence that the checks can fail.

**`npm install -g supabase` works.** Reports that a global npm install is unsupported describe older CLI versions;
the current one installs and runs. No check treats a global install as an error, only as something that does not
satisfy a request for a reproducible setup.

**The pinned range is not compared against anything.** A caret range and an exact version both pass. Asserting an
exact pin would fail the page's own `npm install --save-dev` default, which writes a caret.
