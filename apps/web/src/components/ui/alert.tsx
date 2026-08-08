import { cva, type VariantProps } from "class-variance-authority";
import { Children, isValidElement } from "react";
import type * as React from "react";

import { cn } from "~/lib/utils";

const alertVariants = cva("relative rounded-xl border px-3.5 py-3 text-card-foreground text-sm", {
  defaultVariants: {
    variant: "default",
  },
  variants: {
    variant: {
      default: "bg-transparent dark:bg-input/32 [&_svg]:text-muted-foreground",
      error:
        "border-error/32 bg-error-surface text-error-foreground [&_[data-slot=alert-description]]:text-error-foreground/80 [&_svg]:text-error",
      info: "border-info/32 bg-info/4 [&_svg]:text-info",
      success: "border-success/32 bg-success/4 [&_svg]:text-success",
      warning:
        "border-warning/32 bg-warning-surface text-warning-foreground [&_[data-slot=alert-description]]:text-warning-foreground/80 [&_svg]:text-warning",
    },
  },
});

function alertChildSlot(child: React.ReactElement): string | undefined {
  const propsSlot = (child.props as Record<string, string | undefined>)["data-slot"];
  if (propsSlot) {
    return propsSlot;
  }

  const type = child.type as { displayName?: string; name?: string };
  switch (type.displayName ?? type.name) {
    case "AlertAction":
      return "alert-action";
    case "AlertTitle":
      return "alert-title";
    case "AlertDescription":
      return "alert-description";
    default:
      return undefined;
  }
}

function Alert({
  className,
  variant,
  controlAlignment = "center",
  stackControlOnNarrow = false,
  children,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    controlAlignment?: "center" | "first-line";
    // Let a wide control drop below the message on a phone instead of squeezing
    // it into a ribbon. Opt-in, because it is only correct in a container that
    // fills the viewport: under a shrink-to-fit ancestor (`w-fit`) the content's
    // mobile flex-basis becomes a floor the container never grows to meet, and
    // even a lone dismiss button ends up wrapped.
    stackControlOnNarrow?: boolean;
  }) {
  const icon: React.ReactNode[] = [];
  const content: React.ReactNode[] = [];
  const action: React.ReactNode[] = [];

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) {
      content.push(child);
      return;
    }
    const slot = alertChildSlot(child);
    if (slot === "alert-action") {
      action.push(child);
    } else if (slot === "alert-title" || slot === "alert-description") {
      content.push(child);
    } else {
      icon.push(child);
    }
  });

  return (
    <div
      className={cn(alertVariants({ variant }), className)}
      data-slot="alert"
      role="alert"
      {...props}
    >
      <div
        className={cn(
          "flex gap-2",
          controlAlignment === "first-line" ? "items-start" : "items-center",
          controlAlignment === "first-line" &&
            action.length > 0 &&
            "min-h-7 pt-1 sm:min-h-6 sm:pt-0.5",
          stackControlOnNarrow && action.length > 0 && "max-sm:flex-wrap",
        )}
      >
        {icon.length > 0 && (
          <div
            className={cn(
              "flex shrink-0 items-center justify-center",
              controlAlignment === "first-line"
                ? "h-lh w-4 [&>svg]:size-4"
                : "size-4 [&>svg]:size-full",
            )}
          >
            {icon}
          </div>
        )}
        {content.length > 0 && (
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col gap-0.5",
              // This is what makes the wrap self-selecting: `flex-1` is
              // `flex: 1 1 0%`, so the row's hypothetical size always fits and
              // it would never wrap. Claiming 12rem on a phone means only a
              // control that cannot sit beside a readable message drops below —
              // a lone dismiss button still fits. `flex-1` regrows the content
              // to the full line once the control has moved.
              //
              // Order-sensitive: `basis-48` and the `flex-1` shorthand both set
              // flex-basis at equal specificity, so this relies on Tailwind
              // emitting `.max-sm\:basis-48` after `.flex-1` (verified on 4.2.1
              // and 4.3.0). If that ever inverts, the basis stays 0 and the row
              // silently stops wrapping.
              //
              // At the composer's 338px phone row the threshold is a control
              // wider than 112px. Today only the connection banner (190px)
              // crosses it; the next widest is the update offer at 96px, so
              // there is ~16px of headroom before a second banner starts
              // stacking.
              stackControlOnNarrow && action.length > 0 && "max-sm:basis-48",
            )}
          >
            {content}
          </div>
        )}
        {action.length > 0 && (
          <div
            className={cn(
              "flex shrink-0 items-center",
              controlAlignment === "first-line" ? "h-lh self-start" : "self-center",
            )}
          >
            {action}
          </div>
        )}
      </div>
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("font-medium", className)} data-slot="alert-title" {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2.5 text-muted-foreground", className)}
      data-slot="alert-description"
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex gap-1", className)} data-slot="alert-action" {...props} />;
}

AlertTitle.displayName = "AlertTitle";
AlertDescription.displayName = "AlertDescription";
AlertAction.displayName = "AlertAction";

export { Alert, AlertTitle, AlertDescription, AlertAction };
