create extension if not exists pgcrypto;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  join_code text not null unique default encode(gen_random_bytes(6), 'hex'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.tasks (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 80),
  data jsonb not null,
  updated_by uuid not null references auth.users(id),
  client_id text,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id)
);

create index tasks_updated_at_idx on public.tasks (workspace_id, updated_at desc);

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace and user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_editor(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace
      and user_id = auth.uid()
      and role in ('owner', 'editor')
  );
$$;

create or replace function public.create_workspace(workspace_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace public.workspaces%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if char_length(trim(workspace_name)) not between 1 and 60 then
    raise exception 'Workspace name must contain 1 to 60 characters';
  end if;

  insert into public.workspaces (name, created_by)
  values (trim(workspace_name), auth.uid())
  returning * into new_workspace;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace.id, auth.uid(), 'owner');

  return jsonb_build_object(
    'id', new_workspace.id,
    'name', new_workspace.name,
    'join_code', new_workspace.join_code,
    'role', 'owner'
  );
end;
$$;

create or replace function public.join_workspace(invite_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.workspaces%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into target
  from public.workspaces
  where join_code = lower(trim(invite_code));

  if target.id is null then
    raise exception 'Invalid invite code';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (target.id, auth.uid(), 'editor')
  on conflict (workspace_id, user_id) do nothing;

  return jsonb_build_object(
    'id', target.id,
    'name', target.name,
    'join_code', target.join_code,
    'role', coalesce((select role from public.workspace_members where workspace_id = target.id and user_id = auth.uid()), 'editor')
  );
end;
$$;

grant select on public.workspaces, public.workspace_members, public.tasks to authenticated;
grant update on public.workspaces to authenticated;
grant insert, update, delete on public.tasks to authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.tasks enable row level security;

create policy "Members can view workspaces"
on public.workspaces for select to authenticated
using (public.is_workspace_member(id));

create policy "Owners can update workspaces"
on public.workspaces for update to authenticated
using (public.is_workspace_editor(id))
with check (public.is_workspace_editor(id));

create policy "Members can view membership"
on public.workspace_members for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "Members can view tasks"
on public.tasks for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "Editors can insert tasks"
on public.tasks for insert to authenticated
with check (public.is_workspace_editor(workspace_id) and updated_by = auth.uid());

create policy "Editors can update tasks"
on public.tasks for update to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id) and updated_by = auth.uid());

create policy "Editors can delete tasks"
on public.tasks for delete to authenticated
using (public.is_workspace_editor(workspace_id));

revoke all on function public.create_workspace(text) from public;
revoke all on function public.join_workspace(text) from public;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.join_workspace(text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
end;
$$;
