# Telemetry Event Registry

One JSON file per event namespace. Each file defines the events and their dimensions.

## File Format

```jsonc
{
  "namespace": "task",
  "events": [
    {
      "name": "task.completed",            // dot-namespaced: <namespace>.<verb>
      "description": "...",
      "retention_class": "standard",       // standard | sensitive | ephemeral
      "dimensions": [
        {
          "name": "agent_role",
          "type": "string",
          "required": false,
          "pii": false,
          "promoted": true                 // true = top-level envelope column (LowCardinality)
        }
      ]
    }
  ]
}
```

## Evolvability Rules

### 1. Additive-only envelope

The v2 envelope (`envelope.schema.json`) is append-only:
- You may add new **optional** fields to the envelope or to event objects.
- You may **never** rename an existing field.
- You may **never** add a new **required** field without a server-side default that populates it for all existing senders.

Violations require a dual-write migration window and CTO sign-off.

### 2. Dimensions-first column promotion

New dimensions MUST go into `dimensions_json` first (the escape valve). A dimension is eligible for promotion to a top-level ClickHouse `LowCardinality(String)` column only when **both** conditions hold:

1. **Coverage** — the dimension is populated in >20% of all events received in the last 30 days.
2. **Query-critical** — a dashboard query or alert actively filters or groups by it and suffers measurable scan cost without it.

Promotion requires a schema evolution registry entry, a ClickHouse DDL migration, and DataEngineer sign-off.

Currently promoted columns: `agent_role`, `work_mode`, `adapter_type`, `model`, `source`, `status`.

### 3. Separate endpoints for special payloads

Session replay recordings, binary blobs, and payloads >1 MB MUST NOT use the standard `/ingest` endpoint. Use a dedicated endpoint (to be defined) to avoid inflating the primary batch pipeline with large payloads that would trigger backpressure on the write buffer.
