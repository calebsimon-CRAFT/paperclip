import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  oauthAuthorizationStates,
  oauthConnections,
} from "@paperclipai/db";
import { ProviderRegistry } from "../../oauth/registry.js";
import { oauthRoutes } from "../../routes/oauth.js";
import { oauthCallbackRoute } from "../../routes/oauth-callback.js";
import { runRefreshTick } from "../../oauth/refresh-worker.js";
import { createSlidingWindowLimiter } from "../../oauth/rate-limiter.js";
import {
  createTestSecretService,
  oauthEmbeddedPostgresSupport,
  seedTestCompany,
  seedTestUser,
  setupOAuthTestEnv,
  withExecuteRowsCompat,
  type Db,
} from "./test-setup.js";
import { startMockProvider, type MockProvider } from "./mock-provider.js";

const describeEmbeddedPostgres = oauthEmbeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!oauthEmbeddedPostgresSupport.supported) {
  console.warn(
    `Skipping OAuth integration tests on this host: ${oauthEmbeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

interface AppHarness {
  app: express.Express;
  registry: ProviderRegistry;
  secretService: ReturnType<typeof createTestSecretService>;
  companyId: string;
  userId: string;
}

describeEmbeddedPostgres("OAuth integration scenarios", () => {
  let env!: Awaited<ReturnType<typeof setupOAuthTestEnv>>;
  let db!: Db;
  let mock!: MockProvider;

  beforeAll(async () => {
    env = await setupOAuthTestEnv("oauth-integration");
    db = env.db;
  }, 60_000);

  afterAll(async () => {
    await env.cleanup();
  });

  afterEach(async () => {
    if (mock) {
      await mock.close();
    }
    await env.reset();
  });

  function buildHarness(opts: {
    companyId: string;
    userId: string;
  }): AppHarness {
    const baseEnv: Record<string, string | undefined> = {
      MOCK_OAUTH_CLIENT_ID: "client-id",
      MOCK_OAUTH_CLIENT_SECRET: "client-secret",
    };
    const registry = new ProviderRegistry({ env: baseEnv });
    registry.register(
      {
        id: "mock",
        displayName: "Mock",
        clientCredentials: {
          clientIdEnv: "MOCK_OAUTH_CLIENT_ID",
          clientSecretEnv: "MOCK_OAUTH_CLIENT_SECRET",
        },
        endpoints: {
          authorize: `${mock.url}/authorize`,
          token: `${mock.url}/token`,
          accountInfo: `${mock.url}/me`,
          revoke: `${mock.url}/revoke`,
        },
        scopes: { default: ["read"], offered: ["read"] },
        pkce: "required",
        authMethod: "post",
        responseFormat: "json",
        accountIdField: "id",
        accountLabelField: "name",
        refresh: { supported: true, rotatesRefreshToken: true },
      },
      "yaml",
    );

    const secretSvc = createTestSecretService(db, registry);
    const rateLimiter = createSlidingWindowLimiter({
      limit: 1000,
      windowMs: 5 * 60 * 1000,
    });
    const app = express();
    app.use(express.json());
    app.use(
      "/api/companies/:companyId/oauth",
      (req, _res, next) => {
        (req as any).actor = {
          type: "board",
          userId: opts.userId,
          memberships: [
            { companyId: req.params.companyId, role: "admin" },
          ],
        };
        next();
      },
      oauthRoutes({
        registry,
        db,
        publicUrl: "http://localhost",
        rateLimiter,
        secretService: secretSvc as any,
      }),
    );
    app.use(
      "/api/oauth/callback/:providerId",
      oauthCallbackRoute({
        registry,
        db,
        publicUrl: "http://localhost",
        secretService: secretSvc as any,
      }),
    );
    // Test-only error handler: surfaces middleware crashes as JSON so failing
    // assertions show a useful message instead of a bare 500.
    app.use(
      (
        err: Error,
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction,
      ) => {
        // eslint-disable-next-line no-console
        console.error("[test app error]", err.stack || err.message);
        res.status(500).json({ error: err.message, stack: err.stack });
      },
    );
    return {
      app,
      registry,
      secretService: secretSvc,
      companyId: opts.companyId,
      userId: opts.userId,
    };
  }

  async function makeAppForCompany(): Promise<AppHarness> {
    const userId = await seedTestUser(db);
    const companyId = await seedTestCompany(db);
    return buildHarness({ companyId, userId });
  }

  // ---------------------------------------------------------------------------
  // Scenarios 1-7
  // ---------------------------------------------------------------------------

  it("scenario 1: happy path — connect, callback, row written", async () => {
    mock = await startMockProvider();
    const { app, companyId } = await makeAppForCompany();

    const start = await request(app).post(
      `/api/companies/${companyId}/oauth/connect/mock`,
    );
    expect(start.status).toBe(200);
    const stateId = start.body.state as string;
    expect(stateId).toBeTruthy();

    const cb = await request(app).get(
      `/api/oauth/callback/mock?state=${stateId}&code=mock-code-1`,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain("oauth_connected=mock");

    const conns = await db
      .select()
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.companyId, companyId),
          eq(oauthConnections.providerId, "mock"),
        ),
      );
    expect(conns).toHaveLength(1);
    expect(conns[0]!.status).toBe("active");
    expect(conns[0]!.accountId).toBe("user-1");
    expect(conns[0]!.accountLabel).toBe("Test User");
    expect(conns[0]!.accessTokenSecretId).toBeTruthy();
    expect(conns[0]!.refreshTokenSecretId).toBeTruthy();
  });

  it("scenario 2: state replay returns oauth_error=replay", async () => {
    mock = await startMockProvider();
    const { app, companyId } = await makeAppForCompany();

    const start = await request(app).post(
      `/api/companies/${companyId}/oauth/connect/mock`,
    );
    const stateId = start.body.state as string;

    const first = await request(app).get(
      `/api/oauth/callback/mock?state=${stateId}&code=mock-code-1`,
    );
    expect(first.headers.location).toContain("oauth_connected=mock");

    const second = await request(app).get(
      `/api/oauth/callback/mock?state=${stateId}&code=mock-code-1`,
    );
    expect(second.status).toBe(302);
    expect(second.headers.location).toContain("oauth_error=replay");
  });

  it("scenario 3: expired state returns invalid_state", async () => {
    mock = await startMockProvider();
    const { app, companyId } = await makeAppForCompany();

    const start = await request(app).post(
      `/api/companies/${companyId}/oauth/connect/mock`,
    );
    const stateId = start.body.state as string;

    // Force expiry without sleeping — backdate the row.
    await db
      .update(oauthAuthorizationStates)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(oauthAuthorizationStates.id, stateId));

    const cb = await request(app).get(
      `/api/oauth/callback/mock?state=${stateId}&code=x`,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain("oauth_error=invalid_state");
  });

  it("scenario 4: provider mismatch routes to provider_mismatch", async () => {
    mock = await startMockProvider();
    const { app, registry, companyId } = await makeAppForCompany();
    // Register a second provider so the callback URL's provider differs from
    // the state's provider.
    registry.register(
      {
        id: "mock2",
        displayName: "Mock2",
        clientCredentials: {
          clientIdEnv: "MOCK_OAUTH_CLIENT_ID",
          clientSecretEnv: "MOCK_OAUTH_CLIENT_SECRET",
        },
        endpoints: {
          authorize: `${mock.url}/authorize`,
          token: `${mock.url}/token`,
          accountInfo: `${mock.url}/me`,
        },
        scopes: { default: [], offered: [] },
        pkce: "required",
        authMethod: "post",
        responseFormat: "json",
        accountIdField: "id",
        accountLabelField: "name",
        refresh: { supported: false },
      },
      "yaml",
    );

    const start = await request(app).post(
      `/api/companies/${companyId}/oauth/connect/mock`,
    );
    const stateId = start.body.state as string;

    const cb = await request(app).get(
      `/api/oauth/callback/mock2?state=${stateId}&code=x`,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain("oauth_error=provider_mismatch");
  });

  it("scenario 5: account mismatch on re-auth keeps existing connection", async () => {
    mock = await startMockProvider();
    const { app, companyId } = await makeAppForCompany();

    // First flow with default user-1.
    const s1 = await request(app).post(
      `/api/companies/${companyId}/oauth/connect/mock`,
    );
    const cb1 = await request(app).get(
      `/api/oauth/callback/mock?state=${s1.body.state}&code=c1`,
    );
    expect(cb1.headers.location).toContain("oauth_connected=mock");

    // Second flow returns a different account — should be rejected.
    mock.state.account = { id: "user-2", name: "Different" };
    const s2 = await request(app).post(
      `/api/companies/${companyId}/oauth/connect/mock`,
    );
    const cb2 = await request(app).get(
      `/api/oauth/callback/mock?state=${s2.body.state}&code=c2`,
    );
    expect(cb2.headers.location).toContain("oauth_error=account_mismatch");

    const conns = await db
      .select()
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.companyId, companyId),
          eq(oauthConnections.providerId, "mock"),
        ),
      );
    expect(conns).toHaveLength(1);
    expect(conns[0]!.accountId).toBe("user-1");
  });

  it("scenario 6: token exchange returns 500 → no connection row written", async () => {
    mock = await startMockProvider();
    const { app, companyId } = await makeAppForCompany();
    mock.state.tokenStatus = 500;

    const start = await request(app).post(
      `/api/companies/${companyId}/oauth/connect/mock`,
    );
    const cb = await request(app).get(
      `/api/oauth/callback/mock?state=${start.body.state}&code=x`,
    );
    expect(cb.headers.location).toContain("oauth_error=token_exchange_failed");

    const conns = await db
      .select()
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.companyId, companyId),
          eq(oauthConnections.providerId, "mock"),
        ),
      );
    expect(conns).toHaveLength(0);
  });

  it("scenario 7: refresh worker rotates near-expiry token", async () => {
    mock = await startMockProvider();
    const { app, registry, secretService, companyId } =
      await makeAppForCompany();

    // expiresInSeconds=60 → row will be inserted with accessTokenExpiresAt
    // ~1 minute out, well within the worker's 5-minute window.
    mock.state.expiresInSeconds = 60;

    const start = await request(app).post(
      `/api/companies/${companyId}/oauth/connect/mock`,
    );
    const cb = await request(app).get(
      `/api/oauth/callback/mock?state=${start.body.state}&code=x`,
    );
    expect(cb.headers.location).toContain("oauth_connected=mock");

    const before = await db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.companyId, companyId));
    expect(before).toHaveLength(1);
    const beforeSecretId = before[0]!.accessTokenSecretId!;
    const beforeExpiresAt = before[0]!.accessTokenExpiresAt;
    const beforeRefreshedAt = before[0]!.lastRefreshedAt;

    // Lengthen post-refresh expiry so the resulting connection clearly moved.
    mock.state.expiresInSeconds = 3600;
    const refreshCallsBeforeTick = mock.state.refreshCallCount;
    // NOTE: refresh-worker.ts reads `lockResult.rows?.[0]?.result`, which is
    // the node-postgres Result shape; the production runtime uses postgres-js
    // whose `Result` exposes rows as iterable elements (no `.rows` field).
    // We surface this with `withExecuteRowsCompat` so the rest of the worker
    // logic can be exercised end-to-end here. See follow-up note in the
    // Phase-7 report — production code change is out of scope for this phase.
    await runRefreshTick({
      db: withExecuteRowsCompat(db) as typeof db,
      registry,
      secretService: secretService as any,
    });
    expect(mock.state.refreshCallCount).toBe(refreshCallsBeforeTick + 1);

    const after = await db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.companyId, companyId));
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("active");
    // upsertSecretByName rotates the SAME secret in place, so id is stable but
    // a new version row should exist.
    expect(after[0]!.accessTokenSecretId).toBe(beforeSecretId);
    const accessSecret = await secretService.getById(beforeSecretId);
    expect(accessSecret?.latestVersion).toBeGreaterThanOrEqual(2);
    // New expiry should be ~1h out, not the original ~1m.
    expect(after[0]!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(
      beforeExpiresAt!.getTime() + 5 * 60 * 1000,
    );
    expect(after[0]!.lastRefreshedAt!.getTime()).toBeGreaterThanOrEqual(
      beforeRefreshedAt!.getTime(),
    );
  });
});
