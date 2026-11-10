-- Dvoje · اتنين — run this once in the Supabase SQL editor.
-- One table holds everything the two of you do. Nobody can read or write the table
-- directly: the only way in is the two functions below, and both need your invite code.

create table if not exists public.events (
  seq     bigint generated always as identity,
  id      uuid primary key,
  room    text  not null,
  author  text  not null check (author in ('bs', 'ar')),
  type    text  not null,
  payload jsonb not null default '{}'::jsonb,
  at      bigint not null
);
create index if not exists events_room_seq on public.events (room, seq);

alter table public.events enable row level security;  -- no policies = no direct access

create or replace function public.get_events(p_room text, p_after bigint default 0)
returns setof public.events
language sql security definer set search_path = public as $$
  select * from public.events
  where room = p_room and seq > p_after and length(p_room) >= 12
  order by seq
  limit 200;
$$;

create or replace function public.add_event(p_room text, p_id uuid, p_author text, p_type text, p_payload jsonb, p_at bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if length(p_room) < 12 then raise exception 'bad room'; end if;
  if pg_column_size(p_payload) > 400000 then raise exception 'too large'; end if;
  insert into public.events (id, room, author, type, payload, at)
  values (p_id, p_room, p_author, p_type, p_payload, p_at)
  on conflict (id) do nothing;
end;
$$;

revoke all on function public.get_events(text, bigint) from public;
revoke all on function public.add_event(text, uuid, text, text, jsonb, bigint) from public;
grant execute on function public.get_events(text, bigint) to anon, authenticated;
grant execute on function public.add_event(text, uuid, text, text, jsonb, bigint) to anon, authenticated;
