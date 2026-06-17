-- Migration: 002_posthog_outbox
-- Defines the posthog_outbox destination table and the materialized view that
-- populates it from raw_events_v2.
--
-- Events forwarded to PostHog:
--   product.*  — all product lifecycle events (installs, imports, onboarding)
--   ui.*       — all UI interaction events
--   task.completed, task.blocked, task.in_review, task.cancelled, task.checkout
--              — selected task lifecycle events for funnel and retention analysis
--
-- Design notes:
--   - distinct_id = install_id (pseudonymous UUID, never PII)
--   - properties column stores the full merged JSON blob for the PostHog /capture API
--   - sent_at / retry_count are managed by the outbox sender process, not this MV
--   - TTL set to 30 days: outbox rows that have not been sent in 30 days are dropped
--
-- Source table: raw_events_v2 (migration 001)
-- Rollback:
--   DROP VIEW  IF EXISTS posthog_outbox_mv;
--   DROP TABLE IF EXISTS posthog_outbox;

-- ── Destination table ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS posthog_outbox
(
    event_id            UUID                                  COMMENT 'Row dedup key from raw_events_v2',
    install_id          String           CODEC(ZSTD(1))       COMMENT 'Pseudonymous install UUID',
    distinct_id         String           CODEC(ZSTD(1))       COMMENT 'PostHog distinct_id (= install_id)',
    event_name          LowCardinality(String)                COMMENT 'Dot-namespaced event name',
    occurred_at         DateTime64(3, 'UTC')                  COMMENT 'Client event time',
    received_at         DateTime64(3, 'UTC')                  COMMENT 'Ingest receive time',
    enqueued_at         DateTime64(3, 'UTC') DEFAULT now64()  COMMENT 'Time this row was inserted into the outbox',
    properties          String           CODEC(ZSTD(1))       COMMENT 'JSON object sent as PostHog event properties',
    sent_at             Nullable(DateTime64(3, 'UTC'))        COMMENT 'Time the row was successfully delivered to PostHog',
    retry_count         UInt8            DEFAULT 0            COMMENT 'Number of delivery attempts'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (occurred_at, install_id, event_id)
TTL occurred_at + INTERVAL 30 DAY DELETE
SETTINGS
    index_granularity = 8192;

-- ── Materialized view ─────────────────────────────────────────────────────────
--
-- Lineage: raw_events_v2 → (filter by event_name) → posthog_outbox_mv → posthog_outbox
-- Refresh trigger: INSERT into raw_events_v2
--
-- Properties JSON is assembled inline using ClickHouse's map() + toJSONString().
-- Promoted columns are included alongside dimensions_json so PostHog receives the
-- full dimension set without requiring the sender to re-join or re-fetch raw rows.

CREATE MATERIALIZED VIEW IF NOT EXISTS posthog_outbox_mv
TO posthog_outbox
AS
SELECT
    event_id,
    install_id,
    install_id AS distinct_id,
    event_name,
    occurred_at,
    received_at,
    -- Build PostHog-compatible properties JSON.
    -- toJSONString(map(...)) serialises a String→String map; numeric/bool values
    -- that live in dimensions_json / measurements_json are forwarded as-is via
    -- JSON merge at the sender layer (dimensions_json already is a JSON string).
    toJSONString(
        map(
            'schema_version', '2',
            'app',            app,
            'version',        version,
            'retention_class', retention_class,
            'agent_role',     agent_role,
            'work_mode',      work_mode,
            'adapter_type',   adapter_type,
            'model',          model,
            'source',         source,
            'status',         status,
            'dimensions_json', dimensions_json,
            'measurements_json', measurements_json
        )
    ) AS properties
FROM raw_events_v2
WHERE
    -- product.* — all product lifecycle events
    event_name LIKE 'product.%'
    -- ui.* — all UI interaction events
    OR event_name LIKE 'ui.%'
    -- selected task.* events for funnel / retention analysis
    OR event_name IN (
        'task.completed',
        'task.blocked',
        'task.in_review',
        'task.cancelled',
        'task.checkout'
    );
