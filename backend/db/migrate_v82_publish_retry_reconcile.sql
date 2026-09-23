-- v82: 排期发布的自动重试与结果对账（0921 PRD MVP/P0 切片）。
-- Additive / 幂等。不修改 v76/v78/v81 的任何受 hash 守卫对象。
begin;

---------------------------------------------------------------------------
-- A. 前置断言：v82 依赖 v76/v78/v81 世系已安装（PRD Risk 3 capability check）
---------------------------------------------------------------------------
do $v82_preflight$
begin
  if to_regclass('public.publish_intent_destinations') is null
     or to_regclass('public.provider_publish_attempts') is null then
    raise exception using errcode='P0001', message='v82_requires_v76';
  end if;
  if to_regprocedure(
       'public.publish_intent_confirm_prepare_v78(uuid,jsonb,text)') is null then
    raise exception using errcode='P0001', message='v82_requires_v78';
  end if;
  -- v81 是可选依赖（缺失时应用层已有 v78 回退：v76PinterestVideoPublish.ts:298-307）。
  -- 但对账要读它的证据，缺失则记录降级而非拒绝安装。
end $v82_preflight$;

---------------------------------------------------------------------------
-- B. 调度平面：pin_drafts 的重试调度提示列
--    这三列是"提示"，不是权威（pin_drafts 对 owner 可写）。
--    篡改的最坏后果 = 提前一轮重试，仍受 D 节的 attempt 上限硬约束。
---------------------------------------------------------------------------
alter table public.pin_drafts
  add column if not exists publish_next_attempt_at timestamptz;
comment on column public.pin_drafts.publish_next_attempt_at
  is 'vibepin:v82:publish-next-attempt-at';

-- 老数据回填语义：保持 NULL。NULL = "无退避约束，到点即可发"，
-- 与 v82 之前的行为完全一致（见 §2.3）。不做任何 UPDATE 回填。

create index if not exists pin_drafts_publish_retry_due_idx
  on public.pin_drafts (publish_next_attempt_at, scheduled_at)
  where scheduled_at is not null
    and deleted_at is null
    and archived_at is null;

---------------------------------------------------------------------------
-- C. 调度平面：attempt 权威账本（图片 + 视频统一；客户端不可写）
--    键 = 真实调度实体，不是影子任务。
---------------------------------------------------------------------------
create table if not exists public.scheduled_publish_attempts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  draft_id text not null,
  -- 原始排期。PRD Risk 7：scheduled_at / next_attempt_at / published_at
  -- 三个语义分列存放，绝不共用一个字段。
  scheduled_at timestamptz not null,
  provider text not null,
  social_connection_id text,
  attempt integer not null,
  max_attempts integer not null default 5,
  -- PRD §4 Retry Classification 三分类 + 两个终态标记
  retry_class text not null,
  last_stage text,
  last_provider_status integer,
  last_provider_code text,
  last_request_id text,
  last_media_id text,
  -- 退避与对账调度
  next_attempt_at timestamptz,
  reconcile_required_at timestamptz,
  reconciled_at timestamptz,
  -- 终态与通知去重（PRD Risk 8）
  final_failure_at timestamptz,
  terminal_notified_at timestamptz,
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint scheduled_publish_attempts_provider_valid
    check (provider in ('pinterest','instagram','facebook')),
  -- ★ PRD §4「Check constraint：attempt_no BETWEEN 0 AND 5」+
  --   PRD §4 Test「数据库拒绝创建第 6 次 attempt」。
  --   这是图片路径唯一的 attempt 硬上限——它今天完全没有 attempt 账本。
  constraint scheduled_publish_attempts_attempt_cap
    check (attempt >= 1 and attempt <= max_attempts),
  constraint scheduled_publish_attempts_max_is_five
    check (max_attempts = 5),
  constraint scheduled_publish_attempts_class_valid
    check (retry_class in ('retryable','reconciliation_required','blocked_user','succeeded'))
);
comment on table public.scheduled_publish_attempts
  is 'vibepin:v82:scheduled-publish-attempts';

