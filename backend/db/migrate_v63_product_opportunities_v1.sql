-- Product Opportunities v1: stable products, auditable Pinterest evidence,
-- daily observations, public metrics, and account-scoped Saved Products.
--
-- This migration is schema-only. It does not backfill, activate, retire, or
-- delete any product data. Existing pin_products rows remain untouched.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION product_opportunity_has_field_evidence(
    p_provenance jsonb,
    p_prefix text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_provenance->'merchant_field_evidence') = 'array' THEN
      EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(
            p_provenance->'merchant_field_evidence'
          ) AS field_evidence(value)
         WHERE field_evidence.value LIKE p_prefix || '%'
      )
    ELSE false
END
$$;

CREATE OR REPLACE FUNCTION product_opportunity_url_uses_public_literal_host(
    p_url text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
    v_host text;
    v_address inet;
BEGIN
    IF p_url ~ '^https?://[^/?#]*@' THEN
      RETURN false;
    END IF;
    v_host := lower(substring(p_url from '^https?://(\[[^]]+\]|[^/:?#]+)'));
    v_host := trim(both '[]' from COALESCE(v_host, ''));
    IF v_host = ''
       OR v_host = 'localhost'
       OR v_host LIKE '%.localhost'
       OR v_host LIKE '%.local'
       OR v_host LIKE '%.internal' THEN
      RETURN false;
    END IF;
    IF v_host !~ '^[0-9.]+$' AND position(':' in v_host) = 0 THEN
      RETURN true;
    END IF;
    BEGIN
      v_address := v_host::inet;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN false;
    END;
    IF family(v_address) = 4 THEN
      RETURN NOT (
        v_address <<= inet '0.0.0.0/8'
        OR v_address <<= inet '10.0.0.0/8'
        OR v_address <<= inet '100.64.0.0/10'
        OR v_address <<= inet '127.0.0.0/8'
        OR v_address <<= inet '169.254.0.0/16'
        OR v_address <<= inet '172.16.0.0/12'
        OR v_address <<= inet '192.0.0.0/24'
        OR v_address <<= inet '192.168.0.0/16'
        OR v_address <<= inet '198.18.0.0/15'
        OR v_address <<= inet '224.0.0.0/4'
        OR v_address <<= inet '240.0.0.0/4'
      );
    END IF;
    RETURN NOT (
      v_address <<= inet '::/128'
      OR v_address <<= inet '::1/128'
      OR v_address <<= inet 'fc00::/7'
      OR v_address <<= inet 'fe80::/10'
      OR v_address <<= inet 'ff00::/8'
    );
END;
$$;

CREATE TABLE IF NOT EXISTS product_opportunities (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_product_url    text NOT NULL,
    canonical_url_hash       text NOT NULL,
    external_product_url     text NOT NULL,
    product_image_url        text,
    product_image_source     text,
    product_page_verified_at timestamptz,
    product_page_verification_method text,
    product_name             text,
    merchant                 text,
    domain                   text,
    category                 text,
    product_type             text,
    product_family           text NOT NULL,
    discovery_method         text NOT NULL,
    provenance               jsonb NOT NULL,
    free_preview_rank        smallint,
    lifecycle_status         text NOT NULL DEFAULT 'discovered',
    activated_at             timestamptz,
    inactive_at              timestamptz,
    retired_at               timestamptz,
    lifecycle_reason         text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT product_opportunities_family_check
      CHECK (product_family IN ('physical', 'digital')),
    CONSTRAINT product_opportunities_category_family_check
      CHECK ((
        (category IN ('fashion', 'home-decor', 'jewelry-accessories')
          AND product_family = 'physical')
        OR (category IN ('wedding-celebrations', 'gifts')
          AND product_family IN ('physical', 'digital'))
        OR (category = 'digital-products' AND product_family = 'digital')
      ) IS TRUE),
    CONSTRAINT product_opportunities_source_category_provenance_check
      CHECK ((
        (
          provenance->>'source_category' IN (
            'fashion', 'womens-fashion', 'home-decor', 'jewelry', 'jewelry-accessories'
          )
          AND product_family = 'physical'
        )
        OR (
          provenance->>'source_category' IN (
            'wedding', 'wedding-celebrations', 'gifts'
          )
          AND product_family IN ('physical', 'digital')
        )
        OR (
          provenance->>'source_category' = 'digital-products'
          AND product_family = 'digital'
        )
      ) IS TRUE),
    CONSTRAINT product_opportunities_discovery_method_check
      CHECK (discovery_method IN
        ('outbound_link', 'shop_the_look', 'merchant_product_reference', 'reviewed_migration')),
    CONSTRAINT product_opportunities_provenance_check
      CHECK (jsonb_typeof(provenance) = 'object' AND provenance <> '{}'::jsonb),
    CONSTRAINT product_opportunities_public_url_hosts_check
      CHECK (
        product_opportunity_url_uses_public_literal_host(canonical_product_url) IS TRUE
        AND (
          product_image_url IS NULL
          OR product_opportunity_url_uses_public_literal_host(product_image_url) IS TRUE
        )
      ),
    CONSTRAINT product_opportunities_product_name_provenance_check
      CHECK (
        product_name IS NULL
        OR (
          (provenance->'product_name_found_in_page' = 'true'::jsonb) IS TRUE
          AND (provenance->>'product_name_value' = product_name) IS TRUE
          AND product_opportunity_has_field_evidence(provenance, 'name:') IS TRUE
        )
      ),
    CONSTRAINT product_opportunities_merchant_provenance_check
      CHECK (
        merchant IS NULL
        OR (
          btrim(merchant) <> ''
          AND (provenance->'merchant_found_in_page' = 'true'::jsonb) IS TRUE
          AND (provenance->>'merchant_value' = merchant) IS TRUE
          AND product_opportunity_has_field_evidence(provenance, 'merchant:') IS TRUE
        )
      ),
    CONSTRAINT product_opportunities_product_type_provenance_check
      CHECK (
        product_type IS NULL
        OR (
          btrim(product_type) <> ''
          AND (provenance->'product_type_found_in_merchant_page' = 'true'::jsonb) IS TRUE
          AND (provenance->>'product_type_value' = product_type) IS TRUE
          AND product_opportunity_has_field_evidence(provenance, 'product_type:') IS TRUE
        )
      ),
    CONSTRAINT product_opportunities_optional_display_text_check
      CHECK (
        (
          product_name IS NULL
          OR (product_name = btrim(product_name)
            AND btrim(product_name) <> ''
            AND char_length(product_name) <= 500)
        )
        AND (
          merchant IS NULL
          OR (merchant = btrim(merchant)
            AND btrim(merchant) <> ''
            AND char_length(merchant) <= 200)
        )
        AND (
          product_type IS NULL
          OR (product_type = btrim(product_type)
            AND btrim(product_type) <> ''
            AND char_length(product_type) <= 160)
        )
      ),
    CONSTRAINT product_opportunities_free_rank_check
      CHECK (free_preview_rank IS NULL OR free_preview_rank BETWEEN 1 AND 10),
    CONSTRAINT product_opportunities_lifecycle_check
      CHECK (lifecycle_status IN ('discovered', 'active', 'inactive', 'retired')),
    CONSTRAINT product_opportunities_image_source_check
      CHECK (product_image_source IS NULL OR product_image_source IN
        ('merchant_page', 'merchant_json_ld', 'merchant_open_graph', 'merchant_feed')),
    CONSTRAINT product_opportunities_page_verification_check
      CHECK (product_page_verification_method IS NULL OR product_page_verification_method IN
        ('merchant_html', 'merchant_structured_data', 'retailer_pdp_rule')),
    CONSTRAINT product_opportunities_identity_shape_check
      CHECK (
        canonical_product_url ~* '^https?://'
        AND canonical_product_url !~* '(^|[./])pinterest\.[a-z.]+'
        AND external_product_url = canonical_product_url
        AND domain IS NOT NULL
        AND btrim(domain) <> ''
        AND domain = lower(
          substring(canonical_product_url from '^https?://([^/:?#]+)')
        )
        AND canonical_url_hash ~ '^[0-9a-f]{64}$'
        AND canonical_url_hash = encode(
          digest(convert_to(canonical_product_url, 'UTF8'), 'sha256'), 'hex'
        )
      ),
    CONSTRAINT product_opportunities_active_truth_check
      CHECK (
        lifecycle_status <> 'active'
        OR (
          product_image_url IS NOT NULL
          AND btrim(product_image_url) <> ''
          AND product_image_source IS NOT NULL
          AND product_page_verified_at IS NOT NULL
          AND product_page_verification_method IS NOT NULL
          AND product_image_url ~* '^https?://'
          AND product_image_url !~* '(^|[./])pinimg\.[a-z.]+'
          AND product_image_url !~* '(^|[./])pinterest\.[a-z.]+'
          AND external_product_url ~* '^https?://'
          AND external_product_url !~* '(^|[./])pinterest\.[a-z.]+'
          AND provenance @> '{"pdp_gate_passed": true, "image_found_in_merchant_page": true}'::jsonb
          AND (provenance->>'merchant_page_url' = canonical_product_url) IS TRUE
          AND (provenance->>'product_image_url' = product_image_url) IS TRUE
        )
      )
);

-- Lifecycle is a state machine, not a mutable label. In particular, retired
-- rows are permanent historical evidence and can never be rewritten into a
-- current row, even by a privileged caller bypassing the reviewed RPCs.
CREATE OR REPLACE FUNCTION enforce_product_opportunity_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.lifecycle_status <> 'discovered' THEN
        RAISE EXCEPTION 'new Product Opportunities must enter through discovered';
      END IF;
      IF NEW.activated_at IS NOT NULL
         OR NEW.inactive_at IS NOT NULL
         OR NEW.retired_at IS NOT NULL THEN
        RAISE EXCEPTION 'discovered Product Opportunity cannot carry lifecycle timestamps';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.provenance->>'source_category'
         IS DISTINCT FROM NEW.provenance->>'source_category' THEN
      RAISE EXCEPTION 'Product Opportunity acquisition source category is immutable';
    END IF;
    IF NEW.lifecycle_status = 'active'
       AND (
         NEW.product_page_verified_at IS NULL
         OR NEW.product_page_verified_at < now() - interval '24 hours'
         OR NEW.product_page_verified_at > now() + interval '5 minutes'
       ) THEN
      RAISE EXCEPTION 'active Product Opportunity requires a fresh merchant-page verification';
    END IF;
    IF OLD.lifecycle_status IS NOT DISTINCT FROM NEW.lifecycle_status THEN
      RETURN NEW;
    END IF;
    IF NOT (
      (OLD.lifecycle_status = 'discovered' AND NEW.lifecycle_status IN ('active', 'retired'))
      OR (OLD.lifecycle_status = 'active' AND NEW.lifecycle_status IN ('inactive', 'retired'))
      OR (OLD.lifecycle_status = 'inactive' AND NEW.lifecycle_status IN ('active', 'retired'))
    ) THEN
      RAISE EXCEPTION 'invalid Product Opportunity lifecycle transition: % -> %',
        OLD.lifecycle_status, NEW.lifecycle_status;
    END IF;
    IF NEW.lifecycle_status = 'active' THEN
      NEW.activated_at := COALESCE(NEW.activated_at, OLD.activated_at, now());
      NEW.inactive_at := NULL;
      NEW.retired_at := NULL;
    ELSIF NEW.lifecycle_status = 'inactive' THEN
      NEW.inactive_at := COALESCE(NEW.inactive_at, now());
      NEW.retired_at := NULL;
    ELSIF NEW.lifecycle_status = 'retired' THEN
      NEW.retired_at := COALESCE(NEW.retired_at, now());
      NEW.inactive_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_product_opportunity_initial_lifecycle
  ON product_opportunities;
CREATE TRIGGER trg_enforce_product_opportunity_initial_lifecycle
BEFORE INSERT
ON product_opportunities
FOR EACH ROW
EXECUTE FUNCTION enforce_product_opportunity_lifecycle_transition();

DROP TRIGGER IF EXISTS trg_enforce_product_opportunity_lifecycle_transition
  ON product_opportunities;
CREATE TRIGGER trg_enforce_product_opportunity_lifecycle_transition
BEFORE UPDATE OF lifecycle_status, product_page_verified_at, provenance
ON product_opportunities
FOR EACH ROW
EXECUTE FUNCTION enforce_product_opportunity_lifecycle_transition();

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_opportunities_current_identity
    ON product_opportunities (canonical_url_hash)
    WHERE lifecycle_status <> 'retired';
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_opportunities_free_preview_rank
    ON product_opportunities (free_preview_rank)
    WHERE free_preview_rank IS NOT NULL AND lifecycle_status <> 'retired';
CREATE INDEX IF NOT EXISTS idx_product_opportunities_tracking
    ON product_opportunities (product_family, updated_at, id)
    WHERE lifecycle_status = 'active';
CREATE INDEX IF NOT EXISTS idx_product_opportunities_category
    ON product_opportunities (product_family, category)
    WHERE lifecycle_status = 'active';

CREATE TABLE IF NOT EXISTS product_free_preview_rank_history (
    id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_opportunity_id   uuid NOT NULL
      REFERENCES product_opportunities(id) ON DELETE RESTRICT,
    old_rank                 smallint,
    new_rank                 smallint,
    change_reason            text NOT NULL,
    changed_by               uuid,
    changed_at               timestamptz NOT NULL DEFAULT now(),
    CHECK (old_rank IS NULL OR old_rank BETWEEN 1 AND 10),
    CHECK (new_rank IS NULL OR new_rank BETWEEN 1 AND 10),
    CHECK (old_rank IS DISTINCT FROM new_rank)
);

CREATE OR REPLACE FUNCTION audit_product_free_preview_rank_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_reason text := current_setting('vibepin.free_rank_reason', true);
BEGIN
    IF OLD.free_preview_rank IS NOT DISTINCT FROM NEW.free_preview_rank THEN
      RETURN NEW;
    END IF;
    IF v_reason IS NULL OR btrim(v_reason) = '' THEN
      RAISE EXCEPTION 'free preview rank changes require an audited reason';
    END IF;
    INSERT INTO product_free_preview_rank_history (
      product_opportunity_id, old_rank, new_rank, change_reason, changed_by
    ) VALUES (
      NEW.id, OLD.free_preview_rank, NEW.free_preview_rank, v_reason, auth.uid()
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_product_free_preview_rank_change
  ON product_opportunities;
CREATE TRIGGER trg_audit_product_free_preview_rank_change
BEFORE UPDATE OF free_preview_rank ON product_opportunities
FOR EACH ROW EXECUTE FUNCTION audit_product_free_preview_rank_change();

CREATE OR REPLACE FUNCTION set_product_free_preview_rank(
    p_product_opportunity_id uuid,
    p_new_rank smallint,
    p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_target product_opportunities%ROWTYPE;
    v_occupant product_opportunities%ROWTYPE;
BEGIN
    IF p_new_rank IS NOT NULL AND (p_new_rank < 1 OR p_new_rank > 10) THEN
      RAISE EXCEPTION 'free preview rank must be between 1 and 10';
    END IF;
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
      RAISE EXCEPTION 'an audited business reason is required';
    END IF;
    SELECT * INTO v_target FROM product_opportunities
     WHERE id = p_product_opportunity_id FOR UPDATE;
    IF v_target.id IS NULL THEN RAISE EXCEPTION 'product opportunity not found'; END IF;
    IF p_new_rank IS NOT NULL AND v_target.lifecycle_status <> 'active' THEN
      RAISE EXCEPTION 'only active products can receive a free preview rank';
    END IF;
    IF p_new_rank IS NOT NULL THEN
      SELECT * INTO v_occupant FROM product_opportunities
       WHERE free_preview_rank = p_new_rank
         AND lifecycle_status <> 'retired'
         AND id <> p_product_opportunity_id
       FOR UPDATE;
    END IF;
    PERFORM set_config('vibepin.free_rank_reason', p_reason, true);
    IF v_occupant.id IS NOT NULL THEN
      UPDATE product_opportunities SET free_preview_rank = NULL, updated_at = now()
       WHERE id = v_occupant.id;
    END IF;
    UPDATE product_opportunities
       SET free_preview_rank = p_new_rank, updated_at = now()
     WHERE id = p_product_opportunity_id;
END;
$$;

REVOKE ALL ON FUNCTION set_product_free_preview_rank(uuid,smallint,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_product_free_preview_rank(uuid,smallint,text)
  TO service_role;

CREATE OR REPLACE FUNCTION product_opportunity_direct_provenance_matches(
    p_provenance jsonb,
    p_canonical text,
    p_source_pin boolean
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, extensions
AS $$
DECLARE
    v_direct text;
    v_resolved text;
    v_chain jsonb;
    v_hop jsonb;
    v_ordinality bigint;
    v_status integer;
    v_from text;
    v_to text;
    v_current text;
    v_canonical_json text := '[';
BEGIN
    IF jsonb_typeof(p_provenance) <> 'object'
       OR COALESCE(btrim(p_canonical), '') = '' THEN
      RETURN false;
    END IF;
    v_direct := p_provenance->>'pin_direct_outbound_url';
    IF COALESCE(btrim(v_direct), '') = ''
       OR v_direct !~* '^https?://'
       OR v_direct ~* '(^|[./])pinterest\.[a-z.]+'
       OR v_direct ~* '(^|[./])pinimg\.[a-z.]+' THEN
      RETURN false;
    END IF;

    IF v_direct = p_canonical THEN
      IF p_provenance ?| ARRAY[
           'pin_direct_outbound_resolved_url',
           'pin_direct_outbound_resolution_method',
           'pin_redirect_chain',
           'pin_redirect_chain_sha256'
         ] THEN
        RETURN false;
      END IF;
      IF p_source_pin AND (
           p_provenance->>'source_pin_direct_outbound_url' IS DISTINCT FROM p_canonical
           OR p_provenance ? 'source_pin_direct_outbound_resolved_url'
         ) THEN
        RETURN false;
      END IF;
      RETURN true;
    END IF;

    v_resolved := p_provenance->>'pin_direct_outbound_resolved_url';
    v_chain := p_provenance->'pin_redirect_chain';
    IF v_resolved IS DISTINCT FROM p_canonical
       OR p_provenance->>'pin_direct_outbound_resolution_method'
            IS DISTINCT FROM 'bounded_http_redirect_chain' THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(v_chain) IS DISTINCT FROM 'array' THEN
      RETURN false;
    END IF;
    IF jsonb_array_length(v_chain) NOT BETWEEN 1 AND 2 THEN
      RETURN false;
    END IF;
    IF p_source_pin AND (
         p_provenance->>'source_pin_direct_outbound_url' IS DISTINCT FROM v_direct
         OR p_provenance->>'source_pin_direct_outbound_resolved_url'
              IS DISTINCT FROM p_canonical
       ) THEN
      RETURN false;
    END IF;

    v_current := v_direct;
    FOR v_hop, v_ordinality IN
      SELECT value, ordinality
        FROM jsonb_array_elements(v_chain) WITH ORDINALITY
    LOOP
      IF jsonb_typeof(v_hop) <> 'object'
         OR (v_hop - 'status' - 'from' - 'to') <> '{}'::jsonb
         OR jsonb_typeof(v_hop->'status') <> 'number'
         OR jsonb_typeof(v_hop->'from') <> 'string'
         OR jsonb_typeof(v_hop->'to') <> 'string' THEN
        RETURN false;
      END IF;
      IF v_hop->>'status' NOT IN ('301', '302', '303', '307', '308') THEN
        RETURN false;
      END IF;
      v_status := (v_hop->>'status')::integer;
      v_from := v_hop->>'from';
      v_to := v_hop->>'to';
      IF v_from IS DISTINCT FROM v_current
         OR COALESCE(btrim(v_to), '') = ''
         OR v_from !~* '^https?://'
         OR v_to !~* '^https?://'
         OR v_from ~* '(^|[./])pinterest\.[a-z.]+'
         OR v_to ~* '(^|[./])pinterest\.[a-z.]+'
         OR v_from ~* '(^|[./])pinimg\.[a-z.]+'
         OR v_to ~* '(^|[./])pinimg\.[a-z.]+' THEN
        RETURN false;
      END IF;
      IF v_ordinality > 1 THEN
        v_canonical_json := v_canonical_json || ',';
      END IF;
      v_canonical_json := v_canonical_json
        || '{"from":' || to_jsonb(v_from)::text
        || ',"status":' || v_status::text
        || ',"to":' || to_jsonb(v_to)::text || '}';
      v_current := v_to;
    END LOOP;
    v_canonical_json := v_canonical_json || ']';
    RETURN (v_current = p_canonical)
      AND (
        p_provenance->>'pin_redirect_chain_sha256'
          = encode(digest(convert_to(v_canonical_json, 'UTF8'), 'sha256'), 'hex')
      ) IS TRUE;
END;
$$;

CREATE TABLE IF NOT EXISTS product_opportunity_evidence (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_opportunity_id     uuid NOT NULL
      REFERENCES product_opportunities(id) ON DELETE RESTRICT,
    pinterest_pin_id           text NOT NULL,
    pinterest_pin_url          text NOT NULL,
    evidence_type              text NOT NULL,
    relationship_method        text NOT NULL,
    external_product_url       text NOT NULL,
    canonical_url_hash         text NOT NULL,
    provenance                 jsonb NOT NULL,
    evidence_status            text NOT NULL DEFAULT 'active',
    is_primary                 boolean NOT NULL DEFAULT false,
    consecutive_not_found_days integer NOT NULL DEFAULT 0,
    last_not_found_on          date,
    last_valid_observed_at     timestamptz,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_product_opportunity_evidence_identity_product
      UNIQUE (id, product_opportunity_id),
    CONSTRAINT uq_product_opportunity_evidence_identity_pin
      UNIQUE (id, product_opportunity_id, pinterest_pin_id),
    CONSTRAINT product_opportunity_evidence_type_check
      CHECK (evidence_type IN ('product_pin', 'source_pin')),
    CONSTRAINT product_opportunity_evidence_method_check
      CHECK (relationship_method IN
        ('direct_outbound_link', 'shop_the_look', 'merchant_product_reference')),
    CONSTRAINT product_opportunity_evidence_status_check
      CHECK (evidence_status IN ('active', 'invalid', 'retired')),
    CONSTRAINT product_opportunity_evidence_provenance_check
      CHECK (
        jsonb_typeof(provenance) = 'object'
        AND provenance <> '{}'::jsonb
        AND COALESCE(btrim(provenance->>'verified_by'), '') <> ''
        AND (provenance->>'pinterest_pin_id' = pinterest_pin_id) IS TRUE
        AND product_opportunity_direct_provenance_matches(
          provenance, external_product_url, evidence_type = 'source_pin'
        ) IS TRUE
      ),
    CONSTRAINT product_opportunity_source_direct_provenance_check
      CHECK (
        evidence_type <> 'source_pin'
        OR (
          relationship_method = 'direct_outbound_link'
          AND (provenance->>'source_pin_id' = pinterest_pin_id) IS TRUE
        )
      ),
    CONSTRAINT product_opportunity_evidence_not_found_check
      CHECK (consecutive_not_found_days BETWEEN 0 AND 3),
    CONSTRAINT product_opportunity_primary_source_direct_check
      CHECK (
        is_primary = false
        OR evidence_type = 'product_pin'
        OR relationship_method = 'direct_outbound_link'
      ),
    CONSTRAINT product_opportunity_evidence_url_check
      CHECK (
        pinterest_pin_url ~* '^https?://([a-z0-9-]+\.)*pinterest\.com/pin/[0-9]{11,}/?([?#].*)?$'
        AND substring(pinterest_pin_url from '/pin/([0-9]{11,})') = pinterest_pin_id
        AND external_product_url ~* '^https?://'
        AND external_product_url !~* '(^|[./])pinterest\.[a-z.]+'
      )
);

-- Retired Evidence is immutable history. A repaired or rediscovered Pin must be
-- represented by a new evidence row (and, after Product retirement, a new
-- Product Opportunity), never by rewriting the retired proof in place.
CREATE OR REPLACE FUNCTION enforce_product_evidence_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF OLD.evidence_status = 'retired' AND NEW.evidence_status <> 'retired' THEN
      RAISE EXCEPTION 'retired Product Opportunity Evidence cannot be reactivated in place';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_product_evidence_status_transition
  ON product_opportunity_evidence;
CREATE TRIGGER trg_enforce_product_evidence_status_transition
BEFORE UPDATE OF evidence_status
ON product_opportunity_evidence
FOR EACH ROW
EXECUTE FUNCTION enforce_product_evidence_status_transition();

CREATE OR REPLACE FUNCTION enforce_product_evidence_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_product_hash text;
    v_product_url text;
BEGIN
    SELECT canonical_url_hash, external_product_url
      INTO v_product_hash, v_product_url
      FROM product_opportunities
     WHERE id = NEW.product_opportunity_id;
    IF v_product_hash IS NULL
       OR NEW.canonical_url_hash IS DISTINCT FROM v_product_hash
       OR NEW.external_product_url IS DISTINCT FROM v_product_url THEN
      RAISE EXCEPTION 'evidence canonical identity does not match its Product Opportunity';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_product_evidence_identity
  ON product_opportunity_evidence;
CREATE TRIGGER trg_enforce_product_evidence_identity
BEFORE INSERT OR UPDATE OF product_opportunity_id, canonical_url_hash, external_product_url
ON product_opportunity_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_product_evidence_identity();

-- Activation must remain fail-closed even when a privileged caller bypasses the
-- reviewed activation RPC and updates the table directly. The AFTER trigger sees
-- the evidence row created by the admission transaction and rolls the statement
-- back unless exactly one matching active Primary Evidence already exists.
CREATE OR REPLACE FUNCTION enforce_active_product_primary_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_primary_count integer;
BEGIN
    IF NEW.lifecycle_status = 'active' THEN
      SELECT count(*) INTO v_primary_count
        FROM product_opportunity_evidence e
       WHERE e.product_opportunity_id = NEW.id
         AND e.is_primary = true
         AND e.evidence_status = 'active'
         AND e.canonical_url_hash = NEW.canonical_url_hash
         AND e.external_product_url = NEW.external_product_url;
      IF v_primary_count <> 1 THEN
        RAISE EXCEPTION 'active Product Opportunity requires exactly one matching active Primary Evidence';
      END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_active_product_primary_evidence
  ON product_opportunities;
CREATE TRIGGER trg_enforce_active_product_primary_evidence
AFTER INSERT OR UPDATE OF lifecycle_status, canonical_url_hash,
  canonical_product_url, external_product_url
ON product_opportunities
FOR EACH ROW
WHEN (NEW.lifecycle_status = 'active')
EXECUTE FUNCTION enforce_active_product_primary_evidence();

-- Evidence changes are checked at transaction end. This permits the reviewed
-- switch and rollback RPCs to update old/new rows in sequence, while preventing
-- a privileged direct UPDATE/DELETE from committing an active product with zero
-- (or a mismatched) active Primary Evidence.
CREATE OR REPLACE FUNCTION enforce_active_product_evidence_at_commit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_product_id uuid;
    v_product_status text;
    v_product_hash text;
    v_product_url text;
    v_primary_count integer;
    v_product_ids uuid[];
BEGIN
    IF TG_OP = 'INSERT' THEN
      v_product_ids := ARRAY[NEW.product_opportunity_id];
    ELSIF TG_OP = 'DELETE' THEN
      v_product_ids := ARRAY[OLD.product_opportunity_id];
    ELSE
      v_product_ids := ARRAY[OLD.product_opportunity_id, NEW.product_opportunity_id];
    END IF;

    FOR v_product_id IN
      SELECT DISTINCT item
        FROM unnest(v_product_ids) AS item
       WHERE item IS NOT NULL
    LOOP
      SELECT lifecycle_status, canonical_url_hash, external_product_url
        INTO v_product_status, v_product_hash, v_product_url
        FROM product_opportunities
       WHERE id = v_product_id;
      IF v_product_status = 'active' THEN
        SELECT count(*) INTO v_primary_count
          FROM product_opportunity_evidence e
         WHERE e.product_opportunity_id = v_product_id
           AND e.is_primary = true
           AND e.evidence_status = 'active'
           AND e.canonical_url_hash = v_product_hash
           AND e.external_product_url = v_product_url;
        IF v_primary_count <> 1 THEN
          RAISE EXCEPTION 'active Product Opportunity cannot commit without exactly one matching active Primary Evidence';
        END IF;
      END IF;
    END LOOP;
    -- AFTER-trigger return values are ignored. Returning NULL also avoids
    -- relying on polymorphic RECORD coalescing for DELETE events.
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_active_product_evidence_at_commit
  ON product_opportunity_evidence;
CREATE CONSTRAINT TRIGGER trg_enforce_active_product_evidence_at_commit
AFTER INSERT OR UPDATE OR DELETE
ON product_opportunity_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_active_product_evidence_at_commit();

CREATE OR REPLACE FUNCTION activate_product_opportunity(
    p_product_opportunity_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_product product_opportunities%ROWTYPE;
    v_primary_count integer;
BEGIN
    SELECT * INTO v_product
      FROM product_opportunities
     WHERE id = p_product_opportunity_id
     FOR UPDATE;
    IF v_product.id IS NULL THEN
      RAISE EXCEPTION 'Product Opportunity not found';
    END IF;
    IF v_product.lifecycle_status = 'retired' THEN
      RAISE EXCEPTION 'retired history cannot be reactivated in place';
    END IF;
    SELECT count(*) INTO v_primary_count
      FROM product_opportunity_evidence e
     WHERE e.product_opportunity_id = p_product_opportunity_id
       AND e.is_primary = true
       AND e.evidence_status = 'active'
       AND e.canonical_url_hash = v_product.canonical_url_hash
       AND e.external_product_url = v_product.external_product_url;
    IF v_primary_count <> 1 THEN
      RAISE EXCEPTION 'activation requires exactly one matching active Primary Evidence';
    END IF;
    UPDATE product_opportunities
       SET lifecycle_status = 'active',
           activated_at = COALESCE(activated_at, now()),
           inactive_at = NULL,
           retired_at = NULL,
           lifecycle_reason = NULL,
           updated_at = now()
     WHERE id = p_product_opportunity_id;
END;
$$;

REVOKE ALL ON FUNCTION activate_product_opportunity(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION activate_product_opportunity(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION admit_product_opportunity_batch(
    p_candidates jsonb
) RETURNS TABLE(product_opportunity_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_candidate jsonb;
    v_additional jsonb;
    v_product_id uuid;
    v_pin_ids text[];
BEGIN
    IF jsonb_typeof(p_candidates) <> 'array' THEN
      RAISE EXCEPTION 'p_candidates must be a JSON array';
    END IF;
    IF jsonb_array_length(p_candidates) > 20 THEN
      RAISE EXCEPTION 'Product Opportunity admission batch exceeds 20 rows';
    END IF;
    FOR v_candidate IN SELECT value FROM jsonb_array_elements(p_candidates)
    LOOP
      IF v_candidate ? 'additional_evidence'
         AND jsonb_typeof(v_candidate->'additional_evidence') <> 'array' THEN
        RAISE EXCEPTION 'additional_evidence must be an array';
      END IF;
      IF COALESCE(jsonb_array_length(v_candidate->'additional_evidence'), 0) > 19 THEN
        RAISE EXCEPTION 'a Product Opportunity cannot admit more than 19 Additional Evidence rows';
      END IF;
      IF v_candidate->>'product_page_verified_at' IS NULL
         OR (v_candidate->>'product_page_verified_at')::timestamptz
              < now() - interval '24 hours'
         OR (v_candidate->>'product_page_verified_at')::timestamptz
              > now() + interval '5 minutes' THEN
        RAISE EXCEPTION 'Product admission requires a fresh merchant-page verification';
      END IF;
      IF v_candidate->>'evidence_type' = 'source_pin'
         AND (
           v_candidate->>'relationship_method' <> 'direct_outbound_link'
           OR v_candidate->'provenance'->>'source_pin_id'
                IS DISTINCT FROM v_candidate->>'pinterest_pin_id'
         ) THEN
        RAISE EXCEPTION 'Source Pin admission requires matching direct outbound provenance';
      END IF;
      IF v_candidate->'provenance'->>'pinterest_pin_id'
           IS DISTINCT FROM v_candidate->>'pinterest_pin_id'
         OR NOT product_opportunity_direct_provenance_matches(
           v_candidate->'provenance',
           v_candidate->>'canonical_product_url',
           v_candidate->>'evidence_type' = 'source_pin'
         ) THEN
        RAISE EXCEPTION 'Primary Evidence lacks exact Pin/direct-PDP provenance';
      END IF;
      IF v_candidate->'provenance'->>'merchant_page_url'
            IS DISTINCT FROM v_candidate->>'canonical_product_url'
         OR v_candidate->'provenance'->>'product_image_url'
            IS DISTINCT FROM v_candidate->>'product_image_url'
         OR v_candidate->'provenance'->'pdp_gate_passed' IS DISTINCT FROM 'true'::jsonb
         OR v_candidate->'provenance'->'image_found_in_merchant_page' IS DISTINCT FROM 'true'::jsonb
      THEN
        RAISE EXCEPTION 'Product admission requires matching merchant-page provenance';
      END IF;
      IF NOT (
        (
          v_candidate->'provenance'->>'source_category'
            IN ('fashion', 'womens-fashion', 'home-decor', 'jewelry', 'jewelry-accessories')
          AND v_candidate->>'product_family' = 'physical'
        )
        OR (
          v_candidate->'provenance'->>'source_category'
            IN ('wedding', 'wedding-celebrations', 'gifts')
          AND v_candidate->>'product_family' IN ('physical', 'digital')
        )
        OR (
          v_candidate->'provenance'->>'source_category' = 'digital-products'
          AND v_candidate->>'product_family' = 'digital'
        )
      ) THEN
        RAISE EXCEPTION 'Product source category provenance must match product family';
      END IF;
      IF NULLIF(btrim(v_candidate->>'product_name'), '') IS NOT NULL
         AND (
           v_candidate->'provenance'->'product_name_found_in_page'
             IS DISTINCT FROM 'true'::jsonb
           OR v_candidate->'provenance'->>'product_name_value'
             IS DISTINCT FROM NULLIF(btrim(v_candidate->>'product_name'), '')
           OR NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(
                 CASE
                   WHEN jsonb_typeof(v_candidate->'provenance'->'merchant_field_evidence') = 'array'
                     THEN v_candidate->'provenance'->'merchant_field_evidence'
                   ELSE '[]'::jsonb
                 END
               ) AS field_evidence(value)
              WHERE field_evidence.value LIKE 'name:%'
           )
         ) THEN
        RAISE EXCEPTION 'Product name lacks exact merchant-page provenance';
      END IF;
      IF NULLIF(btrim(v_candidate->>'merchant'), '') IS NOT NULL
         AND (
           v_candidate->'provenance'->'merchant_found_in_page'
             IS DISTINCT FROM 'true'::jsonb
           OR v_candidate->'provenance'->>'merchant_value'
             IS DISTINCT FROM NULLIF(btrim(v_candidate->>'merchant'), '')
           OR NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(
                 CASE
                   WHEN jsonb_typeof(v_candidate->'provenance'->'merchant_field_evidence') = 'array'
                     THEN v_candidate->'provenance'->'merchant_field_evidence'
                   ELSE '[]'::jsonb
                 END
               ) AS field_evidence(value)
              WHERE field_evidence.value LIKE 'merchant:%'
           )
         ) THEN
        RAISE EXCEPTION 'Merchant lacks exact merchant-page provenance';
      END IF;
      IF NULLIF(btrim(v_candidate->>'product_type'), '') IS NOT NULL
         AND (
           v_candidate->'provenance'->'product_type_found_in_merchant_page'
             IS DISTINCT FROM 'true'::jsonb
           OR v_candidate->'provenance'->>'product_type_value'
             IS DISTINCT FROM NULLIF(btrim(v_candidate->>'product_type'), '')
           OR NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(
                 CASE
                   WHEN jsonb_typeof(v_candidate->'provenance'->'merchant_field_evidence') = 'array'
                     THEN v_candidate->'provenance'->'merchant_field_evidence'
                   ELSE '[]'::jsonb
                 END
               ) AS field_evidence(value)
              WHERE field_evidence.value LIKE 'product_type:%'
           )
         ) THEN
        RAISE EXCEPTION 'Product type lacks exact merchant-page provenance';
      END IF;
      IF NOT (
        (v_candidate->>'category' IN ('fashion', 'home-decor', 'jewelry-accessories')
          AND v_candidate->>'product_family' = 'physical')
        OR (v_candidate->>'category' IN ('wedding-celebrations', 'gifts')
          AND v_candidate->>'product_family' IN ('physical', 'digital'))
        OR (v_candidate->>'category' = 'digital-products'
          AND v_candidate->>'product_family' = 'digital')
      ) THEN
        RAISE EXCEPTION 'Product category must be a reviewed business category matching product family';
      END IF;
      INSERT INTO product_opportunities (
        canonical_product_url, canonical_url_hash, external_product_url,
        product_image_url, product_image_source, product_page_verified_at,
        product_page_verification_method, product_name, merchant, domain,
        category, product_type, product_family, discovery_method, provenance,
        lifecycle_status
      ) VALUES (
        v_candidate->>'canonical_product_url',
        v_candidate->>'canonical_url_hash',
        v_candidate->>'external_product_url',
        v_candidate->>'product_image_url',
        v_candidate->>'product_image_source',
        (v_candidate->>'product_page_verified_at')::timestamptz,
        v_candidate->>'product_page_verification_method',
        NULLIF(btrim(v_candidate->>'product_name'), ''),
        NULLIF(btrim(v_candidate->>'merchant'), ''),
        lower(NULLIF(btrim(v_candidate->>'domain'), '')),
        NULLIF(btrim(v_candidate->>'category'), ''),
        NULLIF(btrim(v_candidate->>'product_type'), ''),
        v_candidate->>'product_family',
        v_candidate->>'discovery_method',
        v_candidate->'provenance',
        'discovered'
      ) RETURNING id INTO v_product_id;

      INSERT INTO product_opportunity_evidence (
        product_opportunity_id, pinterest_pin_id, pinterest_pin_url,
        evidence_type, relationship_method, external_product_url,
        canonical_url_hash, provenance, evidence_status, is_primary
      ) VALUES (
        v_product_id,
        v_candidate->>'pinterest_pin_id',
        v_candidate->>'pinterest_pin_url',
        v_candidate->>'evidence_type',
        v_candidate->>'relationship_method',
        v_candidate->>'external_product_url',
        v_candidate->>'canonical_url_hash',
        v_candidate->'provenance',
        'active',
        true
      );
      v_pin_ids := ARRAY[v_candidate->>'pinterest_pin_id'];
      FOR v_additional IN
        SELECT value FROM jsonb_array_elements(
          COALESCE(v_candidate->'additional_evidence', '[]'::jsonb)
        )
      LOOP
        IF v_additional->>'pinterest_pin_id' = ANY(v_pin_ids) THEN
          RAISE EXCEPTION 'duplicate Pinterest Pin within Product Opportunity Evidence';
        END IF;
        IF v_additional->>'evidence_type' NOT IN ('product_pin', 'source_pin')
           OR v_additional->>'relationship_method' NOT IN
             ('direct_outbound_link', 'shop_the_look', 'merchant_product_reference') THEN
          RAISE EXCEPTION 'Additional Evidence type or relationship is invalid';
        END IF;
        IF v_additional->'provenance'->>'pinterest_pin_id'
             IS DISTINCT FROM v_additional->>'pinterest_pin_id'
           OR NOT product_opportunity_direct_provenance_matches(
             v_additional->'provenance',
             v_candidate->>'canonical_product_url',
             v_additional->>'evidence_type' = 'source_pin'
           ) THEN
          RAISE EXCEPTION 'Additional Evidence lacks exact Pin/direct-PDP provenance';
        END IF;
        IF v_additional->>'evidence_type' = 'source_pin'
           AND (
             v_additional->>'relationship_method' <> 'direct_outbound_link'
             OR v_additional->'provenance'->>'source_pin_id'
                  IS DISTINCT FROM v_additional->>'pinterest_pin_id'
           ) THEN
          RAISE EXCEPTION 'Additional Source Pin lacks exact direct-PDP provenance';
        END IF;
        INSERT INTO product_opportunity_evidence (
          product_opportunity_id, pinterest_pin_id, pinterest_pin_url,
          evidence_type, relationship_method, external_product_url,
          canonical_url_hash, provenance, evidence_status, is_primary
        ) VALUES (
          v_product_id,
          v_additional->>'pinterest_pin_id',
          v_additional->>'pinterest_pin_url',
          v_additional->>'evidence_type',
          v_additional->>'relationship_method',
          v_candidate->>'external_product_url',
          v_candidate->>'canonical_url_hash',
          v_additional->'provenance',
          'active',
          false
        );
        v_pin_ids := array_append(v_pin_ids, v_additional->>'pinterest_pin_id');
      END LOOP;
      PERFORM activate_product_opportunity(v_product_id);
      product_opportunity_id := v_product_id;
      RETURN NEXT;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION admit_product_opportunity_batch(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION admit_product_opportunity_batch(jsonb)
  TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_opportunity_evidence_pin
    ON product_opportunity_evidence (product_opportunity_id, pinterest_pin_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_opportunity_primary_evidence
    ON product_opportunity_evidence (product_opportunity_id)
    WHERE is_primary = true AND evidence_status = 'active';
CREATE INDEX IF NOT EXISTS idx_product_opportunity_evidence_tracking
    ON product_opportunity_evidence (product_opportunity_id, is_primary, pinterest_pin_id)
    WHERE evidence_status = 'active';

CREATE TABLE IF NOT EXISTS product_evidence_snapshots (
    id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_opportunity_id   uuid NOT NULL
      REFERENCES product_opportunities(id) ON DELETE RESTRICT,
    evidence_id              uuid NOT NULL
      REFERENCES product_opportunity_evidence(id) ON DELETE RESTRICT,
    pinterest_pin_id         text NOT NULL,
    captured_on              date NOT NULL,
    captured_at              timestamptz NOT NULL DEFAULT now(),
    observation_status       text NOT NULL,
    save_count               integer,
    provider_request_id      text,
    anomaly_reason           text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT product_evidence_snapshot_product_identity_fk
      FOREIGN KEY (evidence_id, product_opportunity_id)
      REFERENCES product_opportunity_evidence(id, product_opportunity_id)
      ON DELETE RESTRICT,
    CONSTRAINT product_evidence_snapshot_pin_identity_fk
      FOREIGN KEY (evidence_id, product_opportunity_id, pinterest_pin_id)
      REFERENCES product_opportunity_evidence(id, product_opportunity_id, pinterest_pin_id)
      ON DELETE RESTRICT,
    CONSTRAINT product_evidence_snapshot_status_check
      CHECK (observation_status IN
        ('valid', 'counter_regression', 'not_found')),
    CONSTRAINT product_evidence_snapshot_value_check
      CHECK (
        (observation_status IN ('valid', 'counter_regression')
          AND save_count IS NOT NULL AND save_count >= 0)
        OR (observation_status NOT IN ('valid', 'counter_regression') AND save_count IS NULL)
      ),
    CONSTRAINT product_evidence_snapshot_capture_day_check
      CHECK (captured_on = (captured_at AT TIME ZONE 'UTC')::date),
    CONSTRAINT uq_product_evidence_snapshots_pin_day
      UNIQUE (pinterest_pin_id, captured_on)
);

-- The tracker writes through record_product_evidence_observation(_batch), but
-- table-owner maintenance and future privileged code must not be able to seed a
-- different UTC day or fabricated historical/future capture time by accident.
CREATE OR REPLACE FUNCTION enforce_product_evidence_snapshot_capture_time()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_evidence_created_at timestamptz;
BEGIN
    IF NEW.captured_on IS NULL OR NEW.captured_at IS NULL THEN
      RAISE EXCEPTION 'observation capture time is required';
    END IF;
    IF NEW.captured_on <> (NEW.captured_at AT TIME ZONE 'UTC')::date THEN
      RAISE EXCEPTION 'captured_on must match captured_at UTC date';
    END IF;
    IF NEW.captured_at < now() - interval '24 hours'
       OR NEW.captured_at > now() + interval '5 minutes' THEN
      RAISE EXCEPTION 'observation capture time is outside the accepted freshness window';
    END IF;
    SELECT created_at INTO v_evidence_created_at
      FROM product_opportunity_evidence
     WHERE id = NEW.evidence_id
       AND product_opportunity_id = NEW.product_opportunity_id
       AND pinterest_pin_id = NEW.pinterest_pin_id;
    IF v_evidence_created_at IS NULL THEN
      RAISE EXCEPTION 'snapshot Evidence identity does not exist';
    END IF;
    IF NEW.captured_at < v_evidence_created_at - interval '5 minutes' THEN
      RAISE EXCEPTION 'observation cannot predate evidence';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_product_evidence_snapshot_capture_time
  ON product_evidence_snapshots;
CREATE TRIGGER trg_enforce_product_evidence_snapshot_capture_time
BEFORE INSERT OR UPDATE OF evidence_id, product_opportunity_id,
  pinterest_pin_id, captured_on, captured_at
ON product_evidence_snapshots
FOR EACH ROW
EXECUTE FUNCTION enforce_product_evidence_snapshot_capture_time();

CREATE INDEX IF NOT EXISTS idx_product_evidence_snapshots_metric_window
    ON product_evidence_snapshots (pinterest_pin_id, captured_on DESC)
    WHERE observation_status = 'valid';

CREATE TABLE IF NOT EXISTS product_evidence_switches (
    id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_opportunity_id   uuid NOT NULL
      REFERENCES product_opportunities(id) ON DELETE RESTRICT,
    old_evidence_id          uuid NOT NULL
      REFERENCES product_opportunity_evidence(id) ON DELETE RESTRICT,
    new_evidence_id          uuid NOT NULL
      REFERENCES product_opportunity_evidence(id) ON DELETE RESTRICT,
    switch_reason            text NOT NULL,
    switched_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT product_evidence_switch_old_identity_fk
      FOREIGN KEY (old_evidence_id, product_opportunity_id)
      REFERENCES product_opportunity_evidence(id, product_opportunity_id)
      ON DELETE RESTRICT,
    CONSTRAINT product_evidence_switch_new_identity_fk
      FOREIGN KEY (new_evidence_id, product_opportunity_id)
      REFERENCES product_opportunity_evidence(id, product_opportunity_id)
      ON DELETE RESTRICT,
    CHECK (old_evidence_id <> new_evidence_id)
);

CREATE TABLE IF NOT EXISTS product_opportunity_metrics (
    product_opportunity_id uuid PRIMARY KEY
      REFERENCES product_opportunities(id) ON DELETE RESTRICT,
    evidence_id            uuid NOT NULL
      REFERENCES product_opportunity_evidence(id) ON DELETE RESTRICT,
    metric_version         integer NOT NULL DEFAULT 1,
    g30_status             text NOT NULL,
    trend_status           text NOT NULL,
    latest_save_count      integer,
    latest_snapshot_at     timestamptz,
    g30_saves_gained       integer,
    g30_anchor_at          timestamptz,
    g30_actual_days        integer,
    current_g7_gained      integer,
    current_g7_anchor_at   timestamptz,
    current_g7_actual_days integer,
    previous_g7_gained     integer,
    previous_g7_anchor_at  timestamptz,
    previous_g7_actual_days integer,
    momentum_percent       numeric,
    momentum_direction     text,
    computed_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT product_opportunity_metrics_evidence_identity_fk
      FOREIGN KEY (evidence_id, product_opportunity_id)
      REFERENCES product_opportunity_evidence(id, product_opportunity_id)
      ON DELETE RESTRICT,
    CONSTRAINT product_opportunity_metrics_g30_status_check
      CHECK (g30_status IN
        ('valid', 'insufficient_history', 'counter_regression', 'stale')),
    CONSTRAINT product_opportunity_metrics_trend_status_check
      CHECK (trend_status IN
        ('valid', 'calibration_pending', 'insufficient_history', 'insufficient_activity',
         'counter_regression', 'stale')),
    CONSTRAINT product_opportunity_metrics_latest_value_check
      CHECK (latest_save_count IS NULL OR latest_save_count >= 0),
    CONSTRAINT product_opportunity_metrics_valid_g30_shape_check
      CHECK (
        g30_status <> 'valid'
        OR (
          latest_save_count IS NOT NULL
          AND latest_snapshot_at IS NOT NULL
          AND g30_saves_gained IS NOT NULL
          AND g30_saves_gained >= 0
          AND g30_anchor_at IS NOT NULL
          AND g30_actual_days IS NOT NULL
          AND g30_actual_days > 0
        )
      ),
    CONSTRAINT product_opportunity_metrics_valid_trend_shape_check
      CHECK (
        trend_status <> 'valid'
        OR (
          latest_save_count IS NOT NULL
          AND latest_snapshot_at IS NOT NULL
          AND current_g7_gained IS NOT NULL
          AND current_g7_gained >= 0
          AND current_g7_anchor_at IS NOT NULL
          AND current_g7_actual_days IS NOT NULL
          AND current_g7_actual_days > 0
          AND previous_g7_gained IS NOT NULL
          AND previous_g7_gained >= 0
          AND previous_g7_anchor_at IS NOT NULL
          AND previous_g7_actual_days IS NOT NULL
          AND previous_g7_actual_days > 0
          AND momentum_percent IS NOT NULL
          AND momentum_direction IS NOT NULL
        )
      ),
    CONSTRAINT product_opportunity_momentum_check
      CHECK (momentum_direction IS NULL OR momentum_direction IN
        ('rising', 'steady', 'cooling'))
);

CREATE TABLE IF NOT EXISTS product_metric_calibrations (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_family                  text NOT NULL,
    metric_version                  integer NOT NULL,
    high_demand_g30_threshold       integer,
    anchor_7_tolerance_days         smallint NOT NULL DEFAULT 1,
    anchor_14_tolerance_days        smallint NOT NULL DEFAULT 1,
    anchor_30_tolerance_days        smallint NOT NULL DEFAULT 3,
    max_latest_age_days             smallint NOT NULL DEFAULT 2,
    minimum_valid_observations_14d  smallint NOT NULL DEFAULT 10,
    minimum_valid_observations_30d  smallint NOT NULL DEFAULT 20,
    maximum_history_gap_days        smallint NOT NULL DEFAULT 3,
    minimum_14d_activity            integer NOT NULL,
    minimum_absolute_delta          integer NOT NULL,
    relative_change_boundary_percent numeric NOT NULL,
    calibration_sample_size         integer NOT NULL,
    calibration_window              daterange NOT NULL,
    effective_from                  timestamptz NOT NULL,
    approved_at                     timestamptz,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    CHECK (product_family IN ('physical', 'digital')),
    CHECK (high_demand_g30_threshold IS NULL OR high_demand_g30_threshold > 0),
    CHECK (anchor_7_tolerance_days BETWEEN 0 AND 3),
    CHECK (anchor_14_tolerance_days BETWEEN 0 AND 3),
    CHECK (anchor_30_tolerance_days BETWEEN 0 AND 7),
    CHECK (max_latest_age_days BETWEEN 0 AND 7),
    CHECK (minimum_valid_observations_14d BETWEEN 2 AND 15),
    CHECK (minimum_valid_observations_30d BETWEEN 2 AND 33),
    CHECK (maximum_history_gap_days BETWEEN 1 AND 7),
    CHECK (minimum_14d_activity > 0),
    CHECK (minimum_absolute_delta > 0),
    CHECK (relative_change_boundary_percent > 0),
    CHECK (calibration_sample_size > 0),
    UNIQUE (product_family, metric_version)
);

CREATE INDEX IF NOT EXISTS idx_product_metric_calibrations_effective
    ON product_metric_calibrations (product_family, effective_from DESC);

CREATE TABLE IF NOT EXISTS product_metric_release_gates (
    product_family                  text PRIMARY KEY,
    metric_version                  integer NOT NULL,
    valid_g30_g7_coverage           numeric NOT NULL,
    counter_regression_rate         numeric NOT NULL,
    evidence_splice_rate            numeric NOT NULL,
    visible_product_count           integer NOT NULL,
    quality_review_passed           boolean NOT NULL DEFAULT false,
    demand_trend_filters_enabled    boolean NOT NULL DEFAULT false,
    approved_at                     timestamptz,
    updated_at                      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT product_metric_release_gate_calibration_fk
      FOREIGN KEY (product_family, metric_version)
      REFERENCES product_metric_calibrations(product_family, metric_version)
      ON DELETE RESTRICT,
    CHECK (product_family IN ('physical', 'digital')),
    CHECK (valid_g30_g7_coverage BETWEEN 0 AND 1),
    CHECK (counter_regression_rate BETWEEN 0 AND 1),
    CHECK (evidence_splice_rate BETWEEN 0 AND 1),
    CHECK (visible_product_count >= 0),
    CHECK (
      demand_trend_filters_enabled = false
      OR (
        valid_g30_g7_coverage >= 0.70
        AND visible_product_count > 0
        AND quality_review_passed = true
        AND approved_at IS NOT NULL
      )
    )
);

-- Exact, history-preserving rollback for one reviewed admission receipt. This
-- never deletes a Product Opportunity or its evidence/snapshots; it only takes
-- the just-admitted identities out of the active catalog and tracking set.
CREATE OR REPLACE FUNCTION rollback_product_opportunity_admission_batch(
    p_ids jsonb,
    p_reason text
) RETURNS TABLE(retired_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_ids uuid[];
    v_expected integer;
    v_found integer;
    v_retired integer;
BEGIN
    IF jsonb_typeof(p_ids) <> 'array' OR jsonb_array_length(p_ids) = 0 THEN
      RAISE EXCEPTION 'p_ids must be a non-empty JSON array';
    END IF;
    IF jsonb_array_length(p_ids) > 20 THEN
      RAISE EXCEPTION 'admission rollback exceeds 20 rows';
    END IF;
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
      RAISE EXCEPTION 'admission rollback requires a reason';
    END IF;
    SELECT array_agg(value::uuid), count(DISTINCT value), count(*)
      INTO v_ids, v_found, v_expected
      FROM jsonb_array_elements_text(p_ids);
    IF v_found <> v_expected THEN
      RAISE EXCEPTION 'admission rollback ids must be unique';
    END IF;
    PERFORM id FROM product_opportunities
     WHERE id = ANY(v_ids)
     ORDER BY id
     FOR UPDATE;
    SELECT count(*) INTO v_found
      FROM product_opportunities
     WHERE id = ANY(v_ids)
       AND lifecycle_status = 'active';
    IF v_found <> v_expected THEN
      RAISE EXCEPTION 'admission rollback receipt does not match active rows';
    END IF;

    UPDATE product_opportunity_evidence
       SET is_primary = false,
           evidence_status = 'retired',
           updated_at = now()
     WHERE product_opportunity_id = ANY(v_ids)
       AND evidence_status = 'active';
    UPDATE product_opportunities
       SET lifecycle_status = 'retired',
           retired_at = now(),
           inactive_at = NULL,
           lifecycle_reason = 'admission_rollback:' || left(btrim(p_reason), 180),
           updated_at = now()
     WHERE id = ANY(v_ids)
       AND lifecycle_status = 'active';
    GET DIAGNOSTICS v_retired = ROW_COUNT;
    IF v_retired <> v_expected THEN
      RAISE EXCEPTION 'admission rollback affected an unexpected row count';
    END IF;
    RETURN QUERY SELECT v_retired;
END;
$$;

REVOKE ALL ON FUNCTION rollback_product_opportunity_admission_batch(jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rollback_product_opportunity_admission_batch(jsonb,text)
  TO service_role;

CREATE OR REPLACE VIEW product_opportunity_catalog_v1
WITH (security_invoker = true)
AS
SELECT
    p.id,
    p.product_name,
    p.product_image_url,
    p.external_product_url,
    p.merchant,
    p.domain,
    p.category,
    p.product_type,
    p.product_family,
    p.free_preview_rank,
    p.lifecycle_status,
    p.activated_at,
    lower(concat_ws(
      ' ',
      p.product_name,
      p.merchant,
      p.domain,
      p.category,
      CASE p.category
        WHEN 'fashion' THEN 'Fashion'
        WHEN 'home-decor' THEN 'Home Decor'
        WHEN 'wedding-celebrations' THEN 'Wedding Celebrations Bridal'
        WHEN 'gifts' THEN 'Gifts'
        WHEN 'jewelry-accessories' THEN 'Jewelry Jewellery Accessories'
        WHEN 'digital-products' THEN 'Digital Products'
      END,
      p.product_type
    )) AS search_text,
    e.id AS evidence_id,
    e.pinterest_pin_url,
    e.evidence_type,
    m.evidence_id AS metric_evidence_id,
    m.metric_version,
    m.g30_status,
    m.trend_status,
    CASE WHEN m.g30_status NOT IN ('stale', 'counter_regression')
      THEN m.latest_save_count END AS latest_save_count,
    CASE WHEN m.g30_status NOT IN ('stale', 'counter_regression')
      THEN m.latest_snapshot_at END AS latest_snapshot_at,
    CASE WHEN m.g30_status = 'valid'
      THEN m.g30_saves_gained END AS g30_saves_gained,
    CASE WHEN m.trend_status NOT IN ('stale', 'counter_regression', 'insufficient_history')
      THEN m.current_g7_gained END AS current_g7_gained,
    CASE WHEN m.trend_status NOT IN ('stale', 'counter_regression', 'insufficient_history')
      THEN m.previous_g7_gained END AS previous_g7_gained,
    CASE WHEN m.trend_status = 'valid'
      THEN m.momentum_direction END AS momentum_direction,
    CASE WHEN m.trend_status = 'valid'
      THEN m.momentum_percent END AS momentum_percent,
    CASE WHEN m.g30_status = 'valid'
           AND c.high_demand_g30_threshold IS NOT NULL
      THEN m.g30_saves_gained >= c.high_demand_g30_threshold END AS high_recent_demand
FROM product_opportunities p
JOIN product_opportunity_evidence e
  ON e.product_opportunity_id = p.id
 AND e.is_primary = true
 AND e.evidence_status = 'active'
LEFT JOIN product_opportunity_metrics m
  ON m.product_opportunity_id = p.id
 AND m.evidence_id = e.id
LEFT JOIN LATERAL (
  SELECT calibration.high_demand_g30_threshold
    FROM product_metric_calibrations calibration
   WHERE calibration.product_family = p.product_family
     AND calibration.metric_version = m.metric_version
     AND calibration.approved_at IS NOT NULL
     AND calibration.effective_from <= now()
   ORDER BY calibration.effective_from DESC
   LIMIT 1
) c ON true
WHERE p.lifecycle_status = 'active';

REVOKE ALL ON product_opportunity_catalog_v1 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON product_opportunity_catalog_v1 TO service_role;

CREATE TABLE IF NOT EXISTS saved_product_opportunities (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    product_opportunity_id   uuid NOT NULL
      REFERENCES product_opportunities(id) ON DELETE RESTRICT,
    save_status              text NOT NULL DEFAULT 'saved',
    saved_at                 timestamptz NOT NULL DEFAULT now(),
    removed_at               timestamptz,
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT saved_product_opportunities_status_check
      CHECK (save_status IN ('saved', 'removed')),
    CONSTRAINT saved_product_opportunities_time_state_check
      CHECK (
        (save_status = 'saved' AND removed_at IS NULL)
        OR (save_status = 'removed' AND removed_at IS NOT NULL)
      ),
    CONSTRAINT saved_product_opportunities_time_order_check
      CHECK (
        updated_at >= saved_at
        AND (
          removed_at IS NULL
          OR (removed_at >= saved_at AND updated_at >= removed_at)
        )
      ),
    UNIQUE (user_id, product_opportunity_id)
);

CREATE OR REPLACE FUNCTION normalize_saved_product_opportunity_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_now timestamptz := now();
BEGIN
    IF TG_OP = 'INSERT' THEN
      NEW.saved_at := v_now;
      NEW.updated_at := v_now;
      IF NEW.save_status = 'saved' THEN
        NEW.removed_at := NULL;
      ELSE
        NEW.removed_at := v_now;
      END IF;
      RETURN NEW;
    END IF;

    NEW.updated_at := v_now;
    IF NEW.save_status = 'saved' THEN
      IF OLD.save_status = 'saved' THEN
        NEW.saved_at := OLD.saved_at;
      ELSE
        NEW.saved_at := v_now;
      END IF;
      NEW.removed_at := NULL;
    ELSE
      NEW.saved_at := OLD.saved_at;
      IF OLD.save_status = 'removed' THEN
        NEW.removed_at := OLD.removed_at;
      ELSE
        NEW.removed_at := v_now;
      END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_saved_product_opportunity_state
    ON saved_product_opportunities;
CREATE TRIGGER trg_normalize_saved_product_opportunity_state
BEFORE INSERT OR UPDATE OF save_status, saved_at, removed_at, updated_at
ON saved_product_opportunities
FOR EACH ROW
EXECUTE FUNCTION normalize_saved_product_opportunity_state();

CREATE INDEX IF NOT EXISTS idx_saved_product_opportunities_user
    ON saved_product_opportunities (user_id, saved_at DESC)
    WHERE save_status = 'saved';

ALTER TABLE saved_product_opportunities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own saved product opportunities"
    ON saved_product_opportunities;
CREATE POLICY "Users read own saved product opportunities"
    ON saved_product_opportunities FOR SELECT
    USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users insert own saved product opportunities"
    ON saved_product_opportunities;
CREATE POLICY "Users insert own saved product opportunities"
    ON saved_product_opportunities FOR INSERT
    WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users update own saved product opportunities"
    ON saved_product_opportunities;
CREATE POLICY "Users update own saved product opportunities"
    ON saved_product_opportunities FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Reads remain account-scoped by RLS. Writes are server-only because plan
-- access (including the fixed Free ten) is enforced by the Product API; direct
-- authenticated writes would bypass that admission check.
REVOKE ALL ON saved_product_opportunities FROM PUBLIC, anon, authenticated;
GRANT SELECT ON saved_product_opportunities TO authenticated;
GRANT SELECT, INSERT, UPDATE ON saved_product_opportunities TO service_role;

-- One canonical daily observation per Pinterest Pin. A rerun can upgrade an
-- error/not-found row to a valid measurement, but can never downgrade a valid
-- measurement to an error. Multiple Evidence rows for the same Pin consume this
-- shared raw fact instead of creating divergent same-day snapshots.
CREATE OR REPLACE FUNCTION record_product_evidence_observation(
    p_evidence_id uuid,
    p_captured_on date,
    p_captured_at timestamptz,
    p_observation_status text,
    p_save_count integer DEFAULT NULL,
    p_provider_request_id text DEFAULT NULL,
    p_anomaly_reason text DEFAULT NULL
) RETURNS TABLE(effective_status text, changed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_product_id uuid;
    v_pin_id text;
    v_last_not_found date;
    v_evidence_created_at timestamptz;
    v_previous_save_count integer;
    v_effective_status text := p_observation_status;
    v_changed_count integer := 0;
BEGIN
    SELECT product_opportunity_id, pinterest_pin_id, last_not_found_on, created_at
      INTO v_product_id, v_pin_id, v_last_not_found, v_evidence_created_at
      FROM product_opportunity_evidence
     WHERE id = p_evidence_id
     FOR UPDATE;
    IF v_product_id IS NULL THEN
      RAISE EXCEPTION 'unknown evidence id';
    END IF;
    IF p_captured_on IS NULL OR p_captured_at IS NULL THEN
      RAISE EXCEPTION 'observation capture time is required';
    END IF;
    IF p_captured_on <> (p_captured_at AT TIME ZONE 'UTC')::date THEN
      RAISE EXCEPTION 'captured_on must match captured_at UTC date';
    END IF;
    IF p_captured_at < now() - interval '24 hours'
       OR p_captured_at > now() + interval '5 minutes' THEN
      RAISE EXCEPTION 'observation capture time is outside the accepted freshness window';
    END IF;
    IF p_captured_at < v_evidence_created_at - interval '5 minutes' THEN
      RAISE EXCEPTION 'observation cannot predate evidence';
    END IF;
    IF p_observation_status NOT IN ('valid', 'not_found') THEN
      RAISE EXCEPTION 'invalid observation status';
    END IF;
    IF (p_observation_status = 'valid' AND (p_save_count IS NULL OR p_save_count < 0))
       OR (p_observation_status <> 'valid' AND p_save_count IS NOT NULL) THEN
      RAISE EXCEPTION 'save_count must be non-negative only for valid observations';
    END IF;

    IF p_observation_status = 'valid' THEN
      SELECT s.save_count INTO v_previous_save_count
        FROM product_evidence_snapshots s
       WHERE s.pinterest_pin_id = v_pin_id
         AND s.captured_on < p_captured_on
         AND s.observation_status IN ('valid', 'counter_regression')
       ORDER BY s.captured_on DESC, s.captured_at DESC
       LIMIT 1;
      IF v_previous_save_count IS NOT NULL AND p_save_count < v_previous_save_count THEN
        v_effective_status := 'counter_regression';
        p_anomaly_reason := COALESCE(p_anomaly_reason, 'counter_regression');
      END IF;
    END IF;

    INSERT INTO product_evidence_snapshots (
      product_opportunity_id, evidence_id, pinterest_pin_id, captured_on,
      captured_at, observation_status, save_count, provider_request_id, anomaly_reason
    )
    SELECT v_product_id, e.id, e.pinterest_pin_id, p_captured_on,
           p_captured_at, v_effective_status, p_save_count,
           p_provider_request_id, p_anomaly_reason
      FROM product_opportunity_evidence e
     WHERE e.id = p_evidence_id
    ON CONFLICT (pinterest_pin_id, captured_on) DO UPDATE
      SET captured_at = EXCLUDED.captured_at,
          observation_status = EXCLUDED.observation_status,
          save_count = EXCLUDED.save_count,
          provider_request_id = EXCLUDED.provider_request_id,
          anomaly_reason = EXCLUDED.anomaly_reason
    WHERE product_evidence_snapshots.observation_status <> 'valid'
      AND EXCLUDED.observation_status IN ('valid', 'counter_regression');
    GET DIAGNOSTICS v_changed_count = ROW_COUNT;

    IF v_effective_status = 'valid' THEN
      UPDATE product_opportunity_evidence
         SET consecutive_not_found_days = 0,
             last_not_found_on = NULL,
             last_valid_observed_at = p_captured_at,
             updated_at = now()
       WHERE id = p_evidence_id;
    ELSIF p_observation_status = 'not_found'
          AND (v_last_not_found IS NULL OR p_captured_on > v_last_not_found) THEN
      UPDATE product_opportunity_evidence
         SET consecutive_not_found_days = CASE
               WHEN v_last_not_found IS NOT NULL
                AND p_captured_on = v_last_not_found + 1
                 THEN LEAST(consecutive_not_found_days + 1, 3)
               ELSE 1
             END,
             last_not_found_on = p_captured_on,
             updated_at = now()
       WHERE id = p_evidence_id;
    END IF;
    RETURN QUERY SELECT v_effective_status, v_changed_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION record_product_evidence_observation(
  uuid,date,timestamptz,text,integer,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_product_evidence_observation(
  uuid,date,timestamptz,text,integer,text,text
) TO service_role;

-- Transactional, bounded batch entry point used by the daily tracker. One bad
-- observation rolls back only this <=100-row batch, never a partially written
-- thousand-row payload.
CREATE OR REPLACE FUNCTION record_product_evidence_observation_batch(
    p_observations jsonb
) RETURNS TABLE(written integer, counter_regressions integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_item jsonb;
    v_status text;
    v_changed boolean;
    v_written integer := 0;
    v_regressions integer := 0;
BEGIN
    IF jsonb_typeof(p_observations) <> 'array' THEN
      RAISE EXCEPTION 'p_observations must be a JSON array';
    END IF;
    IF jsonb_array_length(p_observations) > 100 THEN
      RAISE EXCEPTION 'observation batch exceeds 100 rows';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_observations)
    LOOP
      SELECT r.effective_status, r.changed INTO v_status, v_changed
      FROM record_product_evidence_observation(
        (v_item->>'evidence_id')::uuid,
        (v_item->>'captured_on')::date,
        (v_item->>'captured_at')::timestamptz,
        v_item->>'observation_status',
        CASE WHEN v_item->>'save_count' IS NULL THEN NULL ELSE (v_item->>'save_count')::integer END,
        v_item->>'provider_request_id',
        v_item->>'anomaly_reason'
      ) r;
      IF v_changed THEN
        v_written := v_written + 1;
      END IF;
      IF v_changed AND v_status = 'counter_regression' THEN
        v_regressions := v_regressions + 1;
      END IF;
    END LOOP;
    RETURN QUERY SELECT v_written, v_regressions;
END;
$$;

REVOKE ALL ON FUNCTION record_product_evidence_observation_batch(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_product_evidence_observation_batch(jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION switch_product_primary_evidence(
    p_product_opportunity_id uuid,
    p_new_evidence_id uuid,
    p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_old product_opportunity_evidence%ROWTYPE;
    v_new product_opportunity_evidence%ROWTYPE;
BEGIN
    SELECT * INTO v_old
      FROM product_opportunity_evidence
     WHERE product_opportunity_id = p_product_opportunity_id
       AND is_primary = true AND evidence_status = 'active'
     FOR UPDATE;
    IF v_old.id IS NULL OR v_old.consecutive_not_found_days < 3 THEN
      RAISE EXCEPTION 'primary evidence has not reached three confirmed not-found days';
    END IF;
    SELECT * INTO v_new
      FROM product_opportunity_evidence
     WHERE id = p_new_evidence_id
       AND product_opportunity_id = p_product_opportunity_id
       AND evidence_status = 'active'
     FOR UPDATE;
    IF v_new.id IS NULL OR v_new.id = v_old.id THEN
      RAISE EXCEPTION 'new evidence must be another active evidence for this product';
    END IF;
    -- The application fetches the replacement before calling this RPC, but the
    -- transaction boundary must enforce the same rule. A privileged caller may
    -- not promote an old, guessed or merely available Evidence row without a
    -- real canonical valid observation for that Pinterest Pin on this UTC day.
    IF NOT EXISTS (
      SELECT 1
        FROM product_evidence_snapshots s
       WHERE s.pinterest_pin_id = v_new.pinterest_pin_id
         AND s.captured_on = (now() AT TIME ZONE 'UTC')::date
         AND s.observation_status = 'valid'
    ) THEN
      RAISE EXCEPTION 'new Primary Evidence requires a valid observation on the current UTC day';
    END IF;

    UPDATE product_opportunity_evidence
       SET is_primary = false, evidence_status = 'invalid', updated_at = now()
     WHERE id = v_old.id;
    UPDATE product_opportunity_evidence
       SET is_primary = true, updated_at = now()
     WHERE id = v_new.id;
    DELETE FROM product_opportunity_metrics
     WHERE product_opportunity_id = p_product_opportunity_id;
    INSERT INTO product_evidence_switches (
      product_opportunity_id, old_evidence_id, new_evidence_id, switch_reason
    ) VALUES (p_product_opportunity_id, v_old.id, v_new.id, p_reason);
END;
$$;

REVOKE ALL ON FUNCTION switch_product_primary_evidence(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION switch_product_primary_evidence(uuid,uuid,text)
  TO service_role;

REVOKE ALL ON product_opportunities, product_free_preview_rank_history,
  product_opportunity_evidence, product_evidence_snapshots,
  product_evidence_switches, product_opportunity_metrics,
  product_metric_calibrations, product_metric_release_gates
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON product_opportunities, product_opportunity_evidence,
  product_evidence_snapshots, product_opportunity_metrics,
  product_metric_calibrations, product_metric_release_gates TO service_role;
GRANT INSERT, UPDATE ON product_opportunities,
  product_opportunity_evidence,
  product_opportunity_metrics, product_metric_calibrations,
  product_metric_release_gates TO service_role;
-- Migration reruns must also remove the broader grant from older candidates.
REVOKE INSERT, UPDATE, DELETE ON product_evidence_snapshots FROM service_role;
GRANT SELECT, INSERT ON product_free_preview_rank_history,
  product_evidence_switches TO service_role;
GRANT USAGE, SELECT ON SEQUENCE product_free_preview_rank_history_id_seq,
  product_evidence_snapshots_id_seq, product_evidence_switches_id_seq
  TO service_role;

COMMIT;

-- Schema-only rollback, allowed only before any v1 history must be retained:
-- backend/db/rollback_v63_product_opportunities_v1.sql
