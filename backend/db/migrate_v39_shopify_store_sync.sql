-- v39: Shopify store sync — connections + synced products (Phase 1). Additive; SQL Editor.
-- Source of truth: docs/prd/同步shopify商品功能-实施方案-phase1.md §4.2.
-- Conventions (裁决 i, template api/migrations/001_pinterest_connections.sql):
--   additive + idempotent (IF NOT EXISTS), RLS enabled with NO permissive policies
--   (service-role only, via web/src/lib/supabase.ts createServerClient), run manually
--   in the Supabase SQL Editor (raw :5432 is proxy-blocked).
create extension if not exists "uuid-ossp";

create table if not exists store_connections (
  id                       uuid primary key default uuid_generate_v4(),
  vibepin_user_id          uuid not null,
  provider                 text not null default 'shopify',      -- future-safe: woocommerce/etsy
  shop_domain              text not null,                        -- lowercase *.myshopify.com
  shop_name                text,
  primary_domain           text,                                 -- storefront host for product URLs
  access_token_encrypted   text,                                 -- AES-256-GCM "v1:" via SHOPIFY_TOKEN_ENCRYPTION_KEY; never plaintext
  scopes                   text[] not null default '{}',
  status                   text not null default 'connected'
    check (status in ('connected','degraded','reauth_required','disconnected')),
  -- sync state (决策4 / 裁决j: cursor+lock live on this row)
  sync_status              text not null default 'idle'
    check (sync_status in ('idle','running','completed','limit_reached','error')),
  sync_cursor              text,
  sync_run_id              text,
  sync_lock_expires_at     timestamptz,
  sync_started_at          timestamptz,
  sync_error               text,
  synced_count             integer not null default 0,
  total_count              integer,                              -- productsCount at limit check ("of Y")
  last_full_sync_at        timestamptz,
  last_incremental_sync_at timestamptz,                          -- reserved for 1.1 webhooks
  uninstalled_at           timestamptz,
  disconnected_at          timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create unique index if not exists store_connections_user_shop
  on store_connections (vibepin_user_id, shop_domain);
create index if not exists store_connections_active
  on store_connections (vibepin_user_id) where disconnected_at is null;

create table if not exists store_products (
  id                   uuid primary key default uuid_generate_v4(),
  vibepin_user_id      uuid not null,
  store_connection_id  uuid not null references store_connections(id) on delete cascade,
  source               text not null default 'shopify',
  external_product_id  text not null,                            -- numeric part of Shopify GID
  handle               text,
  title                text not null default '',
  description_text     text,                                     -- normalized plain text (from descriptionHtml)
  product_url          text,                                     -- onlineStoreUrl ?? https://{primary_domain||shop_domain}/products/{handle}
  status               text not null default 'active'
    check (status in ('active','draft','archived','deleted')),
  vendor               text,
  product_type         text,
  tags                 text[] not null default '{}',
  price_amount         numeric(12,2),
  compare_at_price     numeric(12,2),
  currency             text,
  availability         text not null default 'unknown'
    check (availability in ('in_stock','out_of_stock','unknown')), -- derived: status+variants.availableForSale (§4B: no read_inventory)
  primary_image_url    text,
  image_count          integer not null default 0,
  created_at_source    timestamptz,
  updated_at_source    timestamptz,
  last_synced_at       timestamptz,
  sync_error           text,
  archived_at          timestamptz,
  deleted_at           timestamptz,                              -- tombstone: picker hides by default
  raw_source           jsonb,                                    -- debug snapshot, 30-day retention
  raw_source_saved_at  timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists store_products_identity
  on store_products (vibepin_user_id, store_connection_id, external_product_id);
create index if not exists store_products_conn_updated
  on store_products (store_connection_id, updated_at_source desc);
create index if not exists store_products_user_live
  on store_products (vibepin_user_id) where deleted_at is null;

create table if not exists store_product_images (
  id                   uuid primary key default uuid_generate_v4(),
  vibepin_user_id      uuid not null,
  product_id           uuid not null references store_products(id) on delete cascade,
  external_image_id    text not null,
  source_image_url     text not null,                            -- Shopify CDN direct link (决策3: no proxy/cache)
  width                integer,
  height               integer,
  alt_text             text,
  position             integer not null default 0,
  variant_external_ids text[] not null default '{}',             -- variantAssociation
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists store_product_images_identity
  on store_product_images (product_id, external_image_id);
create index if not exists store_product_images_user
  on store_product_images (vibepin_user_id, source_image_url);   -- SSRF allowlist lookup (§3.7)

-- schema-only in Phase 1 (决策11): no UI reads beyond availability derivation
create table if not exists store_product_variants (
  id                   uuid primary key default uuid_generate_v4(),
  vibepin_user_id      uuid not null,
  product_id           uuid not null references store_products(id) on delete cascade,
  external_variant_id  text not null,
  title                text,
  price_amount         numeric(12,2),
  sku                  text,
  available_for_sale   boolean,
  external_image_id    text,
  position             integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists store_product_variants_identity
  on store_product_variants (product_id, external_variant_id);

-- updated_at triggers (reuse shared proc, pattern from api/migrations/001:41-49)
do $$
begin
  if exists (select 1 from pg_proc where proname = 'update_updated_at') then
    drop trigger if exists store_connections_updated_at on store_connections;
    create trigger store_connections_updated_at before update on store_connections
      for each row execute procedure update_updated_at();
    drop trigger if exists store_products_updated_at on store_products;
    create trigger store_products_updated_at before update on store_products
      for each row execute procedure update_updated_at();
  end if;
end$$;

alter table store_connections      enable row level security;
alter table store_products         enable row level security;
alter table store_product_images   enable row level security;
alter table store_product_variants enable row level security;
-- (No permissive policies on any of the four: service-role only.)