-- ★ PRD §4「唯一约束：(publish_intent_id, destination_key, attempt_no)」的等价物。
--   同一 (用户, 草稿, 排期时刻, 目标账号) 的第 N 次尝试只能存在一行。
--   必须用 unique INDEX 而非表级 unique 约束：表级 UNIQUE 不接受表达式
--   （coalesce(...)）。v76 自己就是这么做的（migrate_v76:176-179）。
create unique index if not exists scheduled_publish_attempts_identity_unique
  on public.scheduled_publish_attempts
     (owner_user_id, draft_id, scheduled_at, provider,
      (coalesce(social_connection_id, '')), attempt);

-- ★ PRD §4「Claim 索引：(publish_state, next_attempt_at)」
create index if not exists scheduled_publish_attempts_retry_due_idx
  on public.scheduled_publish_attempts (next_attempt_at)
  where next_attempt_at is not null and final_failure_at is null;
-- ★ PRD §4「Reconciliation 索引：(publish_state, reconcile_required_at)」
create index if not exists scheduled_publish_attempts_reconcile_idx
  on public.scheduled_publish_attempts (reconcile_required_at)
  where reconcile_required_at is not null and reconciled_at is null;
-- 通知去重查询：终态未通知
create index if not exists scheduled_publish_attempts_notify_idx
  on public.scheduled_publish_attempts (final_failure_at)
  where final_failure_at is not null and terminal_notified_at is null;
-- 当前 destination 的最新 attempt（worker 每轮都要读）
create index if not exists scheduled_publish_attempts_lookup_idx
  on public.scheduled_publish_attempts
     (owner_user_id, draft_id, scheduled_at, provider, attempt desc);

alter table public.scheduled_publish_attempts enable row level security;
alter table public.scheduled_publish_attempts force row level security;
revoke all on public.scheduled_publish_attempts
  from public, anon, authenticated, service_role;
-- 写入只能经 D 节的 SECURITY DEFINER RPC；service_role 只读。
grant select on public.scheduled_publish_attempts to service_role;

