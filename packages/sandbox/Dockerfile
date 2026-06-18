# Sandbox image for cli-interface evals: a developer machine with the
# Supabase CLI installed. Built by ensureSupabaseSandboxImage() with
# --build-arg CLI_VERSION pinned for benchmark comparability (installed from
# the official release .deb; Homebrew's tap only carries the latest version).
FROM node:22-slim

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git docker.io postgresql-client \
  && rm -rf /var/lib/apt/lists/*

ARG CLI_VERSION
RUN ARCH="$(dpkg --print-architecture)" \
  && curl -fsSL "https://github.com/supabase/cli/releases/download/v${CLI_VERSION}/supabase_${CLI_VERSION}_linux_${ARCH}.deb" -o /tmp/supabase.deb \
  && dpkg -i /tmp/supabase.deb \
  && rm /tmp/supabase.deb

# Vercel's agent-skills CLI, used to install agent skills from local sources
# into each session's workspace. Baked in (pinned) so installs are offline and
# instant rather than an npx download per session.
ARG SKILLS_CLI_VERSION
RUN npm install -g "skills@${SKILLS_CLI_VERSION}"
