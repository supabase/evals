create function pg_temp.eval_findings(phase text)
returns setof text
language plpgsql
as $probe$
declare
  excluded constant text[] := array['_timescaledb_cache', '_timescaledb_catalog', '_timescaledb_config', '_timescaledb_internal', 'auth', 'cron', 'extensions', 'graphql', 'graphql_public', 'information_schema', 'net', 'pgmq', 'pgroonga', 'pgsodium', 'pgsodium_masks', 'pgtle', 'pgbouncer', 'pg_catalog', 'realtime', 'repack', 'storage', 'supabase_functions', 'supabase_migrations', 'tiger', 'topology', 'vault', '_analytics', '_realtime', '_supavisor'];
  check_schema text;
  fn record;
  issue jsonb;
  doc text;
  usr record;
  n bigint;
  m bigint;
  total text;
begin
  begin
    for fn in
      select x.name, x.object from (
        select 'rls_disabled_in_public' as name, n.nspname || '.' || c.relname as object
          from pg_catalog.pg_class c join pg_catalog.pg_namespace n on c.relnamespace = n.oid
         where c.relkind = 'r' and not c.relrowsecurity
           and (pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') or pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT'))
           and n.nspname = any(array(select trim(unnest(string_to_array(coalesce(current_setting('pgrst.db_schemas', 't'), 'public'), ',')))))
           and n.nspname <> all(excluded)
        union all
        select 'policy_exists_rls_disabled', n.nspname || '.' || c.relname
          from pg_catalog.pg_policy p join pg_catalog.pg_class c on p.polrelid = c.oid join pg_catalog.pg_namespace n on c.relnamespace = n.oid
          left join pg_catalog.pg_depend dep on c.oid = dep.objid and dep.deptype = 'e'
         where c.relkind = 'r' and n.nspname <> all(excluded) and not c.relrowsecurity and dep.objid is null
         group by n.nspname, c.relname
        union all
        select 'function_search_path_mutable', p.oid::regprocedure::text
          from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on p.pronamespace = n.oid
          left join pg_catalog.pg_depend dep on p.oid = dep.objid and dep.deptype = 'e'
         where n.nspname <> all(excluded) and n.nspname not like 'pg\_temp\_%' and n.nspname not like 'pg\_toast\_temp\_%'
           and dep.objid is null
           and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) as config where config like 'search_path=%')
        union all
        select 'auth_rls_initplan', pb.schemaname || '.' || pb.tablename || ' policy ' || pb.policyname
          from pg_catalog.pg_policy pa join pg_catalog.pg_class pc on pa.polrelid = pc.oid
          join pg_catalog.pg_namespace nsp on pc.relnamespace = nsp.oid
          join pg_catalog.pg_policies pb on pc.relname = pb.tablename and nsp.nspname = pb.schemaname and pa.polname = pb.policyname
         where pc.relrowsecurity and nsp.nspname <> all(excluded)
           and (
             (pb.qual like '%auth.uid()%' and lower(pb.qual) not like '%select auth.uid()%')
             or (pb.qual like '%auth.jwt()%' and lower(pb.qual) not like '%select auth.jwt()%')
             or (pb.qual like '%auth.role()%' and lower(pb.qual) not like '%select auth.role()%')
             or (pb.qual like '%auth.email()%' and lower(pb.qual) not like '%select auth.email()%')
             or (pb.qual like '%current\_setting(%)%' and lower(pb.qual) not like '%select current\_setting(%)%')
             or (pb.with_check like '%auth.uid()%' and lower(pb.with_check) not like '%select auth.uid()%')
             or (pb.with_check like '%auth.jwt()%' and lower(pb.with_check) not like '%select auth.jwt()%')
             or (pb.with_check like '%auth.role()%' and lower(pb.with_check) not like '%select auth.role()%')
             or (pb.with_check like '%auth.email()%' and lower(pb.with_check) not like '%select auth.email()%')
             or (pb.with_check like '%current\_setting(%)%' and lower(pb.with_check) not like '%select current\_setting(%)%')
           )
      ) x order by 1, 2
    loop
      return next json_build_object('phase', phase, 'probe', 'advisor', 'name', fn.name, 'object', fn.object)::text;
    end loop;
    return next json_build_object('phase', phase, 'probe', 'advisor-done')::text;
  exception when others then
    return next json_build_object('phase', phase, 'probe', 'advisor-error', 'error', sqlerrm)::text;
  end;

  begin
    select e.extnamespace::regnamespace::text into check_schema from pg_catalog.pg_extension e where e.extname = 'plpgsql_check';
    for fn in
      select p.oid, p.oid::regprocedure::text as signature
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on p.pronamespace = n.oid join pg_catalog.pg_language l on p.prolang = l.oid
       where l.lanname = 'plpgsql' and p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
         and n.nspname <> all(excluded) and n.nspname not like 'pg\_%'
       order by 2
    loop
      for doc in execute format('select %I.plpgsql_check_function($1, format := %L)', check_schema, 'json') using fn.oid loop
        for issue in select * from jsonb_array_elements(coalesce(doc::jsonb -> 'issues', '[]'::jsonb)) loop
          return next json_build_object('phase', phase, 'probe', 'lint', 'function', fn.signature, 'level', issue ->> 'level', 'message', issue ->> 'message')::text;
        end loop;
      end loop;
    end loop;
    return next json_build_object('phase', phase, 'probe', 'lint-done')::text;
  exception when others then
    return next json_build_object('phase', phase, 'probe', 'lint-error', 'error', sqlerrm)::text;
  end;
