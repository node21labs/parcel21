import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { Activity, ListTree, LogOut, ShieldCheck } from "lucide-react";
import { Button } from "#/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar";
import { shortNpub, toNpub } from "#/lib/pubkey";
import { logout } from "#/server/auth";

const NAV = [
  { to: "/", label: "Allowlist", icon: ShieldCheck },
  { to: "/events", label: "Events", icon: ListTree },
  { to: "/stats", label: "Stats", icon: Activity },
] as const;

export function AppSidebar({ admin }: { admin: string }) {
  const qc = useQueryClient();
  const { pathname } = useLocation();
  const logoutMut = useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      qc.clear();
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
  });

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <ShieldCheck className="size-5 shrink-0" />
          <span className="font-semibold">Relay Admin</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Manage</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => {
                const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                      <Link to={item.to}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <span className="truncate font-mono text-xs text-muted-foreground" title={toNpub(admin)}>
            {shortNpub(admin)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            title="Sign out"
            disabled={logoutMut.isPending}
            onClick={() => logoutMut.mutate()}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
