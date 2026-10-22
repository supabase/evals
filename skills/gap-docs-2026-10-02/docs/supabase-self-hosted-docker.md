# Prepare a self-hosted Supabase Docker bundle

Use this procedure when you need the upstream Docker Compose deployment files and private configuration ready to transfer to a Linux server. It prepares files only: it does not start containers. It assumes Git and Docker Compose are available for checking the bundle; the target server needs Docker Engine and the Compose plugin before deployment.

## Obtain the complete upstream Docker tree

Choose a self-hosted release tag from the upstream Supabase repository and record it so the bundle can be traced and upgraded deliberately. Replace the example tag below with the release you intend to deploy.

From the repository root, clone the upstream repository at that tag, then copy the *contents* of its `docker/` directory into the requested deployment directory. For example:

```sh
release='self-hosted/<release-tag>'
git clone --depth 1 --branch "$release" https://github.com/supabase/supabase /tmp/supabase-upstream
mkdir -p supabase-docker
cp -R /tmp/supabase-upstream/docker/. supabase-docker/
printf 'ref=%s\n' "$release" > supabase-docker/.supabase-version
cd supabase-docker
cp .env.example .env
```

Adapt the directory and release to your repository and deployment plan. Copying the directory contents preserves the upstream `docker-compose.yml`, helper scripts, Compose overrides, and the `volumes/` database bootstrap and service configuration files. Do not replace this tree with a hand-written partial Compose file.

Keep this deployment bundle separate from the Supabase CLI project configuration (such as `supabase/config.toml` and CLI migrations). If the application also needs a CLI project, maintain that at its normal project path and keep its settings distinct from the server's Docker `.env`.

## Replace secrets and configure URLs

Never deploy with values copied from `.env.example`. Keep `.env` private and out of version control; it contains administrator credentials and signing material. Restrict access to it, for example with `chmod 600 .env`.

Use the upstream scripts from the deployment directory to generate fresh legacy JWT credentials and other generated secrets, then generate the current API key material:

```sh
sh utils/generate-keys.sh --update-env
sh utils/add-new-auth-keys.sh
```

The first script writes a new `JWT_SECRET`, `ANON_KEY`, and `SERVICE_ROLE_KEY` to `.env` along with other secrets. The anon token has the `anon` role and the service token has the `service_role` role; both legacy tokens are HS256-signed using that generated `JWT_SECRET`. The second script fills in the newer asymmetric signing and API key settings used by current upstream configuration. Review both scripts' output and the resulting file locally. Do not paste credentials into reports, logs, chat, shell transcripts, or source control.

Audit the remaining `.env` entries as well. Set the deployment's public URL, Auth external URL, site/redirect URLs, dashboard username and password, and any enabled integration credentials. Remove or replace every shipped example secret that applies to enabled services. Use the actual domain and TLS/reverse-proxy plan; do not leave localhost URLs for a publicly reachable deployment. Preserve valid settings for optional services you do not enable rather than inventing credentials for them.

## Verify the prepared bundle without starting it

Run these checks from `supabase-docker/`:

```sh
test -s docker-compose.yml
test -d volumes/db
test -s .env
docker compose config --quiet
```

Compose config validation parses and resolves the configuration; it does not start services. Inspect that the copied `volumes/` tree contains the upstream database bootstrap files and that the `.env` placeholders and applicable default secrets have been replaced. Do not print the environment file as a verification step.

For an independent, non-disclosing check of legacy JWT signatures, run a local verifier that reads `JWT_SECRET`, `ANON_KEY`, and `SERVICE_ROLE_KEY` from `.env`, computes HMAC-SHA256 over each token's encoded header and payload, compares the result to the token signature, and checks the decoded roles are respectively `anon` and `service_role`. Report only pass/fail and role results. Do not include token values, the secret, decoded signing material, or command output that reveals them. A valid signature confirms the keys match the configured secret; it does not test service health.

Do not run `docker compose up`, `sh run.sh start`, or the upstream quick-start installer as part of file preparation. Transfer the complete `supabase-docker/` directory securely to the server. On the server, review the URLs and firewall/reverse-proxy plan before starting the stack from this directory.
