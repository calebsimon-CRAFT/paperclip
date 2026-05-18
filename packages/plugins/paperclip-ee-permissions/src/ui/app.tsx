import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginCompanySettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

type LicenseState = {
  status: "active" | "inactive";
  activatedAt?: string;
  activatedByUserId?: string | null;
  note?: string | null;
};

type PolicySummary = {
  companyId: string;
  permissionsMode: "simple";
  memberCount: number;
  activeMemberCount: number;
  grantCount: number;
  advancedPolicyAvailable: false;
};

type AgentRecord = {
  id: string;
  name: string;
  role?: string | null;
  status?: string | null;
};

type IssueRecord = {
  id: string;
  title: string;
  status: string;
  projectId?: string | null;
};

type DecisionRecord = {
  allowed: boolean;
  action: string;
  explanation: string;
  reason: string;
  grant?: {
    permissionKey: string;
    scope: Record<string, unknown> | null;
  };
};

type Overview = {
  companyId: string;
  license: LicenseState;
  policySummary: PolicySummary | null;
  warnings: Array<{ code: string; message: string }>;
};

type AdvancedPolicyData = {
  summary: PolicySummary | null;
  warnings: Overview["warnings"];
  agents: AgentRecord[];
  issues: IssueRecord[];
  selected: {
    actorAgentId: string | null;
    targetAgentId: string | null;
    projectId: string | null;
    issueId: string | null;
  };
  agentPolicy: {
    resourceType: string;
    resourceId: string;
    policy: Record<string, unknown> | null;
    updatedAt: string | null;
  } | null;
  actorGrants: Array<{
    permissionKey: string;
    scope: Record<string, unknown> | null;
  }>;
  preview: DecisionRecord | null;
  explanation: DecisionRecord | null;
  auditEntries: Array<{
    id: string;
    actorType: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown> | null;
    createdAt: string;
  }>;
};

const layoutStack: CSSProperties = {
  display: "grid",
  gap: "16px",
  padding: "24px 0",
};

const cardStyle: CSSProperties = {
  border: "1px solid rgba(148, 163, 184, 0.28)",
  borderRadius: "8px",
  padding: "16px 20px",
  display: "grid",
  gap: "10px",
};

const subtleCardStyle: CSSProperties = {
  border: "1px solid rgba(148, 163, 184, 0.22)",
  borderRadius: "8px",
  padding: "14px",
  display: "grid",
  gap: "10px",
};

const mutedTextStyle: CSSProperties = {
  color: "rgba(100, 116, 139, 0.95)",
  fontSize: "0.9rem",
  lineHeight: 1.5,
};

const sectionHeadingStyle: CSSProperties = {
  fontSize: "0.75rem",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "rgba(100, 116, 139, 0.95)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "8px",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
};

const inputStyle: CSSProperties = {
  width: "100%",
  border: "1px solid rgba(148, 163, 184, 0.35)",
  borderRadius: "6px",
  padding: "8px 10px",
  background: "transparent",
  color: "inherit",
  fontSize: "0.85rem",
};

const buttonStyle: CSSProperties = {
  padding: "7px 12px",
  borderRadius: "6px",
  border: "1px solid rgba(148, 163, 184, 0.4)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "currentColor",
  color: "Canvas",
};

const codeStyle: CSSProperties = {
  margin: 0,
  maxHeight: "240px",
  overflow: "auto",
  border: "1px solid rgba(148, 163, 184, 0.18)",
  borderRadius: "6px",
  padding: "10px",
  fontSize: "0.75rem",
  lineHeight: 1.45,
};

const warningStyle: CSSProperties = {
  border: "1px solid rgba(234, 179, 8, 0.4)",
  background: "rgba(234, 179, 8, 0.08)",
  borderRadius: "8px",
  padding: "10px 12px",
  color: "rgba(120, 88, 0, 0.95)",
};

function JsonBlock({ value }: { value: unknown }) {
  return <pre style={codeStyle}>{JSON.stringify(value, null, 2)}</pre>;
}

