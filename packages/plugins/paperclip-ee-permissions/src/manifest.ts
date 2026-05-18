import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-paperclip-ee-permissions";

export const SLOT_IDS = {
  companySettingsPage: "ee-permissions-company-settings-page",
} as const;

export const EXPORT_NAMES = {
  companySettingsPage: "EePermissionsCompanySettingsPage",
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Paperclip EE Permissions",
  description:
    "Advanced company access, grants, and authorization-policy UX for licensed Paperclip EE deployments.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: [
    "companies.read",
    "agents.read",
    "issues.read",
    "access.members.read",
    "access.invites.read",
    "authorization.grants.read",
    "authorization.policies.read",
    "authorization.audit.read",
    "access.members.write",
    "access.invites.write",
    "authorization.grants.write",
    "authorization.policies.write",
    "plugin.state.read",
    "plugin.state.write",
    "instance.settings.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "companySettingsPage",
        id: SLOT_IDS.companySettingsPage,
        displayName: "Permissions",
        exportName: EXPORT_NAMES.companySettingsPage,
        routePath: "permissions",
      },
    ],
  },
};

export default manifest;
