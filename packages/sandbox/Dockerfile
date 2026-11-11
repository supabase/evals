# Common base image for the agent's sandbox (both eval modes). It carries the
# general developer tooling every agent run needs; the Supabase CLI is NOT here
# — it's a local-stack component installed at setup time (installSupabaseCli),
# so tools-mode sandboxes genuinely lack it. The only mode difference.
FROM node:22-slim

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git postgresql-client \
  && rm -rf /var/lib/apt/lists/*

# The Docker CLI (talking to the host daemon through the mounted socket), from
# Docker's official static build rather than Debian's package, which ships
# 20.10. With a client older than 23.0, `supabase stop --no-backup`
# on CLI versions before 2.122.0 removes the containers but fails to prune the
# database volume (CLI-2637), so the next run would boot from it.
COPY --from=docker:27.5.1-cli /usr/local/bin/docker /usr/local/bin/docker

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
