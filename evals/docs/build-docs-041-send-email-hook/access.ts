import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';
import type { Stack } from '../lib/local-stack.js';
import { sqlLiteral } from './probes.js';

export const SEALED =
  'app users cannot reach outbox rows through exposed tables, views, the email event or owner-rights functions naming the outbox';

const APP_ROLES = ['anon', 'authenticated'] as const;

export function sealedNotRun(message: string): CheckResult {
  return { name: SEALED, passed: false, notes: `not run: ${message}` };
}

export async function checkSealed(
  ctx: Pick<LocalStackEvalContext, 'exec' | 'hostWorkspace'>,
  stack: Stack,
  userId: string
): Promise<CheckResult> {
  const run = randomUUID().slice(0, 8);
  const marker = `outbox-marker-${run}@example.test`;
  const outsider = `outsider-${run}@example.test`;
  const subject = userId || randomUUID();
  const result = await execSql(
    ctx,
    accessScan({
      schemas: exposedSchemas(ctx.hostWorkspace),
      marker,
      outsider,
      userId: subject,
      event: hookEvent(subject, outsider, `${stack.apiUrl}/auth/v1`),
    }),
    { tuplesOnly: true }
  );
  if (!result.ok) {
    return {
      name: SEALED,
      passed: false,
      notes: `the scan failed: ${result.message}`,
    };
  }
  const lines = result.stdout.split('\n').map((line) => line.trim());
  const listed = (prefix: string) =>
    (lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? '')
      .split('|')
      .filter((entry) => entry.length > 0);
  const hits = listed('HITS:');
  const unclear = listed('UNCLEAR:');
  const refused = listed('REFUSED:');
  if (hits.length > 0) {
    return { name: SEALED, passed: false, notes: hits.join('; ') };
  }
  if (unclear.length > 0) {
    return {
      name: SEALED,
      passed: false,
      notes: `could not tell, a read failed for a reason other than missing permission: ${unclear.join('; ')}`,
    };
  }
  return {
    name: SEALED,
    passed: true,
    notes: [
      'anon and authenticated read no outbox row, insert none, add none through a function that takes the email event, and can run no owner-rights function that names the outbox',
      refused.length > 0
        ? `calls that raised an error and left the outbox unchanged: ${refused.join('; ')}`
        : '',
    ]
      .filter((part) => part.length > 0)
      .join('; '),
  };
}

function exposedSchemas(workspace: string): string[] {
  try {
    const config = readFileSync(
      join(workspace, 'supabase', 'config.toml'),
      'utf8'
    );
    const listed = /^schemas\s*=\s*\[([^\]]*)\]/m.exec(config)?.[1] ?? '';
    const schemas = [...listed.matchAll(/"([^"]+)"/g)]
      .map((match) => match[1])
      .filter((name): name is string => Boolean(name));
    return schemas.length > 0
      ? [...new Set([...schemas, 'public'])]
      : ['public', 'graphql_public'];
  } catch {
    return ['public', 'graphql_public'];
  }
}

function hookEvent(userId: string, email: string, authUrl: string) {
  const now = new Date().toISOString();
  return {
    user: {
      id: userId,
      aud: 'authenticated',
      role: 'authenticated',
      email,
      phone: '',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {
        email,
        email_verified: false,
        phone_verified: false,
        sub: userId,
      },
      identities: [],
      created_at: now,
      updated_at: now,
      is_anonymous: false,
    },
    email_data: {
      token: '482913',
      token_hash: randomUUID().replaceAll('-', '').repeat(2).slice(0, 56),
      redirect_to: 'http://127.0.0.1:3000',
      email_action_type: 'signup',
      site_url: authUrl,
      token_new: '',
      token_hash_new: '',
      old_email: '',
      old_phone: '',
      provider: '',
      factor_type: '',
    },
  };
}

