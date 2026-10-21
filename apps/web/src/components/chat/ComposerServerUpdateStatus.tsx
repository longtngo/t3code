import { Spinner } from "~/components/ui/spinner";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { CircleAlertIcon, DownloadIcon } from "lucide-react";

// Restored, upstream's verbatim. The fork had deleted this as unused; upstream's
// auto-balance update banner (useAutoBalanceUpdateBanner) imports it, so the merge
// brought back a live caller. Deleting it again breaks that banner's icon.
export function ComposerServerUpdateIcon({
  status,
}: {
  readonly status: ServerUpdateState["status"];
}) {
  if (status === "running") {
    return <Spinner aria-hidden />;
  }
  if (status === "failed") {
    return <CircleAlertIcon aria-hidden className="text-error" />;
  }
  return <DownloadIcon aria-hidden />;
}
