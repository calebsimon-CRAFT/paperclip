import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ExternalObjectMention,
  ExternalObjectMentionGroup,
  ExternalObjectSummary,
} from "@paperclipai/shared";
import { externalObjectsApi } from "../api/externalObjects";
import { queryKeys } from "../lib/queryKeys";
import { normalizeExternalObjectHref } from "../lib/external-object-href";
import type { MarkdownExternalReferenceMap } from "../components/MarkdownBody";
import type { ExternalObjectPillData } from "../components/ExternalObjectPill";

/**
 * Browser-safe mention-source label. Mirrors the shared/server helper but
 * avoids importing `@paperclipai/shared/external-objects.ts` (which pulls in
 * `node:crypto`). Keep in sync with the shared formatter.
 */
function formatMentionSourceLabel(mention: ExternalObjectMention): string {
  switch (mention.sourceKind) {
    case "title":
      return "Title";
    case "description":
      return "Description";
    case "comment":
      return "Comment";
    case "document":
      return mention.documentKey ? `Document: ${mention.documentKey}` : "Document";
    case "property":
      return mention.propertyKey ? `Property: ${mention.propertyKey}` : "Property";
    case "plugin":
      return "Plugin";
    default:
      return "Source";
  }
}

export interface IssueExternalObjectGroup {
  pill: ExternalObjectPillData;
  mentionCount: number;
  sourceLabels: string[];
  group: ExternalObjectMentionGroup;
}

export interface IssueExternalObjectsResult {
  groups: IssueExternalObjectGroup[];
  /** Lookup map for `MarkdownBody`'s `externalReferences` prop. */
  markdownReferences: MarkdownExternalReferenceMap;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * Loads `external_objects` for an issue and produces both the per-group rows
 * (used by the property panel and related-work section) and the markdown URL
 * lookup map (used by inline decoration). Single source of truth so every
 * surface reads from the same query result.
 */
export function useIssueExternalObjects(issueId: string | null | undefined): IssueExternalObjectsResult {
  const enabled = Boolean(issueId);
  const query = useQuery({
    queryKey: queryKeys.externalObjects.byIssue(issueId ?? "__none__"),
    queryFn: () => externalObjectsApi.listForIssue(issueId!),
    enabled,
    staleTime: 60_000,
  });

  const groups = useMemo<IssueExternalObjectGroup[]>(() => {
    const data = query.data ?? [];
    return data
      .filter((entry): entry is ExternalObjectMentionGroup => Boolean(entry.object))
      .map((entry) => {
        const object = entry.object!;
        const sourceLabels = entry.sourceLabels && entry.sourceLabels.length > 0
          ? entry.sourceLabels
          : Array.from(new Set(entry.mentions.map(formatMentionSourceLabel)));
        return {
          group: entry,
          mentionCount: entry.mentionCount ?? entry.mentions.length,
          sourceLabels,
          pill: {
            providerKey: object.providerKey,
            objectType: object.objectType,
            statusCategory: object.statusCategory,
            liveness: object.liveness,
            displayTitle: object.displayTitle,
            statusLabel: object.statusLabel,
            url: object.sanitizedCanonicalUrl,
          },
        };
      });
  }, [query.data]);

  const markdownReferences = useMemo<MarkdownExternalReferenceMap>(() => {
    const result: MarkdownExternalReferenceMap = {};
    for (const { group } of groups) {
      const object = group.object;
      if (!object) continue;
      // Index by the object's canonical URL.
      const canonical = normalizeExternalObjectHref(object.sanitizedCanonicalUrl ?? null);
      if (canonical) {
        result[canonical] = {
          providerKey: object.providerKey,
          objectType: object.objectType,
          statusCategory: object.statusCategory,
          liveness: object.liveness,
          statusLabel: object.statusLabel,
          displayTitle: object.displayTitle,
        };
      }
      // Also index by every mention's sanitized display URL so user-pasted
      // hrefs that differ only in case/punctuation still resolve.
      for (const mention of group.mentions) {
        const normalizedMention = normalizeExternalObjectHref(
          mention.sanitizedDisplayUrl ?? null,
        );
        if (normalizedMention && !result[normalizedMention]) {
          result[normalizedMention] = {
            providerKey: object.providerKey,
            objectType: object.objectType,
            statusCategory: object.statusCategory,
            liveness: object.liveness,
            statusLabel: object.statusLabel,
            displayTitle: object.displayTitle,
          };
        }
      }
    }
    return result;
  }, [groups]);

  return {
    groups,
    markdownReferences,
    isLoading: enabled && query.isLoading,
    isError: query.isError,
    refetch: () => { void query.refetch(); },
  };
}

export function useIssueExternalObjectSummary(issueId: string | null | undefined): {
  summary: ExternalObjectSummary | null;
  isLoading: boolean;
} {
  const enabled = Boolean(issueId);
  const query = useQuery({
    queryKey: queryKeys.externalObjects.issueSummary(issueId ?? "__none__"),
    queryFn: () => externalObjectsApi.getIssueSummary(issueId!),
    enabled,
    staleTime: 60_000,
  });
  return {
    summary: query.data ?? null,
    isLoading: enabled && query.isLoading,
  };
}

export function useProjectExternalObjectSummary(projectId: string | null | undefined): {
  summary: ExternalObjectSummary | null;
  isLoading: boolean;
} {
  const enabled = Boolean(projectId);
  const query = useQuery({
    queryKey: queryKeys.externalObjects.projectSummary(projectId ?? "__none__"),
    queryFn: () => externalObjectsApi.getProjectSummary(projectId!),
    enabled,
    staleTime: 60_000,
  });
  return {
    summary: query.data ?? null,
    isLoading: enabled && query.isLoading,
  };
}
