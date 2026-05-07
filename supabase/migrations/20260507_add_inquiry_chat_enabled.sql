alter table public.profiles
add column if not exists inquiry_chat_enabled boolean not null default true;
