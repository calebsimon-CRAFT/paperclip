-- Migration: 001_raw_events_v2
-- Creates the primary ClickHouse ingest table for v2 telemetry events.
--
-- Partitioning: toYYYYMM(occurred_at) — monthly granularity keeps partition count
-- bounded (~12/year) and TTL deletes fire at month boundary.
-- Order key: (occurred_at, install_id, event_id) — time-range queries prune
-- efficiently; install_id sub-sorts for per-install funnels without a full scan.
-- LowCardinality on event_name, agent_role, etc. — ClickHouse keeps a dictionary
-- per column chunk; effective when cardinality < ~10k unique values.
-- Codec choices: ZSTD(1) for high-entropy string columns (install_id, JSON blobs),
-- Delta + LZ4 for monotonically increasing time columns.
--
-- Rollback:
--   DROP TABLE IF EXISTS raw_events_v2;

CREATE TABLE IF NOT EXISTS raw_events_v2
(
    -- Row identity
    event_id            UUID                                 COMMENT 'Row-level dedup key (UUID from client)',
    batch_id            UUID                                 COMMENT 'Kinesis/ingest-level dedup key (per batch)',

    -- Envelope fields
    app                 LowCardinality(String)               COMMENT 'Application identifier, e.g. paperclip',
    schema_version      LowCardinality(String)               COMMENT 'Envelope schema version, always 2 for this table',
    install_id          String           CODEC(ZSTD(1))      COMMENT 'Pseudonymous per-install UUID, never PII',
    version             LowCardinality(String)               COMMENT 'App version string',

    -- Event fields
    event_name          LowCardinality(String)               COMMENT 'Dot-namespaced event name, e.g. task.completed',
    occurred_at         DateTime64(3, 'UTC')                 COMMENT 'Client-reported event time (ISO 8601 → UTC)',
    received_at         DateTime64(3, 'UTC') DEFAULT now64() COMMENT 'Server receive time',
    retention_class     LowCardinality(String)               COMMENT 'standard | sensitive | ephemeral',

    -- Promoted dimension columns (LowCardinality = dictionary-encoded)
    -- New dimensions go into dimensions_json first; promote only at >20% coverage
    agent_role          LowCardinality(String) DEFAULT ''    COMMENT 'Promoted: agent role, e.g. cto',
    work_mode           LowCardinality(String) DEFAULT ''    COMMENT 'Promoted: agent work mode, e.g. standard',
    adapter_type        LowCardinality(String) DEFAULT ''    COMMENT 'Promoted: adapter type, e.g. claude_local',
    model               LowCardinality(String) DEFAULT ''    COMMENT 'Promoted: LLM model identifier',
    source              LowCardinality(String) DEFAULT ''    COMMENT 'Promoted: event origin, e.g. schedule',
    status              LowCardinality(String) DEFAULT ''    COMMENT 'Promoted: outcome status, e.g. success',

    -- Escape valves for pre-promotion dimensions
    dimensions_json     String           CODEC(ZSTD(1))      COMMENT 'JSON object of unpromoted string/number/bool dims',
    measurements_json   String           CODEC(ZSTD(1))      COMMENT 'JSON object of numeric measurements'
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (occurred_at, install_id, event_id)
TTL
    -- Standard events: 90 days
    occurred_at + INTERVAL 90 DAY DELETE WHERE retention_class = 'standard',
    -- Sensitive events: 30 days, restricted access enforced at query layer
    occurred_at + INTERVAL 30 DAY DELETE WHERE retention_class = 'sensitive',
    -- Ephemeral events: 7 days
    occurred_at + INTERVAL 7 DAY DELETE WHERE retention_class = 'ephemeral'
SETTINGS
    index_granularity = 8192;
