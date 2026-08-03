# Common base image for the agent's sandbox (both eval modes). It carries the
# general developer tooling every agent run needs; the Supabase CLI is NOT here
# — it's a local-stack component installed at setup time (installSupabaseCli),
# so tools-mode sandboxes genuinely lack it. The only mode difference.
FROM node:22-slim

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git docker.io postgresql-client \
  && rm -rf /var/lib/apt/lists/*

# Global npm installs (both the baked-in skills CLI below and the agent's own
# `npm install -g supabase` at setup time) land in a node-owned prefix instead
# of /usr/local, so they work without root/sudo — matching a typical user's
# machine, where global npm installs "just work" unelevated.
USER node
RUN mkdir -p /home/node/.npm-global
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global

# Vercel's agent-skills CLI, used to install agent skills from local sources
# into each session's workspace (both modes). Baked in (pinned) so installs are
# offline and instant rather than an npx download per session.
ARG SKILLS_CLI_VERSION
RUN npm install -g "skills@${SKILLS_CLI_VERSION}"
