-- v83: Instagram 评论关键词 → 自动私信（private reply）。Phase 1 = 仅站长自己的账号，
-- 超管后台页面管理，VPS crontab 轮询 /api/cron/instagram-comment-dm 触发。
--
-- Additive / 幂等：只新建两张表 + 索引，不改任何已有对象。
-- 两张表都开 RLS 且不建任何 policy → 只有 service role（服务端）可读写，
-- anon / authenticated 一律无权限。
--
-- 幂等保证（核心）：instagram_comment_dm_events 的 UNIQUE(connection_id, comment_id)。
-- 发送前先 insert … on conflict do nothing 抢占一行，抢不到就不发；
-- Meta 对同一条评论也只接受一次 private reply。
begin;

create table if not exists public.instagram_comment_dm_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  connection_id uuid not null
    references public.social_connections(id) on delete cascade,
  -- null = 该账号的所有帖子
  media_id text,
  keywords text[] not null
    constraint instagram_comment_dm_rules_keywords_nonempty
      check (cardinality(keywords) >= 1),
  dm_text text not null
    constraint instagram_comment_dm_rules_dm_text_nonempty
      check (length(btrim(dm_text)) > 0),
  public_reply_enabled boolean not null default false,
  public_reply_text text,
  -- 只处理这个时间点及之后的评论（UI 默认 now() - 7d）
  start_after timestamptz not null,
  -- 新规则默认关闭，Preview 过再手动开启
  enabled boolean not null default false,
  -- 该账号最近一次 cron 运行的结果（token 失效 / 缺权限等在后台页显示）
  last_run_at timestamptz,
  last_run_status text,
  last_run_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists instagram_comment_dm_rules_connection_enabled_idx
  on public.instagram_comment_dm_rules (connection_id, enabled);
create index if not exists instagram_comment_dm_rules_user_idx
  on public.instagram_comment_dm_rules (user_id);

create table if not exists public.instagram_comment_dm_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null
    references public.social_connections(id) on delete cascade,
  rule_id uuid
    references public.instagram_comment_dm_rules(id) on delete set null,
  comment_id text not null,
  media_id text,
  commenter_id text,
  commenter_username text,
  comment_text text,
  comment_timestamp timestamptz,
  status text not null default 'claimed'
    constraint instagram_comment_dm_events_status_check
      check (status in ('claimed', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  last_error text,
  public_reply_status text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instagram_comment_dm_events_connection_comment_key
    unique (connection_id, comment_id)
);

create index if not exists instagram_comment_dm_events_connection_created_idx
  on public.instagram_comment_dm_events (connection_id, created_at desc);
create index if not exists instagram_comment_dm_events_claimed_idx
  on public.instagram_comment_dm_events (status, updated_at)
  where status = 'claimed';

alter table public.instagram_comment_dm_rules enable row level security;
alter table public.instagram_comment_dm_events enable row level security;

revoke all on public.instagram_comment_dm_rules from anon, authenticated;
revoke all on public.instagram_comment_dm_events from anon, authenticated;
grant select, insert, update, delete on public.instagram_comment_dm_rules to service_role;
grant select, insert, update, delete on public.instagram_comment_dm_events to service_role;

commit;
