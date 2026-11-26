import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import type { SqlResult } from '../lib/exec-sql.js';

const SEEDED_KEY = '7c1e94b0a3f25d68e0b947c2d51a8f36b2e07d4c9a15f803';

const CHECK = {
  stored: 'the signing key is stored in the vault',
  notInDatabase: 'the signing key is not in plain text in the database',
  notInRepo: 'the signing key is not in a file the repo would commit',
  link: 'a signed-in user gets a link the CDN accepts',
  rotated: 'links follow a change of the signing key',
  hidden: 'app users cannot read the signing key',
} as const;

const CDN_ORIGIN = 'https://cdn.plantly.example/';
const LINK_LIFETIME_SECONDS = 15 * 60;
const LIFETIME_SLACK_SECONDS = 120;
const APP_ROLES = ['anon', 'authenticated'] as const;

export type Run = (sql: string) => Promise<SqlResult>;
type Exec = Pick<LocalStackEvalContext, 'exec'>;
type Outcome<T> = ({ ok: true } & T) | { ok: false; message: string };

export async function checkKeyNotInRepo(ctx: Exec): Promise<CheckResult> {
  const listed = await ctx.exec(
    [
      'git init -q >/dev/null 2>&1',
      `git ls-files -z --cached --others --exclude-standard -- . ':(exclude)node_modules' ':(exclude)**/node_modules/**' | xargs -0 grep -lF -- '${SEEDED_KEY}' 2>/dev/null`,
      'echo "LISTED:$?"',
    ].join('; ')
  );
  const output = nonEmptyLines(listed.stdout ?? '');
  const status = output.find((line) => line.startsWith('LISTED:'));
  if (!status) {
    return {
      name: CHECK.notInRepo,
      passed: false,
      notes: `could not list the repo files: ${(listed.stderr ?? '').slice(0, 300)}`,
    };
  }
  const hits = output.filter((line) => !line.startsWith('LISTED:'));
  return {
    name: CHECK.notInRepo,
    passed: hits.length === 0,
    notes:
      hits.length === 0
        ? 'no file outside .gitignore carries the key'
        : `found in ${hits.join(', ')}`,
  };
}

export async function checkKeyStored(
  run: Run,
  workspace: string
): Promise<CheckResult> {
  const result = await run(
    `select count(*) from vault.decrypted_secrets where decrypted_secret = ${sqlLiteral(SEEDED_KEY)};`
  );
  if (!result.ok) {
    return { name: CHECK.stored, passed: false, notes: result.message };
  }
  const count = Number(result.stdout.trim());
  if (count > 0) {
    return {
      name: CHECK.stored,
      passed: true,
      notes: `${count} vault entr${count === 1 ? 'y holds' : 'ies hold'} the key`,
    };
  }
  return {
    name: CHECK.stored,
    passed: false,
    notes: configNamesVault(workspace)
      ? 'no vault entry holds the key; config.toml has a [db.vault] section, but the stack was not reset or restarted after it was added'
      : 'no vault entry holds the key',
  };
}

function configNamesVault(workspace: string): boolean {
  try {
    return readFileSync(
      join(workspace, 'supabase', 'config.toml'),
      'utf8'
    ).includes('[db.vault]');
  } catch {
    return false;
  }
}

export async function checkKeyNotInDatabase(run: Run): Promise<CheckResult> {
  const result = await run(plainTextScan());
  if (!result.ok) {
    return { name: CHECK.notInDatabase, passed: false, notes: result.message };
  }
  const hits = nonEmptyLines(result.stdout);
  return {
    name: CHECK.notInDatabase,
    passed: hits.length === 0,
    notes:
      hits.length === 0
        ? 'no table, function, trigger, view, policy, constraint, default, comment or setting carries the key'
        : `found in ${hits.join(', ')}`,
  };
}

