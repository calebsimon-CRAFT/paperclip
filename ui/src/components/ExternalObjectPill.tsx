import type { ReactNode } from "react";
import type {
  ExternalObjectLivenessState,
  ExternalObjectStatusCategory,
} from "@paperclipai/shared";
import { ExternalObjectStatusIcon } from "./ExternalObjectStatusIcon";
import {
  externalObjectStatusIcon,
  externalObjectStatusIconDefault,
  externalObjectLivenessOverlay,
} from "../lib/status-colors";
import {
  externalObjectCategoryLabel,
  externalObjectLivenessLabel,
  externalObjectIconForKey,
  externalObjectProviderLabel,
  externalObjectTypeLabel,
} from "../lib/external-objects";
import { cn } from "../lib/utils";

export interface ExternalObjectPillData {
  providerKey: string | null;
  objectType: string | null;
  displayKey?: string | null;
  iconKey?: string | null;
  statusCategory: ExternalObjectStatusCategory;
  liveness: ExternalObjectLivenessState;
  displayTitle?: string | null;
  statusLabel?: string | null;
  statusIconKey?: string | null;
  url?: string | null;
}

function githubObjectLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const [, owner, repo, kind, number] = parsed.pathname.split("/");
    if (!owner || !repo || !number) return null;
    if (kind !== "pull" && kind !== "issues") return null;
    return `${owner}/${repo}#${number}`;
  } catch {
    return null;
  }
}

function externalObjectValueLabel(object: ExternalObjectPillData, fallback: string): string {
  const githubLabel = object.providerKey === "github" ? githubObjectLabel(object.url) : null;
  return githubLabel ?? object.displayTitle?.trim() ?? fallback;
}

function externalObjectPillTone(object: ExternalObjectPillData): string {
  if (object.statusIconKey === "git-merge") {
    return "text-violet-600 border-violet-600 dark:text-violet-400 dark:border-violet-400";
  }
  return externalObjectStatusIcon[object.statusCategory] ?? externalObjectStatusIconDefault;
}

interface ExternalObjectPillProps {
  object: ExternalObjectPillData;
  /** Optional external mention count (renders as `×N` superscript when > 1). */
  sourceCount?: number;
  /** Optional source-mention summary used as the pill's `title` attribute. */
  sourceSummary?: string | null;
  className?: string;
  /** Optional rendered label override. Defaults to `provider object-type`. */
  children?: ReactNode;
  /**
   * If true the pill renders without a hover treatment (used inside
   * non-interactive contexts like the property panel). Defaults to false.
   */
  inert?: boolean;
}

/**
 * External-object equivalent of `IssueReferencePill`. Same `paperclip-mention-chip`
 * base so external references feel native to readers (Jakob's Law).
 */
export function ExternalObjectPill({
  object,
  sourceCount,
  sourceSummary,
  className,
  children,
  inert,
}: ExternalObjectPillProps) {
  const tone = externalObjectPillTone(object);
  const overlay = externalObjectLivenessOverlay[object.liveness] ?? "";
  const providerLabel = externalObjectProviderLabel(object.providerKey);
  const typeLabel = externalObjectTypeLabel(object.objectType);
  const displayKey = object.displayKey?.trim() || `${providerLabel} ${typeLabel}`;
  const valueLabel = externalObjectValueLabel(object, displayKey);
  const statusLabel = object.statusLabel ?? externalObjectCategoryLabel(object.statusCategory);
  const livenessLabel = externalObjectLivenessLabel(object.liveness);
  const ProviderIcon = externalObjectIconForKey(object.iconKey);
  const ariaLabel = `${providerLabel} ${typeLabel} — ${statusLabel}${
    object.liveness === "fresh" || object.liveness === "unknown" ? "" : ` (${livenessLabel})`
  }${object.displayTitle ? `: ${object.displayTitle}` : ""}`;

  const interactive = !inert && Boolean(object.url);
  const classNames = cn(
    "paperclip-mention-chip paperclip-mention-chip--external-object",
    "inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs no-underline",
    // Tone is applied as text classes only — the border style comes from the
    // overlay (dashed for stale/auth/unreachable).
    tone.split(" ").filter((c) => c.startsWith("text-")).join(" "),
    overlay,
    interactive
      && "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
    className,
  );
  const titleAttr = sourceSummary
    ? `${object.displayTitle ?? displayKey} — ${sourceSummary}`
    : object.displayTitle ?? displayKey;
  const labelText = children ?? (
    <>
      <span className="inline-flex items-center gap-0.5 rounded-full border border-current bg-background/70 px-1 text-[10px] font-medium">
        <ExternalObjectStatusIcon
          category={object.statusCategory}
          liveness={object.liveness}
          statusIconKey={object.statusIconKey}
          sizeClassName="h-2.5 w-2.5"
          label={`${providerLabel}: ${statusLabel}`}
        />
        <span>{statusLabel}</span>
      </span>
      <span className="max-w-[16rem] truncate font-medium">{valueLabel}</span>
    </>
  );
  const countSuffix = typeof sourceCount === "number" && sourceCount > 1 ? (
    <span className="tabular-nums text-[10px] font-medium opacity-80">×{sourceCount}</span>
  ) : null;
  const innerContent = (
    <>
      {ProviderIcon ? (
        <ProviderIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
      ) : (
        <ExternalObjectStatusIcon
          category={object.statusCategory}
          liveness={object.liveness}
          statusIconKey={object.statusIconKey}
          sizeClassName="h-3 w-3"
          label={`${providerLabel}: ${statusLabel}`}
        />
      )}
      <span className="inline-flex min-w-0 items-center gap-1">
        {labelText}
      </span>
      {countSuffix}
    </>
  );

  if (interactive && object.url) {
    return (
      <a
        href={object.url}
        target="_blank"
        rel="noopener noreferrer"
        data-mention-kind="external-object"
        data-external-status={object.statusCategory}
        data-external-liveness={object.liveness}
        className={classNames}
        title={titleAttr}
        aria-label={ariaLabel}
      >
        {innerContent}
      </a>
    );
  }

  return (
    <span
      data-mention-kind="external-object"
      data-external-status={object.statusCategory}
      data-external-liveness={object.liveness}
      className={classNames}
      title={titleAttr}
      aria-label={ariaLabel}
    >
      {innerContent}
    </span>
  );
}