function accessScan(input: {
  schemas: string[];
  marker: string;
  outsider: string;
  userId: string;
  event: object;
}): string {
  const schemas = `array[${input.schemas.map((schema) => sqlLiteral(schema)).join(', ')}]::text[]`;
  const claims = (role: (typeof APP_ROLES)[number]) =>
    sqlLiteral(
      JSON.stringify(
        role === 'anon' ? { role } : { sub: input.userId, role, aud: role }
      )
    );
  return `
    begin;
    insert into public.outbox (to_email, subject, html)
    values (${sqlLiteral(input.marker)}, 'Outbox probe', '<p>Outbox probe</p>');
    do $$
    declare
      schemas text[] := ${schemas};
      app_roles text[] := array[${APP_ROLES.map((role) => sqlLiteral(role)).join(', ')}];
      claims jsonb := jsonb_build_object('anon', ${claims('anon')}::jsonb, 'authenticated', ${claims('authenticated')}::jsonb);
      event text := ${sqlLiteral(JSON.stringify(input.event))};
      pattern text := ${sqlLiteral(`%${input.marker}%`)};
      app_role text;
      target record;
      before bigint;
      after bigint;
      seen boolean;
      hits text[] := '{}';
      unclear text[] := '{}';
      refused text[] := '{}';
    begin
      foreach app_role in array app_roles loop
        for target in
          select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = any(schemas)
            and p.prosecdef
            and p.prosrc ilike '%outbox%'
            and has_schema_privilege(app_role, n.oid, 'usage')
            and has_function_privilege(app_role, p.oid, 'execute')
            and not exists (
              select 1 from pg_depend d
              where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
            )
        loop
          hits := hits || format('%s can run %I.%I(%s), which runs as its owner and names the outbox', app_role, target.nspname, target.proname, target.args);
        end loop;

        for target in
          select n.nspname, p.proname, format_type(p.proargtypes[0], null) as argtype
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = any(schemas)
            and p.prokind = 'f'
            and p.pronargs = 1
            and p.proargtypes[0] in ('jsonb'::regtype, 'json'::regtype)
            and not exists (
              select 1 from pg_depend d
              where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
            )
        loop
          select count(*) into before from public.outbox;
          begin
            execute format('set local role %I', app_role);
            perform set_config('request.jwt.claims', (claims ->> app_role), true);
            execute format('select %I.%I($1::%s)', target.nspname, target.proname, target.argtype) using event;
            execute 'reset role';
          exception when others then
            if sqlstate <> '42501' then
              refused := refused || format('%s calling %I.%I: %s %s', app_role, target.nspname, target.proname, sqlstate, left(sqlerrm, 120));
            end if;
          end;
          select count(*) into after from public.outbox;
          if after > before then
            hits := hits || format('%s gets an email into the outbox by calling %I.%I', app_role, target.nspname, target.proname);
          end if;
        end loop;

        for target in
          select n.nspname, c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p', 'v', 'm', 'f')
            and n.nspname = any(schemas)
            and not exists (
              select 1 from pg_depend d
              where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
            )
        loop
          seen := false;
          begin
            execute format('set local role %I', app_role);
            perform set_config('request.jwt.claims', (claims ->> app_role), true);
            execute format('select exists (select 1 from %I.%I t where t::text like %L)', target.nspname, target.relname, pattern)
              into seen;
            execute 'reset role';
          exception when others then
            seen := false;
            if sqlstate <> '42501' then
              unclear := unclear || format('%s reading %I.%I: %s %s', app_role, target.nspname, target.relname, sqlstate, left(sqlerrm, 120));
            end if;
          end;
          if seen then
            hits := hits || format('%s reads outbox rows from %I.%I', app_role, target.nspname, target.relname);
          end if;
        end loop;

        select count(*) into before from public.outbox;
        begin
          execute format('set local role %I', app_role);
          perform set_config('request.jwt.claims', (claims ->> app_role), true);
          insert into public.outbox (to_email, subject, html)
          values (${sqlLiteral(input.outsider)}, 'Outbox probe', '<p>Outbox probe</p>');
          execute 'reset role';
        exception when others then
          if sqlstate <> '42501' then
            refused := refused || format('%s inserting into public.outbox: %s %s', app_role, sqlstate, left(sqlerrm, 120));
          end if;
        end;
        select count(*) into after from public.outbox;
        if after > before then
          hits := hits || format('%s inserts into public.outbox', app_role);
        end if;
      end loop;

      perform set_config('eval.hits', array_to_string(hits, '|'), true);
      perform set_config('eval.unclear', array_to_string(unclear, '|'), true);
      perform set_config('eval.refused', array_to_string(refused, '|'), true);
    end $$;
    select 'HITS:' || current_setting('eval.hits', true);
    select 'UNCLEAR:' || current_setting('eval.unclear', true);
    select 'REFUSED:' || current_setting('eval.refused', true);
    rollback;
  `;
}