function plainTextScan(): string {
  const pattern = sqlLiteral(`%${SEEDED_KEY}%`);
  return `
    create function pg_temp.tables_containing(pattern text) returns setof text
    language plpgsql as $$
    declare
      target record;
      hit boolean;
    begin
      for target in
        select n.nspname, c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p')
          and n.nspname not in ('pg_catalog', 'information_schema', 'vault', 'supabase_migrations')
          and n.nspname not like 'pg_toast%'
          and n.nspname not like 'pg_temp%'
      loop
        begin
          execute format('select exists (select 1 from %I.%I t where t::text like %L)', target.nspname, target.relname, pattern)
            into hit;
          if hit then
            return next format('table %I.%I', target.nspname, target.relname);
          end if;
        exception when others then
          null;
        end;
      end loop;
    end $$;

    with user_namespaces as (
      select n.oid, n.nspname
      from pg_namespace n
      where n.nspname not in ('pg_catalog', 'information_schema', 'vault')
        and n.nspname not like 'pg_toast%'
        and n.nspname not like 'pg_temp%'
    ),
    user_functions as (
      select p.*, n.nspname
      from pg_proc p
      join user_namespaces n on n.oid = p.pronamespace
      where not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
    )
    select place from (
      select pg_temp.tables_containing(${pattern}) as place
      union all
      select format('function %I.%I', f.nspname, f.proname)
      from user_functions f
      where f.prosrc like ${pattern}
        or array_to_string(f.proconfig, ',') like ${pattern}
      union all
      select format('trigger %I on %s', t.tgname, t.tgrelid::regclass)
      from pg_trigger t
      where not t.tgisinternal
        and encode(t.tgargs, 'escape') like ${pattern}
      union all
      select format('view %I.%I', v.schemaname, v.viewname)
      from pg_views v
      join user_namespaces n on n.nspname = v.schemaname
      where v.definition like ${pattern}
      union all
      select format('policy %I on %s', p.polname, p.polrelid::regclass)
      from pg_policy p
      where coalesce(pg_get_expr(p.polqual, p.polrelid), '') like ${pattern}
        or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like ${pattern}
      union all
      select format('constraint %I on %s', c.conname, c.conrelid::regclass)
      from pg_constraint c
      join user_namespaces n on n.oid = c.connamespace
      where c.contype = 'c'
        and pg_get_constraintdef(c.oid) like ${pattern}
      union all
      select format('default on %s.%I', d.adrelid::regclass, a.attname)
      from pg_attrdef d
      join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      where pg_get_expr(d.adbin, d.adrelid) like ${pattern}
      union all
      select 'comment on ' || pg_describe_object(d.classoid, d.objoid, d.objsubid)
      from pg_description d
      where d.description like ${pattern}
      union all
      select 'database or role setting'
      from pg_db_role_setting s
      where array_to_string(s.setconfig, ',') like ${pattern}
    ) found;
  `;
}

type LinkProbe = Outcome<{ url: string; filePath: string }>;

export async function requestLink(run: Run): Promise<LinkProbe> {
  const filePath = `reports/eval-${randomUUID().slice(0, 8)}.pdf`;
  const seeded = await run(
    `insert into public.reports (title, file_path) values ('Eval report', ${sqlLiteral(filePath)});`
  );
  const result = await run(`
    ${asAppUser('authenticated')}
    select 'LINK:' || public.signed_download_url(file_path => ${sqlLiteral(filePath)})::text;
    rollback;
  `);
  if (!result.ok) {
    const note = seeded.ok
      ? ''
      : ` (the scorer could not add the report row first: ${seeded.message})`;
    return {
      ok: false,
      message: `signed_download_url failed for a signed-in user: ${result.message}${note}`,
    };
  }
  const line = nonEmptyLines(result.stdout).find((entry) =>
    entry.startsWith('LINK:')
  );
  const url = line ? /https:\/\/\S+/.exec(line.slice(5))?.[0] : undefined;
  if (!url) {
    return {
      ok: false,
      message: `signed_download_url returned no link: ${line ?? 'nothing'}`,
    };
  }
  return { ok: true, url, filePath };
}

export function checkLinkAccepted(probe: LinkProbe): CheckResult {
  return verdict(CHECK.link, probe, SEEDED_KEY);
}

async function rotateKey(run: Run): Promise<Outcome<{ key: string }>> {
  const key = randomBytes(24).toString('hex');
  const result = await run(`
    select vault.update_secret(id, ${sqlLiteral(key)})
    from vault.decrypted_secrets
    where decrypted_secret = ${sqlLiteral(SEEDED_KEY)};
    select count(*) from vault.decrypted_secrets where decrypted_secret = ${sqlLiteral(key)};
  `);
  if (!result.ok) return { ok: false, message: result.message };
  const changed = Number(nonEmptyLines(result.stdout).at(-1));
  return changed > 0
    ? { ok: true, key }
    : {
        ok: false,
        message:
          'no vault entry held the key, so the scorer had nothing to change',
      };
}

export async function checkLinkFollowsRotation(run: Run): Promise<CheckResult> {
  const rotated = await rotateKey(run);
  if (!rotated.ok) {
    return { name: CHECK.rotated, passed: false, notes: rotated.message };
  }
  return verdict(CHECK.rotated, await requestLink(run), rotated.key);
}

function verdict(name: string, probe: LinkProbe, key: string): CheckResult {
  if (!probe.ok) return { name, passed: false, notes: probe.message };
  const problem = linkProblem(probe.url, probe.filePath, key);
  return {
    name,
    passed: problem === undefined,
    notes: problem ?? probe.url,
  };
}

