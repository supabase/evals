# Common base image for the agent's sandbox (both eval modes). It carries the
# general developer tooling every agent run needs; the Supabase CLI is NOT here
# — it's a local-stack component installed at setup time (installSupabaseCli),
# so tools-mode sandboxes genuinely lack it. The only mode difference.
FROM node:22-slim

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git postgresql-client openssh-client \
  && rm -rf /var/lib/apt/lists/*

# Debian's Docker CLI is too old for `supabase stop --no-backup` to delete
# volumes before CLI 2.122.0 (https://github.com/supabase/cli/pull/7177).
COPY --from=docker:27.5.1-cli /usr/local/bin/docker /usr/local/bin/docker

# Global npm installs (both the baked-in skills CLI below and the agent's own
# `npm install -g supabase` at setup time) land in a node-owned prefix instead
# of /usr/local, so they work without root/sudo — matching a typical user's
# machine, where global npm installs "just work" unelevated.
USER node
RUN mkdir -p /home/node/.npm-global
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global

# supabase.sh serves the docs over SSH (`ssh supabase.sh grep ... /supabase/docs`).
# Its host key is pinned, as it would be after a user's first connection, so a
# headless agent isn't stopped by the "trust this host?" prompt.
RUN mkdir -m 700 /home/node/.ssh \
  && echo 'supabase.sh ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCkPknwNl+/kJSMb06YphJZV+3/Rr4suUmiWWYT3tHlrJT13Rdt7efev9ZczPeeHIvVJwnjiMXXrHvcj6rCzq3AS16/0UOspP/6c2MkhWT8fYYJEfRXs2sHk8F1jx7vV632DkycEb5o1ebOO2XxaHiCYXMBedCv2/G2lop0T4aFJWfbJgV5XrypxLn2p+9dzfKypuurQNfzifmMMJRR++B0eGTY49axf3w7d10MXKox1D3jlpYsrnyaAmtJlsvc6d9tlnttLm3LjrJjRen3zOUt3j6p8u/As+CL0FhhmHlM/8kdKXNtOQGHgTYImWZgGKyJa+7ZTijHe9OZtwxfJ84f' > /home/node/.ssh/known_hosts

# Vercel's agent-skills CLI, used to install agent skills from local sources
# into each session's workspace (both modes). Baked in (pinned) so installs are
# offline and instant rather than an npx download per session.
ARG SKILLS_CLI_VERSION
RUN npm install -g "skills@${SKILLS_CLI_VERSION}"
