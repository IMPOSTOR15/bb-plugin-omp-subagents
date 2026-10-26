// React binding for the shared roster store: one hook for every component.
import { useCallback, useSyncExternalStore } from "react";
import { EMPTY_VIEW, rosterStore, type RosterView } from "./roster-store.ts";

/**
 * Subscribe to one thread's roster. Mounting starts (or reuses) the store's
 * fetch and fallback poll for the thread; unmounting the last subscriber hands
 * the thread to the store's background poll. `threadId === null` is inert.
 */
export function useRoster(threadId: string | null): RosterView & { refetch(): void } {
  const subscribe = useCallback(
    (listener: () => void) =>
      threadId === null ? () => undefined : rosterStore.subscribe(threadId, listener),
    [threadId],
  );
  const view = useSyncExternalStore(
    subscribe,
    () => (threadId === null ? EMPTY_VIEW : rosterStore.getView(threadId)),
  );
  const refetch = useCallback(() => {
    if (threadId !== null) rosterStore.request(threadId);
  }, [threadId]);
  return { ...view, refetch };
}