function linkProblem(
  url: string,
  filePath: string,
  key: string
): string | undefined {
  if (!URL.canParse(url)) return `not a url: ${url}`;
  const parsed = new URL(url);
  if (`${parsed.origin}${parsed.pathname}` !== `${CDN_ORIGIN}${filePath}`) {
    return `expected ${CDN_ORIGIN}${filePath}, got ${parsed.origin}${parsed.pathname}`;
  }
  const expires = parsed.searchParams.get('expires') ?? '';
  const signature = parsed.searchParams.get('signature') ?? '';
  if (!/^\d+$/.test(expires)) return `expires is not unix seconds: ${expires}`;
  const lifetime = Number(expires) - Math.floor(Date.now() / 1000);
  if (Math.abs(lifetime - LINK_LIFETIME_SECONDS) > LIFETIME_SLACK_SECONDS) {
    return `the link expires in ${lifetime}s, not about ${LINK_LIFETIME_SECONDS}s`;
  }
  const expected = createHmac('sha256', key)
    .update(`${filePath}:${expires}`)
    .digest('hex');
  return signature === expected
    ? undefined
    : `the signature does not match the current signing key: ${url}`;
}

export async function checkKeyHidden(run: Run): Promise<CheckResult> {
  const handles = await vaultHandles(run);
  if (!handles.ok) {
    return { name: CHECK.hidden, passed: false, notes: handles.message };
  }
  const findings: string[] = [];
  for (const role of APP_ROLES) {
    const result = await run(roleScan(role, handles.values));
    if (!result.ok) {
      findings.push(`${role}: the scan failed: ${result.message}`);
      continue;
    }
    const line = nonEmptyLines(result.stdout).find((entry) =>
      entry.startsWith('HITS:')
    );
    const hits = (line?.slice(5) ?? '')
      .split('|')
      .filter((hit) => hit.length > 0);
    findings.push(...hits.map((hit) => `${role} reads it from ${hit}`));
  }
  return {
    name: CHECK.hidden,
    passed: findings.length === 0,
    notes:
      findings.length === 0
        ? 'anon and authenticated read no table, view or public function that returns the key'
        : findings.join('; '),
  };
}

async function vaultHandles(run: Run): Promise<Outcome<{ values: string[] }>> {
  const result = await run(`
    select id::text from vault.decrypted_secrets where decrypted_secret = ${sqlLiteral(SEEDED_KEY)}
    union
    select name from vault.decrypted_secrets where decrypted_secret = ${sqlLiteral(SEEDED_KEY)} and name is not null;
  `);
  return result.ok
    ? { ok: true, values: nonEmptyLines(result.stdout) }
    : { ok: false, message: result.message };
}

function asAppUser(role: (typeof APP_ROLES)[number]): string {
  const claims = JSON.stringify(
    role === 'anon' ? { role } : { sub: randomUUID(), role }
  );
  return `
    begin;
    set local role ${role};
    set local "request.jwt.claims" = ${sqlLiteral(claims)};
  `;
}

function roleScan(role: (typeof APP_ROLES)[number], handles: string[]): string {
  const handleArray = `array[${handles.map((handle) => sqlLiteral(handle)).join(', ')}]::text[]`;
  return `
    ${asAppUser(role)}
    do $$
    declare
      pattern text := ${sqlLiteral(`%${SEEDED_KEY}%`)};
      handles text[] := ${handleArray};
      handle text;
      target record;
      hit boolean;
      returned text;
      hits text[] := '{}';
    begin
      for target in
        select n.nspname, c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm', 'f')
          and n.nspname not in ('pg_catalog', 'information_schema')
          and n.nspname not like 'pg_toast%'
          and has_schema_privilege(n.oid, 'usage')
          and has_table_privilege(c.oid, 'select')
          and not exists (
            select 1 from pg_depend d
            where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
          )
      loop
        begin
          execute format('select exists (select 1 from %I.%I t where t::text like %L)', target.nspname, target.relname, pattern)
            into hit;
          if hit then
            hits := hits || format('%I.%I', target.nspname, target.relname);
          end if;
        exception when others then
          null;
        end;
      end loop;

      for target in
        select p.proname, p.pronargs, p.proargtypes
        from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.prokind = 'f'
          and p.prorettype not in ('void'::regtype, 'trigger'::regtype, 'event_trigger'::regtype)
          and has_function_privilege(p.oid, 'execute')
          and (
            p.pronargs = p.pronargdefaults
            or (p.pronargs = 1 and p.proargtypes[0] in ('text'::regtype, 'varchar'::regtype, 'uuid'::regtype))
          )
      loop
        if target.pronargs = 0
          or target.proargtypes[0] not in ('text'::regtype, 'varchar'::regtype, 'uuid'::regtype) then
          begin
            execute format('select (public.%I())::text', target.proname) into returned;
            if returned like pattern then
              hits := hits || format('public.%I()', target.proname);
            end if;
          exception when others then
            null;
          end;
        else
          foreach handle in array handles loop
            begin
              execute format('select (public.%I(%L::%s))::text', target.proname, handle, target.proargtypes[0]::regtype)
                into returned;
              if returned like pattern then
                hits := hits || format('public.%I(%L)', target.proname, handle);
              end if;
            exception when others then
              null;
            end;
          end loop;
        end if;
      end loop;

      perform set_config('eval.hits', array_to_string(hits, '|'), true);
    end $$;
    select 'HITS:' || current_setting('eval.hits', true);
    rollback;
  `;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function nonEmptyLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
