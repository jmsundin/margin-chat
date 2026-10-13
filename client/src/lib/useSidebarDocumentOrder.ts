import { useEffect, useMemo, useState } from "react";
import type { Conversation, ThreadSummary } from "../types";
import { getGraphAnalysisEdges } from "./graphAnalysis";
import { finishSubjectClusters, groupSubjects, type GravityCluster, type SubjectCluster } from "./gravityClusters";
import {
  groupByDate, groupIntoCategories, recentlyViewedAt, sortAlphabetically, sortByRecentlyViewed, sortBySimilarity,
  type SidebarDateSection, type SidebarDocumentCategory, type SidebarDocumentSort,
} from "./sidebarDocumentOrder";
import { useClusterLabels } from "./useClusterLabels";
import { useSubjectCategories } from "./useSubjectCategories";
import { useTopicEmbeddings } from "./useTopicEmbeddings";
import { loadOpenedDocuments } from "./vaultWorkingSet";

export interface SidebarDocumentOrder {
  /** Every document in list order; sections follow the same order. */
  threads: ThreadSummary[];
  /** Set for the category sort once subjects are known. */
  categories: SidebarDocumentCategory[] | null;
  /** Set when the list is in recently viewed order: the same documents under Today, Yesterday and so on. */
  dateSections?: SidebarDateSection[] | null;
  /** Why the meaning-based sorts can't be used right now, or null when they can. */
  meaningUnavailable: string | null;
  /** Embeddings or category names are still arriving. */
  meaningLoading: boolean;
  /** A short note when the chosen sort falls back to recently viewed. */
  note: string | null;
}

/**
 * Orders the sidebar's documents. The meaning-based sorts use the same
 * embeddings, moves and category names as Clusters on the map, so a document
 * sits in the same category in both places.
 */
export function useSidebarDocumentOrder({ userId, storageUserId, jevEnabled, cloudSync, sort, threads, conversations, activeId, ready }: {
  userId: string;
  storageUserId: string;
  jevEnabled: boolean;
  /** Embeddings are made by the cloud vault, which needs a paid plan. */
  cloudSync: boolean;
  sort: SidebarDocumentSort;
  threads: ThreadSummary[];
  conversations: Record<string, Conversation>;
  activeId: string;
  ready: boolean;
}): SidebarDocumentOrder {
  const wantsMeaning = sort === "semantic" || sort === "category";
  const topics = useTopicEmbeddings({ userId, enabled: jevEnabled && cloudSync, active: wantsMeaning && ready });

  // When documents were opened, read again when the list changes or the window
  // comes back, so the list does not jump under the pointer while browsing.
  const [openedRevision, setOpenedRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setOpenedRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const documentCount = threads.length;
  const openedAt = useMemo(() => loadOpenedDocuments(storageUserId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storageUserId, sort, documentCount, openedRevision, ready]);

  const recent = useMemo(() => sortByRecentlyViewed(threads, openedAt), [threads, openedAt]);
  const hasVectors = topics.vectors.size > 0;
  const meaningUnavailable = !jevEnabled ? "Turn on Jev to sort by meaning."
    : !cloudSync ? "Sorting by meaning needs cloud sync, which comes with a paid plan."
    : topics.warning ? topics.warning
    : !topics.loading && !hasVectors && wantsMeaning ? "No document meanings yet. They are made as your documents sync."
    : null;
  const meaningReady = jevEnabled && cloudSync && hasVectors;

  const ids = useMemo(() => threads.map((thread) => thread.id), [threads]);
  const connections = useMemo(() => sort === "category" ? getGraphAnalysisEdges(conversations) : [], [sort, conversations]);
  const subjects = useMemo<SubjectCluster[]>(() => sort !== "category" || !meaningReady ? []
    : groupSubjects(ids, connections, (id) => topics.vectors.get(id)),
  // `topics.revision` changes whenever embeddings arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [sort, meaningReady, ids, connections, topics.revision]);
  const categoryNames = useSubjectCategories({ userId, enabled: jevEnabled, active: sort === "category" && ready, clusters: subjects, conversations });
  const clusters = useMemo<GravityCluster[]>(() => finishSubjectClusters(subjects, { names: categoryNames.names, placements: topics.placements })
    .map((cluster) => ({ ...cluster, id: cluster.hubId === null ? "unfiled" : `cluster:${cluster.hubId}`, center: { x: 0, y: 0 }, radius: 0 })),
  // `topics.revision` changes whenever moves arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [subjects, categoryNames.names, topics.revision]);
  const unnamed = useMemo(() => clusters.filter((cluster) => !cluster.name), [clusters]);
  const clusterLabels = useClusterLabels({ userId, enabled: jevEnabled, active: sort === "category" && ready, clusters: unnamed, conversations });
  const labels = useMemo(() => ({ loading: clusterLabels.loading || categoryNames.loading, labels: {
    ...clusterLabels.labels,
    ...Object.fromEntries(clusters.flatMap((cluster) => cluster.name ? [[cluster.id, { label: cluster.name, generated: true }]] : [])),
  } }), [clusterLabels, categoryNames.loading, clusters]);

  return useMemo(() => {
    const meaningLoading = wantsMeaning && topics.loading;
    const fallbackNote = wantsMeaning && meaningUnavailable && !meaningLoading ? `${meaningUnavailable} Showing recently viewed.` : null;
    if (sort === "alphabetical") return { threads: sortAlphabetically(threads), categories: null, meaningUnavailable, meaningLoading: false, note: null };
    if (sort === "semantic" && meaningReady) {
      const anchored = topics.vectors.has(activeId);
      return { threads: anchored ? sortBySimilarity(threads, activeId, (id) => topics.vectors.get(id), recent) : recent,
        categories: null, meaningUnavailable, meaningLoading,
        note: anchored || meaningLoading ? null : "The open document’s meaning isn’t ready yet. Showing recently viewed." };
    }
    if (sort === "category" && meaningReady && clusters.length) {
      const categories = groupIntoCategories(recent, clusters, (id) => labels.labels[id]?.label ?? "Untitled category");
      return { threads: categories.flatMap((category) => category.threads), categories, meaningUnavailable,
        meaningLoading: meaningLoading || labels.loading, note: null };
    }
    const dateSections = groupByDate(recent, (thread) => recentlyViewedAt(thread, openedAt));
    return { threads: recent, categories: null, dateSections, meaningUnavailable, meaningLoading, note: fallbackNote };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, threads, recent, openedAt, activeId, meaningReady, meaningUnavailable, clusters, labels, topics.loading, topics.revision, wantsMeaning]);
}
