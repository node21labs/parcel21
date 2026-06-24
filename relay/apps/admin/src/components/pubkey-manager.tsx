import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { shortNpub, toNpub } from "#/lib/pubkey";

/** Minimal shape both the write-allowlist and admins tables share. */
export interface PubkeyEntry {
  pubkey: string;
  label: string | null;
  addedAt: number;
}

interface PubkeyManagerProps {
  title: string;
  description: string;
  /** Unique slug for input ids (two managers render on one page). */
  resource: string;
  queryKey: readonly unknown[];
  list: () => Promise<PubkeyEntry[]>;
  add: (vars: { pubkey: string; label?: string }) => Promise<unknown>;
  remove: (pubkey: string) => Promise<unknown>;
  emptyText: string;
  addedToast: string;
  removedToast: string;
}

/**
 * A self-contained management card: an add form (pubkey + optional label) and a
 * table with per-row remove, wired through TanStack Query to the supplied
 * server functions. Server-side guards (e.g. last-admin lockout) surface as
 * error toasts.
 */
export function PubkeyManager(props: PubkeyManagerProps) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: props.queryKey });

  const {
    data: entries,
    isPending,
    isError,
    error,
  } = useQuery({
    queryKey: props.queryKey,
    queryFn: () => props.list(),
  });

  const [pubkey, setPubkey] = useState("");
  const [label, setLabel] = useState("");

  const addMut = useMutation({
    mutationFn: (vars: { pubkey: string; label?: string }) => props.add(vars),
    onSuccess: () => {
      setPubkey("");
      setLabel("");
      toast.success(props.addedToast);
      void invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to add"),
  });

  const removeMut = useMutation({
    mutationFn: (pk: string) => props.remove(pk),
    onSuccess: () => {
      toast.success(props.removedToast);
      void invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to remove"),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pubkey.trim()) return;
    addMut.mutate({ pubkey: pubkey.trim(), label: label.trim() || undefined });
  };

  const count = entries?.length ?? 0;
  const pubkeyId = `${props.resource}-pubkey`;
  const labelId = `${props.resource}-label`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {props.title} <Badge variant="secondary">{count}</Badge>
        </CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={pubkeyId}>Pubkey</Label>
            <Input
              id={pubkeyId}
              placeholder="npub1… or 64-char hex"
              value={pubkey}
              onChange={(e) => setPubkey(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:w-48">
            <Label htmlFor={labelId}>Label (optional)</Label>
            <Input
              id={labelId}
              placeholder="e.g. Chris"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={addMut.isPending || !pubkey.trim()}>
            <Plus className="size-4" /> Add
          </Button>
        </form>

        {isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{props.emptyText}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pubkey</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <PubkeyRow
                  key={entry.pubkey}
                  entry={entry}
                  removing={removeMut.isPending && removeMut.variables === entry.pubkey}
                  onRemove={() => removeMut.mutate(entry.pubkey)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function PubkeyRow({
  entry,
  onRemove,
  removing,
}: {
  entry: PubkeyEntry;
  onRemove: () => void;
  removing: boolean;
}) {
  const npub = toNpub(entry.pubkey);
  return (
    <TableRow>
      <TableCell>
        <button
          type="button"
          className="font-mono text-xs hover:underline"
          title="Copy npub"
          onClick={() => {
            void navigator.clipboard.writeText(npub);
            toast.success("Copied npub");
          }}
        >
          {shortNpub(entry.pubkey)}
        </button>
      </TableCell>
      <TableCell>{entry.label ?? <span className="text-muted-foreground">—</span>}</TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {new Date(entry.addedAt * 1000).toLocaleDateString()}
      </TableCell>
      <TableCell>
        <Button variant="ghost" size="icon" title="Remove" disabled={removing} onClick={onRemove}>
          <Trash2 className="size-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}