function Pill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "allow" | "deny" }) {
  const colors = tone === "allow"
    ? { border: "rgba(22, 163, 74, 0.5)", background: "rgba(22, 163, 74, 0.1)" }
    : tone === "deny"
      ? { border: "rgba(220, 38, 38, 0.5)", background: "rgba(220, 38, 38, 0.08)" }
      : { border: "rgba(148, 163, 184, 0.35)", background: "transparent" };
  return (
    <span
      style={{
        border: `1px solid ${colors.border}`,
        background: colors.background,
        borderRadius: "999px",
        padding: "2px 8px",
        fontSize: "0.72rem",
      }}
    >
      {label}
    </span>
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CapabilityWarning({ warnings }: { warnings: Overview["warnings"] }) {
  if (warnings.length === 0) return null;
  return (
    <div style={warningStyle}>
      <strong>Some advanced data could not be loaded.</strong>
      <ul style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${index}`}>
            <code>{warning.code}</code>: {warning.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MissingCompanyState() {
  return (
    <div style={layoutStack}>
      <div style={cardStyle}>
        <div style={sectionHeadingStyle}>Permissions</div>
        <strong>No active company</strong>
        <div style={mutedTextStyle}>Switch into a company to manage advanced permissions.</div>
      </div>
    </div>
  );
}

function UnlicensedState({
  companyId,
  onActivate,
  activating,
}: {
  companyId: string;
  onActivate: () => void;
  activating: boolean;
}) {
  return (
    <div style={layoutStack}>
      <div style={cardStyle}>
        <div style={sectionHeadingStyle}>Paperclip EE Permissions</div>
        <strong>Advanced permissions mode is not active</strong>
        <div style={mutedTextStyle}>
          Members can collaborate across this company by default. Activate Paperclip EE permissions to unlock scoped grants, protected-agent controls, assignment previews, and audit filters.
        </div>
        <div>
          <button type="button" style={buttonStyle} disabled={activating} onClick={onActivate}>
            {activating ? "Activating..." : "Activate for this company"}
          </button>
        </div>
        <div style={mutedTextStyle}>
          Company: <code>{companyId}</code>
        </div>
      </div>
    </div>
  );
}

function getPolicySection(policy: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> {
  const value = policy?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getPolicyString(policy: Record<string, unknown> | null | undefined, section: string, key: string, fallback: string) {
  const value = getPolicySection(policy, section)[key];
  return typeof value === "string" ? value : fallback;
}

function getPolicyBoolean(policy: Record<string, unknown> | null | undefined, section: string, key: string, fallback: boolean) {
  const value = getPolicySection(policy, section)[key];
  return typeof value === "boolean" ? value : fallback;
}

function AdvancedPolicyEditor({ companyId }: { companyId: string }) {
  const saveAgentPolicy = usePluginAction("saveAgentPolicy");
  const saveAssignmentGrant = usePluginAction("saveAssignmentGrant");
  const [actorAgentId, setActorAgentId] = useState("");
  const [targetAgentId, setTargetAgentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [issueId, setIssueId] = useState("");
  const [auditAction, setAuditAction] = useState("");
  const [auditActorType, setAuditActorType] = useState("");
  const [auditEntityType, setAuditEntityType] = useState("");
  const [auditEntityId, setAuditEntityId] = useState("");
  const [auditDecision, setAuditDecision] = useState("");
  const [visibilityMode, setVisibilityMode] = useState("discoverable");
  const [assignmentMode, setAssignmentMode] = useState("company_default");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [approvalReason, setApprovalReason] = useState("");
  const [grantMode, setGrantMode] = useState("scoped_agent");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<unknown>(null);
  const params = useMemo(() => ({
    companyId,
    actorAgentId,
    targetAgentId,
    projectId,
    issueId,
    auditAction,
    auditActorType,
    auditEntityType,
    auditEntityId,
    auditDecision,
  }), [companyId, actorAgentId, targetAgentId, projectId, issueId, auditAction, auditActorType, auditEntityType, auditEntityId, auditDecision]);
  const query = usePluginData<AdvancedPolicyData>("advancedPolicy", params);
  const data = query.data;

  useEffect(() => {
    if (!data) return;
    if (!actorAgentId && data.selected.actorAgentId) setActorAgentId(data.selected.actorAgentId);
    if (!targetAgentId && data.selected.targetAgentId) setTargetAgentId(data.selected.targetAgentId);
  }, [actorAgentId, data, targetAgentId]);

  useEffect(() => {
    const policy = data?.agentPolicy?.policy;
    setVisibilityMode(getPolicyString(policy, "agentVisibility", "mode", "discoverable"));
    setAssignmentMode(getPolicyString(policy, "assignmentPolicy", "mode", "company_default"));
    setRequiresApproval(getPolicyBoolean(policy, "protectedAgent", "requiresApproval", false));
    setApprovalReason(getPolicyString(policy, "protectedAgent", "approvalReason", ""));
  }, [data?.agentPolicy?.resourceId, data?.agentPolicy?.updatedAt]);

  const projectOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const issue of data?.issues ?? []) {
      if (issue.projectId) ids.add(issue.projectId);
    }
    return [...ids];
  }, [data?.issues]);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusyAction(label);
    try {
      const result = await action();
      setLastResult(result);
      query.refresh();
    } catch (error) {
      setLastResult({ error: getErrorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }

  if (query.loading && !data) {
    return <div style={mutedTextStyle}>Loading advanced policy editors...</div>;
  }

  if (query.error) {
    return (
      <div style={warningStyle}>
        <strong>Advanced policy APIs unavailable.</strong>
        <div>{query.error.message}</div>
      </div>
    );
  }

  return (
    <div style={layoutStack}>
      <CapabilityWarning warnings={data?.warnings ?? []} />

      <div style={gridStyle}>
        <div style={subtleCardStyle}>
          <div style={rowStyle}>
            <strong>Mode</strong>
            <Pill label={data?.summary?.permissionsMode ?? "unknown"} />
          </div>
          <div style={mutedTextStyle}>
            Active members {data?.summary?.activeMemberCount ?? 0} / {data?.summary?.memberCount ?? 0}. Explicit grants {data?.summary?.grantCount ?? 0}.
          </div>
        </div>
        <div style={subtleCardStyle}>
          <div style={rowStyle}>
            <strong>Preview Decision</strong>
            <Pill label={data?.preview?.allowed ? "allow" : "deny"} tone={data?.preview?.allowed ? "allow" : "deny"} />
          </div>
          <div style={mutedTextStyle}>{data?.preview?.explanation ?? "Select an actor and target agent."}</div>
        </div>
      </div>

      <div style={gridStyle}>
        <label style={{ display: "grid", gap: "6px" }}>
          <span style={sectionHeadingStyle}>Actor agent</span>
          <select style={inputStyle} value={actorAgentId} onChange={(event) => setActorAgentId(event.target.value)}>
            {(data?.agents ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: "6px" }}>
          <span style={sectionHeadingStyle}>Target agent</span>
          <select style={inputStyle} value={targetAgentId} onChange={(event) => setTargetAgentId(event.target.value)}>
            {(data?.agents ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: "6px" }}>
          <span style={sectionHeadingStyle}>Project scope</span>
          <select style={inputStyle} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Any project</option>
            {projectOptions.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: "6px" }}>
          <span style={sectionHeadingStyle}>Issue context</span>
          <select style={inputStyle} value={issueId} onChange={(event) => setIssueId(event.target.value)}>
            <option value="">No issue</option>
            {(data?.issues ?? []).map((issue) => <option key={issue.id} value={issue.id}>{issue.title}</option>)}
          </select>
        </label>
      </div>

      <div style={gridStyle}>
        <div style={cardStyle}>
          <div style={sectionHeadingStyle}>Agent Visibility</div>
          <label style={{ display: "grid", gap: "6px" }}>
            <span>Directory mode</span>
            <select style={inputStyle} value={visibilityMode} onChange={(event) => setVisibilityMode(event.target.value)}>
              <option value="discoverable">Discoverable</option>
              <option value="private">Private</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: "6px" }}>
            <span>Assignment mode</span>
            <select style={inputStyle} value={assignmentMode} onChange={(event) => setAssignmentMode(event.target.value)}>
              <option value="company_default">Company default</option>
              <option value="protected">Protected</option>
            </select>
          </label>
          <label style={rowStyle}>
            <input type="checkbox" checked={requiresApproval} onChange={(event) => setRequiresApproval(event.target.checked)} />
            <span>Require approval for protected assignment</span>
          </label>
          <input style={inputStyle} placeholder="Approval reason" value={approvalReason} onChange={(event) => setApprovalReason(event.target.value)} />
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={!targetAgentId || busyAction !== null}
            onClick={() => void run("policy", () => saveAgentPolicy({
              companyId,
              agentId: targetAgentId,
              visibilityMode,
              assignmentMode,
              requiresApproval,
              approvalReason,
            }))}
          >
            {busyAction === "policy" ? "Saving..." : "Save agent policy"}
          </button>
        </div>

        <div style={cardStyle}>
          <div style={sectionHeadingStyle}>Assignment Policy</div>
          <label style={{ display: "grid", gap: "6px" }}>
            <span>Grant mode</span>
            <select style={inputStyle} value={grantMode} onChange={(event) => setGrantMode(event.target.value)}>
              <option value="scoped_agent">Scoped to selected target</option>
              <option value="broad">Broad assignment</option>
              <option value="clear">Clear assignment grants</option>
            </select>
          </label>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={!actorAgentId || busyAction !== null}
            onClick={() => void run("grants", () => saveAssignmentGrant({
              companyId,
              actorAgentId,
              targetAgentId,
              projectId,
              mode: grantMode,
            }))}
          >
            {busyAction === "grants" ? "Saving..." : "Save assignment grants"}
          </button>
          <JsonBlock value={data?.actorGrants ?? []} />
        </div>
      </div>

      <div style={gridStyle}>
        <div style={cardStyle}>
          <div style={sectionHeadingStyle}>Permission Explanation</div>
          <div style={rowStyle}>
            <Pill label={data?.explanation?.reason ?? "unavailable"} tone={data?.explanation?.allowed ? "allow" : "deny"} />
            <span style={mutedTextStyle}>{data?.explanation?.explanation ?? "No explanation returned."}</span>
          </div>
          <JsonBlock value={data?.explanation ?? null} />
        </div>
        <div style={cardStyle}>
          <div style={sectionHeadingStyle}>Current Agent Policy</div>
          <JsonBlock value={data?.agentPolicy?.policy ?? null} />
        </div>
      </div>

      <div style={cardStyle}>
        <div style={rowStyle}>
          <div style={sectionHeadingStyle}>Authorization Audit</div>
          <button type="button" style={buttonStyle} onClick={() => query.refresh()}>Refresh</button>
        </div>
        <div style={{ ...gridStyle, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
          <input style={inputStyle} placeholder="Action" value={auditAction} onChange={(event) => setAuditAction(event.target.value)} />
          <select style={inputStyle} value={auditActorType} onChange={(event) => setAuditActorType(event.target.value)}>
            <option value="">Any actor</option>
            <option value="agent">Agent</option>
            <option value="user">User</option>
            <option value="plugin">Plugin</option>
            <option value="system">System</option>
          </select>
          <input style={inputStyle} placeholder="Resource type" value={auditEntityType} onChange={(event) => setAuditEntityType(event.target.value)} />
          <input style={inputStyle} placeholder="Resource id" value={auditEntityId} onChange={(event) => setAuditEntityId(event.target.value)} />
          <select style={inputStyle} value={auditDecision} onChange={(event) => setAuditDecision(event.target.value)}>
            <option value="">Any decision</option>
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </select>
        </div>
        <JsonBlock value={data?.auditEntries ?? []} />
      </div>

      {lastResult ? <JsonBlock value={lastResult} /> : null}
    </div>
  );
}

export function EePermissionsCompanySettingsPage(_props: PluginCompanySettingsPageProps) {
  const hostContext = useHostContext();
  const companyId = hostContext.companyId;
  const overview = usePluginData<Overview>("overview", companyId ? { companyId } : {});
  const activate = usePluginAction("activateLicense");
  const deactivate = usePluginAction("deactivateLicense");
  const [activationBusy, setActivationBusy] = useState(false);

  if (!companyId) return <MissingCompanyState />;

  if (overview.loading && !overview.data) {
    return (
      <div style={layoutStack}>
        <div style={cardStyle}>
          <div style={mutedTextStyle}>Loading permissions overview...</div>
        </div>
      </div>
    );
  }

  if (overview.error) {
    return (
      <div style={layoutStack}>
        <div style={cardStyle}>
          <div style={sectionHeadingStyle}>Permissions</div>
          <strong>Could not load permissions</strong>
          <div style={mutedTextStyle}>
            <code>{overview.error.code}</code>: {overview.error.message}
          </div>
        </div>
      </div>
    );
  }

  const data = overview.data;
  if (!data) {
    return (
      <div style={layoutStack}>
        <div style={cardStyle}>
          <div style={mutedTextStyle}>No data returned.</div>
        </div>
      </div>
    );
  }

  if (data.license.status !== "active") {
    return (
      <UnlicensedState
        companyId={companyId}
        activating={activationBusy}
        onActivate={() => {
          setActivationBusy(true);
          void activate({ companyId })
            .then(() => overview.refresh())
            .finally(() => setActivationBusy(false));
        }}
      />
    );
  }

  return (
    <div style={layoutStack}>
      <div style={cardStyle}>
        <div style={rowStyle}>
          <div style={sectionHeadingStyle}>Paperclip EE Permissions</div>
          <Pill label="active" tone="allow" />
        </div>
        <strong>Advanced policy editing is active</strong>
        <div style={mutedTextStyle}>
          Policy data stays in core and this plugin edits it through capability-gated SDK calls. If the plugin is unavailable later, existing restrictions remain server-enforced.
        </div>
        <div>
          <button
            type="button"
            style={buttonStyle}
            disabled={activationBusy}
            onClick={() => {
              setActivationBusy(true);
              void deactivate({ companyId })
                .then(() => overview.refresh())
                .finally(() => setActivationBusy(false));
            }}
          >
            {activationBusy ? "Updating..." : "Deactivate"}
          </button>
        </div>
      </div>

      <AdvancedPolicyEditor companyId={companyId} />
    </div>
  );
}
