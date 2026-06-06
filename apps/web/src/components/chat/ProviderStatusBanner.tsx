import { type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  providerStatusBannerKey,
  useDismissedProviderStatusBanners,
} from "./ProviderStatusBanner.logic";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  const dismissedKeys = useDismissedProviderStatusBanners((state) => state.dismissedKeys);
  const dismiss = useDismissedProviderStatusBanners((state) => state.dismiss);

  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const bannerKey = providerStatusBannerKey(status);
  if (dismissedKeys.has(bannerKey)) {
    return null;
  }

  const providerLabel = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
        <AlertAction>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Dismiss provider status notice"
                  className="inline-flex size-5 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100"
                  onClick={() => dismiss(bannerKey)}
                >
                  <XIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="top">Dismiss until provider status changes</TooltipPopup>
          </Tooltip>
        </AlertAction>
      </Alert>
    </div>
  );
});
