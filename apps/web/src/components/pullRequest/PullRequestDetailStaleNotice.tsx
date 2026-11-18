import { T, useGT } from "gt-react";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

export function PullRequestDetailStaleNotice({
  error,
  refreshing,
  onRetry,
}: {
  error: string;
  refreshing: boolean;
  onRetry: () => void;
}) {
  const gt = useGT();
  return (
    // A background refresh failing is not urgent: announce it politely, not as an alert.
    <Alert variant="warning" role="status">
      <AlertDescription>{gt("Showing the last copy. {error}", { error })}</AlertDescription>
      <AlertAction>
        <Button size="xs" variant="ghost" onClick={onRetry} disabled={refreshing}>
          <T>Retry</T>
        </Button>
      </AlertAction>
    </Alert>
  );
}
