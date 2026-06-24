import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
import { KIND_LABELS } from "#/lib/kinds";
import { type RelayStats, getStats } from "#/server/stats";

export const Route = createFileRoute("/_dash/stats")({ component: StatsPage });

function StatsPage() {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["stats"],
    queryFn: () => getStats(),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Stats</h1>
        <p className="text-sm text-muted-foreground">A snapshot of what the relay is storing.</p>
      </div>

      {isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load stats"}
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label="Total events" value={data?.totalEvents} pending={isPending} />
            <Stat label="Unique authors" value={data?.uniqueAuthors} pending={isPending} />
            <Stat label="Last 24 hours" value={data?.last24h} pending={isPending} />
            <Stat label="Last 7 days" value={data?.last7d} pending={isPending} />
            <Stat label="Deleted (NIP-09)" value={data?.deletedEvents} pending={isPending} />
            <Stat label="Expiring (NIP-40)" value={data?.expiringEvents} pending={isPending} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Events by kind</CardTitle>
            </CardHeader>
            <CardContent>
              {isPending ? (
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-6 w-full" />
                  ))}
                </div>
              ) : (
                <ByKind byKind={data?.byKind ?? []} />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, pending }: { label: string; value?: number; pending: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        {pending ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <span className="text-3xl font-semibold tabular-nums">
            {(value ?? 0).toLocaleString()}
          </span>
        )}
      </CardContent>
    </Card>
  );
}

function ByKind({ byKind }: { byKind: RelayStats["byKind"] }) {
  if (byKind.length === 0) {
    return <p className="text-sm text-muted-foreground">No events yet.</p>;
  }
  const max = Math.max(...byKind.map((k) => k.count), 1);
  return (
    <div className="space-y-2">
      {byKind.map((k) => (
        <div key={k.kind} className="flex items-center gap-3">
          <div className="flex w-32 shrink-0 items-center gap-2">
            <Badge variant="secondary" className="font-mono">
              {k.kind}
            </Badge>
            <span className="truncate text-xs text-muted-foreground">
              {KIND_LABELS[k.kind] ?? ""}
            </span>
          </div>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${(k.count / max) * 100}%` }}
            />
          </div>
          <span className="w-20 shrink-0 text-right text-sm tabular-nums">
            {k.count.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}
