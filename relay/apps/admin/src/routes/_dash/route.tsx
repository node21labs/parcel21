import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { AppSidebar } from "#/components/app-sidebar";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "#/components/ui/sidebar";
import { requestLoginEvent } from "#/lib/nostr";
import { login, me } from "#/server/auth";

const ME_KEY = ["me"] as const;

export const Route = createFileRoute("/_dash")({ component: DashLayout });

function DashLayout() {
  const { data: session, isPending } = useQuery({ queryKey: ME_KEY, queryFn: () => me() });

  if (isPending) return <Centered>Checking session…</Centered>;
  if (!session) return <LoginScreen />;

  return (
    <SidebarProvider>
      <AppSidebar admin={session.pubkey} />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <span className="text-sm font-medium text-muted-foreground">Relay Admin</span>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-8 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function LoginScreen() {
  const qc = useQueryClient();
  const loginMut = useMutation({
    mutationFn: async () => {
      const event = await requestLoginEvent();
      return login({ data: { event } });
    },
    onSuccess: () => {
      toast.success("Signed in");
      void qc.invalidateQueries({ queryKey: ME_KEY });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sign-in failed"),
  });

  return (
    <Centered>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5" /> Relay Admin
          </CardTitle>
          <CardDescription>Sign in with your Nostr key to manage the relay.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full"
            disabled={loginMut.isPending}
            onClick={() => loginMut.mutate()}
          >
            <KeyRound className="size-4" /> Sign in with Nostr
          </Button>
        </CardContent>
      </Card>
    </Centered>
  );
}
