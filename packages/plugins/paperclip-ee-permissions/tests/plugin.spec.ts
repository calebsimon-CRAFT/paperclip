import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { EXPORT_NAMES, SLOT_IDS } from "../src/manifest.js";
import plugin, {
  type EePermissionsAdvancedPolicyData,
  type EePermissionsLicense,
  type EePermissionsOverview,
} from "../src/worker.js";

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_AGENT_ID = "00000000-0000-4000-8000-0000000000a1";
const TARGET_AGENT_ID = "00000000-0000-4000-8000-0000000000a2";
const ISSUE_ID = "00000000-0000-4000-8000-0000000000b1";

describe("paperclip-ee-permissions manifest", () => {
  it("declares the company settings page slot", () => {
    const slot = manifest.ui?.slots?.find(
      (entry) => entry.id === SLOT_IDS.companySettingsPage,
    );
    expect(slot).toBeDefined();
    expect(slot?.type).toBe("companySettingsPage");
    expect(slot?.exportName).toBe(EXPORT_NAMES.companySettingsPage);
    expect(slot?.routePath).toBe("permissions");
  });

  it("requires the access and authorization read capabilities", () => {
    for (const capability of [
      "access.members.read",
      "access.members.write",
      "issues.read",
      "authorization.grants.read",
      "authorization.grants.write",
      "authorization.policies.read",
      "authorization.policies.write",
      "authorization.audit.read",
      "ui.page.register",
      "instance.settings.register",
      "plugin.state.read",
      "plugin.state.write",
    ] as const) {
      expect(manifest.capabilities).toContain(capability);
    }
  });
});

describe("paperclip-ee-permissions worker", () => {
  it("returns an unlicensed overview by default", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
    });
    await plugin.definition.setup(harness.ctx);
    const overview = await harness.getData<EePermissionsOverview>("overview", {
      companyId: COMPANY_ID,
    });
    expect(overview.companyId).toBe(COMPANY_ID);
    expect(overview.license.status).toBe("inactive");
    expect(overview.policySummary).toBeNull();
    expect(overview.warnings).toEqual([]);
  });

  it("activates and deactivates the per-company license", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
    });
    await plugin.definition.setup(harness.ctx);

    const activated = await harness.performAction<EePermissionsLicense>(
      "activateLicense",
      { companyId: COMPANY_ID, activatedByUserId: "user-1" },
    );
    expect(activated.status).toBe("active");
    expect(activated.activatedByUserId).toBe("user-1");

    const overview = await harness.getData<EePermissionsOverview>("overview", {
      companyId: COMPANY_ID,
    });
    expect(overview.license.status).toBe("active");
    expect(overview.policySummary).toMatchObject({
      companyId: COMPANY_ID,
      permissionsMode: "simple",
      advancedPolicyAvailable: false,
    });

    const deactivated = await harness.performAction<EePermissionsLicense>(
      "deactivateLicense",
      { companyId: COMPANY_ID },
    );
    expect(deactivated.status).toBe("inactive");

    const reverted = await harness.getData<EePermissionsOverview>("overview", {
      companyId: COMPANY_ID,
    });
    expect(reverted.license.status).toBe("inactive");
    expect(reverted.policySummary).toBeNull();
  });

  it("returns empty lists for grants/members when unlicensed", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
    });
    await plugin.definition.setup(harness.ctx);
    const members = await harness.getData("members", { companyId: COMPANY_ID });
    const grants = await harness.getData("grants", { companyId: COMPANY_ID });
    const audit = await harness.getData("audit", { companyId: COMPANY_ID });
    expect(members).toEqual([]);
    expect(grants).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("falls back to empty data when a capability is missing", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities.filter(
        (capability) => capability !== "authorization.grants.read",
      ),
    });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("activateLicense", { companyId: COMPANY_ID });
    const grants = await harness.getData("grants", { companyId: COMPANY_ID });
    expect(grants).toEqual([]);
  });

  it("loads advanced policy data and previews through the authorization SDK", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
    });
    harness.seed({
      agents: [
        {
          id: ACTOR_AGENT_ID,
          companyId: COMPANY_ID,
          name: "Actor",
          role: "engineer",
          status: "active",
          adapterType: "process",
          adapterConfig: {},
          permissions: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
        {
          id: TARGET_AGENT_ID,
          companyId: COMPANY_ID,
          name: "Target",
          role: "engineer",
          status: "active",
          adapterType: "process",
          adapterConfig: {},
          permissions: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      ],
      issues: [
        {
          id: ISSUE_ID,
          companyId: COMPANY_ID,
          title: "Preview issue",
          status: "todo",
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      ],
    });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("activateLicense", { companyId: COMPANY_ID });

    const data = await harness.getData<EePermissionsAdvancedPolicyData>("advancedPolicy", {
      companyId: COMPANY_ID,
      actorAgentId: ACTOR_AGENT_ID,
      targetAgentId: TARGET_AGENT_ID,
      issueId: ISSUE_ID,
      decision: "allow",
    });

    expect(data.agents).toHaveLength(2);
    expect(data.issues).toHaveLength(1);
    expect(data.selected).toMatchObject({
      actorAgentId: ACTOR_AGENT_ID,
      targetAgentId: TARGET_AGENT_ID,
      issueId: ISSUE_ID,
    });
    expect(data.preview).toMatchObject({ allowed: true });
    expect(data.explanation).toMatchObject({ allowed: true });
  });

  it("updates agent policies and assignment grants through SDK actions", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
    });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("activateLicense", { companyId: COMPANY_ID });

    const policy = await harness.performAction<Record<string, unknown>>("saveAgentPolicy", {
      companyId: COMPANY_ID,
      agentId: TARGET_AGENT_ID,
      visibilityMode: "private",
      assignmentMode: "protected",
      requiresApproval: true,
      approvalReason: "Sensitive production agent",
    });
    const grants = await harness.performAction("saveAssignmentGrant", {
      companyId: COMPANY_ID,
      actorAgentId: ACTOR_AGENT_ID,
      targetAgentId: TARGET_AGENT_ID,
      mode: "scoped_agent",
    });

    expect(policy.policy).toMatchObject({
      agentVisibility: { mode: "private" },
      protectedAgent: { requiresApproval: true },
    });
    expect(grants).toEqual([]);
  });

  it("rejects requests that omit companyId", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
    });
    await plugin.definition.setup(harness.ctx);
    await expect(harness.getData("overview", {})).rejects.toThrow(/companyId/);
  });
});
