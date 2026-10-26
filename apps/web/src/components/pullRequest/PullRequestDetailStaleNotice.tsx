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
  return (
    // A background refresh failing is not urgent: announce it politely, not as an alert.
    <Alert variant="warning" role="status">
      <AlertDescription>{`Showing the last copy. ${error}`}</AlertDescription>
      <AlertAction>
        <Button size="xs" variant="ghost" onClick={onRetry} disabled={refreshing}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}