---------------------------------------------------------------------------
-- D. attempt 记账 RPC（唯一写入口）
---------------------------------------------------------------------------
create or replace function public.scheduled_publish_attempt_record_v82(
  p_user_id uuid,
  p_draft_id text,
  p_scheduled_at timestamptz,
  p_provider text,
  p_connection_id text,
  p_attempt integer,
  p_retry_class text,
  p_next_attempt_at timestamptz default null,
  p_reconcile_required_at timestamptz default null,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp
as $v82_record$
-- vibepin:v82:scheduled-publish-attempt-record
declare
  v_row public.scheduled_publish_attempts%rowtype;
  v_final timestamptz := null;
begin
  if p_user_id is null
     or nullif(btrim(p_draft_id),'') is null
     or p_scheduled_at is null
     or p_provider not in ('pinterest','instagram','facebook')
     or p_retry_class not in ('retryable','reconciliation_required','blocked_user','succeeded')
     or p_attempt is null then
    raise exception using errcode='22023', message='v82_attempt_input_invalid';
  end if;
  -- ★ 第 6 次尝试在这里被拒绝（CHECK 约束也会拒，这层只是给出稳定错误码）。
  if p_attempt < 1 or p_attempt > 5 then
    raise exception using errcode='23514', message='v82_attempt_cap_exceeded';
  end if;
  -- blocked_user 不消耗 provider 尝试次数（PRD Story 5 AC-2）：
  -- 调用方在 blocked_user 时传入与上一次相同的 p_attempt，
  -- 唯一约束会命中既有行并走 DO UPDATE，不新增序号。
  if p_retry_class in ('retryable','reconciliation_required')
     and p_attempt = 5 and p_next_attempt_at is null then
    v_final := now();
  end if;

  insert into public.scheduled_publish_attempts(
    owner_user_id, draft_id, scheduled_at, provider, social_connection_id,
    attempt, retry_class, next_attempt_at, reconcile_required_at,
    last_stage, last_provider_status, last_provider_code,
    last_request_id, last_media_id, final_failure_at, last_heartbeat_at
  ) values (
    p_user_id, btrim(p_draft_id), p_scheduled_at, p_provider,
    nullif(btrim(coalesce(p_connection_id,'')),''),
    p_attempt, p_retry_class, p_next_attempt_at, p_reconcile_required_at,
    nullif(btrim(coalesce(p_evidence->>'stage','')),''),
    nullif(p_evidence->>'providerStatus','')::integer,
    nullif(btrim(coalesce(p_evidence->>'providerCode','')),''),
    nullif(btrim(coalesce(p_evidence->>'requestId','')),''),
    nullif(btrim(coalesce(p_evidence->>'mediaId','')),''),
    v_final, now()
  )
  on conflict (owner_user_id, draft_id, scheduled_at, provider,
               coalesce(social_connection_id,''), attempt)
  do update set
    retry_class          = excluded.retry_class,
    next_attempt_at      = excluded.next_attempt_at,
    reconcile_required_at= coalesce(public.scheduled_publish_attempts.reconcile_required_at,
                                    excluded.reconcile_required_at),
    last_stage           = coalesce(excluded.last_stage, public.scheduled_publish_attempts.last_stage),
    last_provider_status = coalesce(excluded.last_provider_status, public.scheduled_publish_attempts.last_provider_status),
    last_provider_code   = coalesce(excluded.last_provider_code, public.scheduled_publish_attempts.last_provider_code),
    last_request_id      = coalesce(excluded.last_request_id, public.scheduled_publish_attempts.last_request_id),
    last_media_id        = coalesce(excluded.last_media_id, public.scheduled_publish_attempts.last_media_id),
    final_failure_at     = coalesce(public.scheduled_publish_attempts.final_failure_at, excluded.final_failure_at),
    last_heartbeat_at    = now(),
    updated_at           = now()
  returning * into v_row;

  return jsonb_build_object(
    'attempt', v_row.attempt,
    'maxAttempts', v_row.max_attempts,
    'retryClass', v_row.retry_class,
    'nextAttemptAt', v_row.next_attempt_at,
    'reconcileRequiredAt', v_row.reconcile_required_at,
    'finalFailureAt', v_row.final_failure_at,
    'terminalNotifiedAt', v_row.terminal_notified_at
  );
end $v82_record$;
comment on function public.scheduled_publish_attempt_record_v82(
  uuid,text,timestamptz,text,text,integer,text,timestamptz,timestamptz,jsonb)
  is 'vibepin:v82:scheduled-publish-attempt-record';

-- ★ PRD Risk 8：终态通知只发一次。CAS 领取通知权，领到的那一个调用方才发。
create or replace function public.scheduled_publish_claim_terminal_notice_v82(
  p_user_id uuid, p_attempt_row_id uuid
) returns boolean
language plpgsql security definer set search_path=public,pg_temp
as $v82_notify$
-- vibepin:v82:scheduled-publish-claim-terminal-notice
-- ROW_COUNT 是 bigint，不能直接 GET DIAGNOSTICS 进 boolean。
declare v_count bigint := 0;
begin
  update public.scheduled_publish_attempts
     set terminal_notified_at = now(), updated_at = now()
   where id = p_attempt_row_id
     and owner_user_id = p_user_id
     and final_failure_at is not null
     and terminal_notified_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end $v82_notify$;
comment on function public.scheduled_publish_claim_terminal_notice_v82(uuid,uuid)
  is 'vibepin:v82:scheduled-publish-claim-terminal-notice';

---------------------------------------------------------------------------
-- E. 对账平面：reconciliation 结论表
--    ★ 为什么不写回 publish_intent_destinations：
--      v76_legacy_transition_guard（migrate_v76:674-693）对任何 new.status ∈
--      {published,failed,delivery_unknown} 的 UPDATE 都要求 old.status='claimed'
--      且存在匹配的 provider attempt。终态行事实上不可再写。该触发器受 v76
--      hash 守卫，不得替换。对账结论因此落本表。
--
--    ★ 本表是 append log（每次对账写一行，checked_at 为时间轴）。
--      下方的唯一索引含 checked_at，因此它只防同一时刻的重复写入，
--      **不提供真正的幂等**：同一 attempt 在不同时刻对账会产生多行。
--      读取方必须按 checked_at desc 取最新一行（见 lookup 索引）。
---------------------------------------------------------------------------
create table if not exists public.publish_reconcile_checks (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  draft_id text not null,
  scheduled_at timestamptz not null,
  provider text not null,
  social_connection_id text,
  attempt integer not null,
  -- 可空：图片路径没有 intent ledger 行
  publish_intent_id uuid references public.publish_intents(id) on delete restrict,
  destination_id text,
  provider_attempt_id uuid references public.provider_publish_attempts(id) on delete restrict,
  -- ★ PRD Story 4：三个出口，没有第四个
  outcome text not null
    check (outcome in ('confirmed_published','confirmed_absent','still_unknown')),
  remote_id text,
  remote_url text,
  -- 用于核对的锚点（来自 pinterest_publish_evidence / provider attempt）
  probe_media_id text,
  probe_pin_id text,
  evidence jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now(),
  constraint publish_reconcile_checks_provider_valid
    check (provider in ('pinterest','instagram','facebook')),
  -- confirmed_published 必须带远程 ID，否则就不是"确认已创建"
  constraint publish_reconcile_checks_published_has_remote
    check (outcome <> 'confirmed_published' or nullif(btrim(coalesce(remote_id,'')),'') is not null)
);
comment on table public.publish_reconcile_checks
  is 'vibepin:v82:publish-reconcile-checks';

-- append log 的同刻去重。含 checked_at，故不是幂等键（见表注释）。
-- 同样必须是 unique INDEX（含表达式）。
create unique index if not exists publish_reconcile_checks_identity_unique
  on public.publish_reconcile_checks
     (owner_user_id, draft_id, scheduled_at, provider,
      (coalesce(social_connection_id,'')), attempt, checked_at);

create index if not exists publish_reconcile_checks_lookup_idx
  on public.publish_reconcile_checks
     (owner_user_id, draft_id, scheduled_at, provider, attempt, checked_at desc);
-- 长期 unknown 报警查询（PRD Observability：delivery_unknown 最老年龄）
create index if not exists publish_reconcile_checks_unknown_age_idx
  on public.publish_reconcile_checks (checked_at)
  where outcome = 'still_unknown';

alter table public.publish_reconcile_checks enable row level security;
alter table public.publish_reconcile_checks force row level security;
revoke all on public.publish_reconcile_checks
  from public, anon, authenticated, service_role;
grant select on public.publish_reconcile_checks to service_role;

create or replace function public.publish_reconcile_record_v82(
  p_user_id uuid, p_draft_id text, p_scheduled_at timestamptz,
  p_provider text, p_connection_id text, p_attempt integer,
  p_outcome text, p_remote_id text default null, p_remote_url text default null,
  p_intent_row_id uuid default null, p_destination_id text default null,
  p_provider_attempt_id uuid default null, p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp
as $v82_reconcile$
-- vibepin:v82:publish-reconcile-record
declare v_row public.publish_reconcile_checks%rowtype;
begin
  if p_outcome not in ('confirmed_published','confirmed_absent','still_unknown') then
    raise exception using errcode='22023', message='v82_reconcile_outcome_invalid';
  end if;
  insert into public.publish_reconcile_checks(
    owner_user_id, draft_id, scheduled_at, provider, social_connection_id,
    attempt, publish_intent_id, destination_id, provider_attempt_id,
    outcome, remote_id, remote_url,
    probe_media_id, probe_pin_id, evidence
  ) values (
    p_user_id, btrim(p_draft_id), p_scheduled_at, p_provider,
    nullif(btrim(coalesce(p_connection_id,'')),''),
    p_attempt, p_intent_row_id, nullif(btrim(coalesce(p_destination_id,'')),''),
    p_provider_attempt_id, p_outcome,
    nullif(btrim(coalesce(p_remote_id,'')),''),
    nullif(btrim(coalesce(p_remote_url,'')),''),
    nullif(btrim(coalesce(p_evidence->>'mediaId','')),''),
    nullif(btrim(coalesce(p_evidence->>'pinId','')),''),
    coalesce(p_evidence,'{}'::jsonb)
  ) returning * into v_row;

  -- 对账完成后解除 attempt 行的 reconcile 挂起
  update public.scheduled_publish_attempts
     set reconciled_at = now(), updated_at = now()
   where owner_user_id = p_user_id and draft_id = btrim(p_draft_id)
     and scheduled_at = p_scheduled_at and provider = p_provider
     and coalesce(social_connection_id,'') = coalesce(nullif(btrim(coalesce(p_connection_id,'')),''),'')
     and attempt = p_attempt
     and p_outcome <> 'still_unknown';

  return jsonb_build_object('id', v_row.id, 'outcome', v_row.outcome);
end $v82_reconcile$;
comment on function public.publish_reconcile_record_v82(
  uuid,text,timestamptz,text,text,integer,text,text,text,uuid,text,uuid,jsonb)
  is 'vibepin:v82:publish-reconcile-record';

---------------------------------------------------------------------------
-- F. 视频路径：ledger 层 attempt 上限（新约束名，不碰 v76 守卫的那个）
--    v73/v78 的 child-intent 重试会写 attempt = parent.attempt + 1
--    （migrate_v78:227-230），第 6 个孩子在这里被拒。
---------------------------------------------------------------------------
do $v82_attempt_cap$
declare v_violating bigint;
begin
  -- 先查存量。v73 血缘链可能已经产生 attempt > 5 的行；
  -- 无条件加 CHECK 会让迁移直接失败（apply 卡死），所以必须先证明。
  select count(*) into v_violating
    from public.publish_intent_destinations where attempt > 5;
  if v_violating > 0 then
    raise exception using errcode='P0001',
      message='v82_legacy_attempt_over_cap: '||v_violating||' rows have attempt > 5';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'publish_intent_destinations_v82_attempt_cap'
       and conrelid = 'public.publish_intent_destinations'::regclass) then
    alter table public.publish_intent_destinations
      add constraint publish_intent_destinations_v82_attempt_cap
      check (attempt >= 1 and attempt <= 5);
  end if;

  select count(*) into v_violating
    from public.provider_publish_attempts where attempt > 5;
  if v_violating > 0 then
    raise exception using errcode='P0001',
      message='v82_legacy_provider_attempt_over_cap: '||v_violating||' rows';
  end if;
  -- 注意：provider_publish_attempts_attempt_check CHECK ((attempt > 0)) 受
  -- v76 逐字节守卫（migrate_v76:78），绝不修改它，只叠加一个新名字的约束。
  if not exists (
    select 1 from pg_constraint
     where conname = 'provider_publish_attempts_v82_attempt_cap'
       and conrelid = 'public.provider_publish_attempts'::regclass) then
    alter table public.provider_publish_attempts
      add constraint provider_publish_attempts_v82_attempt_cap
      check (attempt <= 5);
  end if;
end $v82_attempt_cap$;

---------------------------------------------------------------------------
-- G. 视频 delivery_unknown 确认未创建后的重试入口（叠加，不改 v78）
--    v78 的 child 路径要求父 destination 为 failed + retry_allowed
--    （migrate_v78:189）；delivery_unknown 的父行不满足，会 retry_not_allowed。
--    本 RPC 仅在存在 confirmed_absent 对账行时，才允许以 delivery_unknown
--    为父开 child intent；其余情况原样委托 v78（保持行为一致）。
---------------------------------------------------------------------------
create or replace function public.publish_intent_confirm_prepare_v82(
  p_user_id uuid, p_receipt jsonb, p_source_identity_fingerprint text,
  p_reconcile_check_id uuid default null
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp
as $v82_prepare$
-- vibepin:v82:publish-intent-confirm-prepare
declare
  v_check public.publish_reconcile_checks%rowtype;
  v_prior text := nullif(btrim(coalesce(p_receipt->>'priorIntentId','')),'');
  v_parent public.publish_intents%rowtype;
begin
  if p_reconcile_check_id is null then
    -- 没有对账凭据 → 完全走 v78 原语义，零行为变化。
    return public.publish_intent_confirm_prepare_v78(
      p_user_id, p_receipt, p_source_identity_fingerprint);
  end if;

  select * into v_check from public.publish_reconcile_checks
   where id = p_reconcile_check_id and owner_user_id = p_user_id;
  -- ★ 禁止盲目重发的保障点：只有"已确认未创建"才放行。
  if not found or v_check.outcome <> 'confirmed_absent' then
    raise exception using errcode='P0001', message='reconcile_absent_proof_required';
  end if;
  if v_prior is null then
    raise exception using errcode='P0001', message='retry_not_allowed';
  end if;

  select * into v_parent from public.publish_intents
   where user_id = p_user_id and intent_id = v_prior for update;
  if not found or v_parent.id is distinct from v_check.publish_intent_id then
    raise exception using errcode='P0001', message='retry_not_allowed';
  end if;
  -- 父 destination 必须确实停在 delivery_unknown，且对账指向同一 destination。
  if not exists (
    select 1 from public.publish_intent_destinations d
     where d.publish_intent_id = v_parent.id
       and d.destination_id = v_check.destination_id
       and d.status = 'delivery_unknown') then
    raise exception using errcode='P0001', message='retry_not_allowed';
  end if;
  -- 一条 confirmed_absent 只能兑换一次重试。
  if exists (
    select 1 from public.publish_intents child
     where child.prior_intent_id = v_parent.id
       and child.user_id = p_user_id
       and child.intent_id <> v_prior) then
    raise exception using errcode='P0001', message='retry_not_allowed';
  end if;

  -- 交给 v76 建完整 materialization 图，再由本函数绑定血缘。
  -- 实现细节（父行状态过渡、attempt 继承）在实施阶段补完，
  -- 结构对齐 migrate_v78:196-231。
  raise exception using errcode='P0001', message='v82_unknown_retry_not_implemented';
end $v82_prepare$;
comment on function public.publish_intent_confirm_prepare_v82(uuid,jsonb,text,uuid)
  is 'vibepin:v82:publish-intent-confirm-prepare';

---------------------------------------------------------------------------
-- H. 授权
---------------------------------------------------------------------------
revoke all on function public.scheduled_publish_attempt_record_v82(
  uuid,text,timestamptz,text,text,integer,text,timestamptz,timestamptz,jsonb)
  from public, anon, authenticated;
grant execute on function public.scheduled_publish_attempt_record_v82(
  uuid,text,timestamptz,text,text,integer,text,timestamptz,timestamptz,jsonb)
  to service_role;
revoke all on function public.scheduled_publish_claim_terminal_notice_v82(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.scheduled_publish_claim_terminal_notice_v82(uuid,uuid)
  to service_role;
revoke all on function public.publish_reconcile_record_v82(
  uuid,text,timestamptz,text,text,integer,text,text,text,uuid,text,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_reconcile_record_v82(
  uuid,text,timestamptz,text,text,integer,text,text,text,uuid,text,uuid,jsonb)
  to service_role;
revoke all on function public.publish_intent_confirm_prepare_v82(uuid,jsonb,text,uuid)
  from public, anon, authenticated;
grant execute on function public.publish_intent_confirm_prepare_v82(uuid,jsonb,text,uuid)
  to service_role;

notify pgrst, 'reload schema';
commit;
