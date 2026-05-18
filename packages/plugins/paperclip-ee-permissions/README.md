# @paperclipai/plugin-paperclip-ee-permissions

Closed-source Paperclip EE plugin that hosts the advanced company access,
grants, and authorization-policy UX.

## Status

Phase 5 implementation surface. The plugin registers a `companySettingsPage`
slot at `/permissions`, activates a per-company EE mode stub, and renders the
advanced authorization controls through typed plugin-SDK access and
authorization clients.

## Capabilities

- `access.members.read` / `access.members.write`
- `access.invites.read` / `access.invites.write`
- `authorization.grants.read` / `authorization.grants.write`
- `authorization.policies.read` / `authorization.policies.write`
- `authorization.audit.read`
- `companies.read`, `agents.read`, `issues.read`
- `plugin.state.read`, `plugin.state.write`
- `instance.settings.register`, `ui.page.register`

The plugin never imports from `ui/src/api/access.ts` or any other host UI
internal — all data flows through `ctx.access.*` and `ctx.authorization.*`.

## Deterministic missing-state UX

The page renders one of three states:

| Condition                                  | UI                                                    |
| ------------------------------------------ | ----------------------------------------------------- |
| `companyId === null`                       | "No active company" card                              |
| License inactive for company               | "Advanced permissions mode is not active" with Activate button |
| License active, host returns capability or worker error | Inline warning card; rest of the page still renders |

## Advanced surfaces

When licensed, the company settings page exposes:

- Agent visibility policy editing (`discoverable` / `private`).
- Assignment policy editing with broad, scoped-to-agent, and clear grant modes.
- Protected-agent approval requirement fields.
- Permission preview and explanation panels that call the same core
  authorization decision path used by enforcement.
- Authorization audit filters for actor, resource, action, and decision.

The license check is a per-company plugin-state stub today; later phases
replace it with a core-owned `advanced_permissions_enabled` flag.

## Scripts

- `pnpm build` — bundle worker, manifest, and UI via esbuild
- `pnpm test` — run vitest harness tests for the worker

## Layout

```
src/
  manifest.ts          # Slot + capability declarations
  worker.ts            # getData / performAction handlers
  ui/
    index.tsx          # Re-exports the slot component
    app.tsx            # EePermissionsCompanySettingsPage
tests/
  plugin.spec.ts       # Worker harness tests
```
