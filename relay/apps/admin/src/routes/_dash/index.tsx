import { createFileRoute } from "@tanstack/react-router";
import { PubkeyManager } from "#/components/pubkey-manager";
import { addAdmin, listAdmins, removeAdmin } from "#/server/admins";
import { addAllowlistEntry, listAllowlist, removeAllowlistEntry } from "#/server/allowlist";

const ALLOWLIST_KEY = ["allowlist"] as const;
const ADMINS_KEY = ["admins"] as const;

export const Route = createFileRoute("/_dash/")({ component: AllowlistPage });

function AllowlistPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PubkeyManager
        title="Write allowlist"
        description="Authors allowed to publish to the relay. An empty list means the relay accepts writes from anyone; reads always stay open."
        resource="allowlist"
        queryKey={ALLOWLIST_KEY}
        list={() => listAllowlist()}
        add={(vars) => addAllowlistEntry({ data: vars })}
        remove={(pubkey) => removeAllowlistEntry({ data: { pubkey } })}
        emptyText="No authors on the allowlist yet."
        addedToast="Added to allowlist"
        removedToast="Removed from allowlist"
      />

      <PubkeyManager
        title="Admins"
        description="Operators who can sign into this admin UI. Seeded once from ADMIN_PUBKEYS; the last admin can't be removed."
        resource="admins"
        queryKey={ADMINS_KEY}
        list={() => listAdmins()}
        add={(vars) => addAdmin({ data: vars })}
        remove={(pubkey) => removeAdmin({ data: { pubkey } })}
        emptyText="No admins yet."
        addedToast="Added admin"
        removedToast="Removed admin"
      />
    </div>
  );
}
