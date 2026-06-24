import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Skeleton } from "#/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { KIND_LABELS, KIND_OPTIONS } from "#/lib/kinds";
import { shortNpub, toNpub } from "#/lib/pubkey";
import { listEvents } from "#/server/events";

export const Route = createFileRoute("/_dash/events")({ component: EventsPage });

const ALL = "all";

function EventsPage() {
  const [kind, setKind] = useState<string>(ALL);
  const [authorInput, setAuthorInput] = useState("");
  const [author, setAuthor] = useState("");

  const kindNum = kind === ALL ? undefined : Number(kind);

  const query = useInfiniteQuery({
    queryKey: ["events", { kind: kindNum, author }] as const,
    queryFn: ({ pageParam }) =>
      listEvents({
        data: {
          kind: kindNum,
          author: author || undefined,
          cursor: pageParam ?? undefined,
          limit: 50,
        },
      }),
    initialPageParam: null as { createdAt: number; id: string } | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const events = query.data?.pages.flatMap((p) => p.events) ?? [];

  const applyAuthor = (e: React.FormEvent) => {
    e.preventDefault();
    setAuthor(authorInput.trim());
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
        <p className="text-sm text-muted-foreground">
          Recent events stored by the relay, newest first.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All kinds</SelectItem>
            {KIND_OPTIONS.map((k) => (
              <SelectItem key={k} value={String(k)}>
                {k} {KIND_LABELS[k] ? `· ${KIND_LABELS[k]}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <form onSubmit={applyAuthor} className="flex flex-1 gap-2">
          <Input
            placeholder="Filter by author (npub or hex)"
            value={authorInput}
            onChange={(e) => setAuthorInput(e.target.value)}
            className="max-w-xs"
          />
          {(author || authorInput) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setAuthorInput("");
                setAuthor("");
              }}
            >
              Clear
            </Button>
          )}
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </form>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">Kind</TableHead>
              <TableHead className="w-40">Author</TableHead>
              <TableHead className="w-44">Created</TableHead>
              <TableHead>Content</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.isPending ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : query.isError ? (
              <TableRow>
                <TableCell colSpan={4} className="text-destructive">
                  {query.error instanceof Error ? query.error.message : "Failed to load events"}
                </TableCell>
              </TableRow>
            ) : events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No events match.
                </TableCell>
              </TableRow>
            ) : (
              events.map((ev) => <EventRowView key={ev.id} ev={ev} />)
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex justify-center">
        {query.hasNextPage && (
          <Button
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
    </div>
  );
}

function EventRowView({
  ev,
}: {
  ev: { id: string; pubkey: string; kind: number; createdAt: number; content: string };
}) {
  const npub = toNpub(ev.pubkey);
  return (
    <TableRow>
      <TableCell>
        <Badge variant="secondary" className="font-mono">
          {ev.kind}
        </Badge>
        {KIND_LABELS[ev.kind] && (
          <span className="ml-1 text-xs text-muted-foreground">{KIND_LABELS[ev.kind]}</span>
        )}
      </TableCell>
      <TableCell>
        <button
          type="button"
          className="font-mono text-xs hover:underline"
          title={npub}
          onClick={() => {
            void navigator.clipboard.writeText(npub);
            toast.success("Copied npub");
          }}
        >
          {shortNpub(ev.pubkey)}
        </button>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {new Date(ev.createdAt * 1000).toLocaleString()}
      </TableCell>
      <TableCell className="max-w-0">
        <p className="truncate text-sm" title={ev.content}>
          {ev.content || <span className="text-muted-foreground">—</span>}
        </p>
      </TableCell>
    </TableRow>
  );
}
