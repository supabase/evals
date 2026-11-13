import { ProjectInstance } from './project/ProjectInstance.js';

// Verbatim from the hosted feedback project's migration:
// https://github.com/supabase/supabase/blob/1b01a9c8aff0124071240fb76b8b7dac889c274a/supabase/migrations/20260728035858_create_interfaces_feedback.sql
const INTERFACES_FEEDBACK_SQL = `
create table interfaces_feedback (
	id bigint primary key generated always as identity,
	created_at timestamptz not null default now(),
	feedback text not null check (char_length(feedback) <= 1000),
	delete_token uuid unique not null default gen_random_uuid(),
	user_agent text check (char_length(user_agent) <= 255),
	user_id text check (char_length(user_id) <= 255),
	project_ref text check (char_length(project_ref) <= 255),
	metadata jsonb check (pg_column_size(metadata) <= 8192)
);

alter table interfaces_feedback enable row level security;

create policy "Token holders can read their own feedback"
on interfaces_feedback
as permissive for select
to anon
using (
	delete_token = (current_setting('request.headers', true)::json ->> 'x-feedback-token')::uuid
	and (project_ref is null or project_ref = current_setting('request.headers', true)::json ->> 'x-feedback-project-ref')
	and (user_id is null or user_id = current_setting('request.headers', true)::json ->> 'x-feedback-user-id')
);

create policy "Token holders can delete their own feedback"
on interfaces_feedback
as permissive for delete
to anon
using (
	delete_token = (current_setting('request.headers', true)::json ->> 'x-feedback-token')::uuid
	and (project_ref is null or project_ref = current_setting('request.headers', true)::json ->> 'x-feedback-project-ref')
	and (user_id is null or user_id = current_setting('request.headers', true)::json ->> 'x-feedback-user-id')
);

create function public.submit_interfaces_feedback(
	feedback text,
	user_agent text default null,
	user_id text default null,
	project_ref text default null,
	metadata jsonb default null
)
returns uuid
security definer
set search_path = ''
language plpgsql
as $$
#variable_conflict use_variable
declare
	token uuid;
begin
	insert into public.interfaces_feedback (feedback, user_agent, user_id, project_ref, metadata)
	values (feedback, user_agent, user_id, project_ref, metadata)
	returning delete_token into token;
	return token;
end;
$$;

revoke execute on function public.submit_interfaces_feedback(text, text, text, text, jsonb) from public;
grant execute on function public.submit_interfaces_feedback(text, text, text, text, jsonb) to anon;

grant select (feedback, delete_token) on table interfaces_feedback to anon;
grant delete on table interfaces_feedback to anon;
`;

export interface FeedbackProject {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/**
 * A lite project with the hosted feedback schema, serving the Data API calls
 * behind the MCP `submit_feedback` and `delete_feedback` tools. Booted on first
 * request, since most evals never send feedback.
 */
export function createFeedbackProject(): FeedbackProject {
  let project: Promise<ProjectInstance> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;

  const boot = async () => {
    const instance = new ProjectInstance('feedback', 'feedback', 'supabase');
    await instance.init(INTERFACES_FEEDBACK_SQL);
    return instance;
  };

  return {
    fetch(request) {
      if (closing) {
        return Promise.resolve(
          new Response('Feedback project closed', { status: 503 })
        );
      }
      const response = queue.then(async () => {
        project ??= boot();
        const instance = await project;
        // lite sets request.headers only for RPC calls, but the delete policy reads
        // it on a table request. Requests are serialized so the setting can't leak.
        await instance.pglite.query(
          `select set_config('request.headers', $1, false)`,
          [JSON.stringify(Object.fromEntries(request.headers))]
        );
        return instance.app.fetch(request);
      });
      queue = response.catch(() => undefined);
      return response;
    },
    close() {
      closing ??= queue.then(async () => {
        const instance = await project?.catch(() => undefined);
        await instance?.close();
      });
      return closing;
    },
  };
}