end;
$probe$;


create function pg_temp.eval_behaviour(phase text, subs text[])
returns setof text
language plpgsql
as $probe$
declare
  usr record;
  order_count bigint;
  item_count bigint;
  totals json;
  stamped boolean;
begin
  for usr in
    select s.sub, 'authenticated' as role from unnest(subs) with ordinality as s(sub, n)
    union all
    select null, 'anon'
  loop
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', usr.sub, 'role', usr.role)::text, true);
      perform set_config('request.jwt.claim.sub', coalesce(usr.sub, ''), true);
      perform set_config('role', usr.role, true);
      execute 'select count(*) from public.orders' into order_count;
      execute 'select count(unit_price) from public.order_items' into item_count;
      execute 'select coalesce(json_agg(public.order_total(p_order_id => o.id)::text order by o.id), ''[]'') from public.orders o' into totals;
      perform set_config('role', 'none', true);
      return next json_build_object('phase', phase, 'probe', 'reader', 'role', usr.role, 'sub', usr.sub,
        'orders', order_count, 'items', item_count, 'totals', totals)::text;
    exception when others then
      return next json_build_object('phase', phase, 'probe', 'reader-error', 'role', usr.role, 'sub', usr.sub,
        'sqlstate', sqlstate, 'error', sqlerrm)::text;
    end;
  end loop;

  begin
    execute 'update public.orders set updated_at = ''2000-01-01'' where id = 1 returning updated_at = now()' into stamped;
    return next json_build_object('phase', phase, 'probe', 'trigger', 'stamped', stamped)::text;
  exception when others then
    return next json_build_object('phase', phase, 'probe', 'trigger-error', 'error', sqlerrm)::text;
  end;
end;
$probe$;

create function pg_temp.eval_replay(files jsonb)
returns setof text
language plpgsql
as $probe$
declare
  drops text[];
  stmt text;
  file jsonb;
  current_file text := '(prelude)';
begin
  select coalesce(array_agg(d), '{}') into drops from (
    select format('drop schema if exists %I cascade', n.nspname) as d
      from pg_namespace n
     where n.nspowner = current_user::regrole and n.nspname <> 'public' and n.nspname not like 'pg\_%'
       and n.nspname <> all(array['extensions', 'supabase_migrations', 'supabase_functions', 'graphql', 'graphql_public', 'auth', 'storage', 'realtime', 'vault', 'pgbouncer', '_realtime', '_analytics', '_supavisor', 'net', 'cron', 'pgmq', 'pgsodium', 'pgsodium_masks', 'pgtle', 'repack', 'topology', 'tiger', 'information_schema'])
       and not exists (select 1 from pg_depend e where e.objid = n.oid and e.deptype = 'e')
    union all
    select format('drop table if exists %I.%I cascade', n.nspname, c.relname)
      from pg_class c join pg_namespace n on c.relnamespace = n.oid
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and not exists (select 1 from pg_depend e where e.objid = c.oid and e.deptype = 'e')
    union all
    select format('drop %s if exists %I.%I cascade',
                  case c.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'S' then 'sequence' else 'foreign table' end,
                  n.nspname, c.relname)
      from pg_class c join pg_namespace n on c.relnamespace = n.oid
     where n.nspname = 'public' and c.relkind in ('v', 'm', 'S', 'f')
       and not exists (select 1 from pg_depend e where e.objid = c.oid and e.deptype = 'e')
    union all
    select format('drop routine if exists %s cascade', p.oid::regprocedure)
      from pg_proc p join pg_namespace n on p.pronamespace = n.oid
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend e where e.objid = p.oid and e.deptype = 'e')
    union all
    select format('drop type if exists %I.%I cascade', n.nspname, t.typname)
      from pg_type t join pg_namespace n on t.typnamespace = n.oid
     where n.nspname = 'public' and t.typtype in ('e', 'c', 'd', 'r') and (t.typrelid = 0 or t.typtype <> 'c')
       and not exists (select 1 from pg_depend e where e.objid = t.oid and e.deptype = 'e')
  ) s;
  foreach stmt in array drops loop
    execute stmt;
  end loop;
  for file in select * from jsonb_array_elements(files) loop
    current_file := file ->> 'name';
    execute file ->> 'sql';
  end loop;
  return next json_build_object('phase', 'replay', 'probe', 'replay-done', 'files', jsonb_array_length(files))::text;
exception when others then
  return next json_build_object('phase', 'replay', 'probe', 'replay-error', 'file', current_file, 'sqlstate', sqlstate, 'error', sqlerrm)::text;
end;
$probe$;

create function pg_temp.eval_history()
returns setof text
language plpgsql
as $probe$
begin
  return next json_build_object('phase', 'live', 'probe', 'history', 'versions',
    (select coalesce(json_agg(m.version order by m.version), '[]') from supabase_migrations.schema_migrations m))::text;
exception when others then
  return next json_build_object('phase', 'live', 'probe', 'history-error', 'error', sqlerrm)::text;
end;
$probe$;
