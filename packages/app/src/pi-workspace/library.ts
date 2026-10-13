import type {
  VisualLibraryPage,
  VisualVersionsPage,
  VisualDocument,
} from "@getpaseo/protocol/pi-workspace/contracts";

/** Paging is incremental; duplicate ids from a concurrent new drawing retain the newest head. */
export function appendLibraryPage(
  previous: VisualLibraryPage["items"],
  page: VisualLibraryPage,
): VisualLibraryPage["items"] {
  const items = new Map(previous.map((item) => [item.id, item]));
  for (const item of page.items) {
    const current = items.get(item.id);
    if (!current || item.revision >= current.revision) items.set(item.id, item);
  }
  return [...items.values()];
}
export function appendVersionPage(
  previous: VisualVersionsPage["items"],
  page: VisualVersionsPage,
): VisualVersionsPage["items"] {
  const revisions = new Set(previous.map((item) => item.revision));
  for (const item of page.items) revisions.add(item.revision);
  return [...revisions].sort((left, right) => right - left).map((revision) => ({ revision }));
}
export function visualHistoryLabel(document: VisualDocument): string | null {
  if (document.historyState === undefined) return null;
  const state =
    document.historyState === "initial" ? "No archived choices; initial view" : "Archived choices";
  return `Version ${document.revision} · ${state}`;
}
