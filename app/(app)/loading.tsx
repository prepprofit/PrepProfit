/**
 * Route-level loading UI for the app modules: a lightweight skeleton shown while
 * a server component streams. Matches the page rhythm (title + content block)
 * without pulling in a spinner library.
 */
export default function AppLoading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="h-4 w-48 animate-pulse rounded-md bg-surface-2" />
      <div className="grid gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-xl border border-border bg-surface"
          />
        ))}
      </div>
    </div>
  );
}
