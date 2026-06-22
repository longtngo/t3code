import { useMemo, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { type ArgSpec, PROVIDER_ARG_SPECS } from "@t3tools/shared/localLlm";
import { cn } from "~/lib/utils";
import { addArg, buildArg, filterSpecs, removeArg } from "./argPicker.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * Edits a list of grouped launch-arg tokens for a provider, choosing flags from the
 * provider's CLI catalog. Flag-type flags add immediately; enum flags expand to value
 * buttons; number/string flags reveal an inline value input.
 */
export function ArgPickerMenu(props: {
  providerId: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const { providerId, value, onChange } = props;
  const specs = PROVIDER_ARG_SPECS[providerId] ?? [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<ArgSpec | null>(null);
  const [draft, setDraft] = useState("");

  const filtered = useMemo(() => filterSpecs(specs, query), [specs, query]);

  const reset = () => {
    setQuery("");
    setActive(null);
    setDraft("");
  };
  const commit = (str: string) => {
    onChange(addArg(value, str));
    setOpen(false);
    reset();
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((arg, i) => (
        <span
          key={`${arg}-${i}`}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
        >
          {arg}
          <button
            type="button"
            aria-label={`Remove ${arg}`}
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onChange(removeArg(value, i))}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      {value.length === 0 ? (
        <span className="text-[11px] text-muted-foreground/60">{props.placeholder ?? "inherit defaults"}</span>
      ) : null}

      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <PopoverTrigger
          render={
            <Button size="xs" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]">
              <PlusIcon className="size-3" /> arg
            </Button>
          }
        />
        <PopoverPopup align="start" className="w-72 p-0">
          <div className="border-b border-border p-2">
            <Input
              size="sm"
              autoFocus
              placeholder={`Filter ${specs.length} flags…`}
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <div className="max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-3 text-center text-xs text-muted-foreground">No documented flags</div>
            ) : (
              filtered.map((spec) => {
                const isActive = active?.flag === spec.flag;
                return (
                  <div key={spec.flag} className="border-b border-border/60 last:border-0">
                    <button
                      type="button"
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 px-2.5 py-2 text-left hover:bg-accent",
                        isActive && "bg-accent",
                      )}
                      onClick={() => {
                        if (spec.type === "flag") {
                          commit(buildArg(spec));
                        } else {
                          setActive(isActive ? null : spec);
                          setDraft("");
                        }
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <code className="text-[12px]">{spec.flag}</code>
                        <span className="rounded border border-border px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                          {spec.type}
                        </span>
                      </span>
                      {spec.desc ? (
                        <span className="text-[11px] text-muted-foreground">{spec.desc}</span>
                      ) : null}
                    </button>
                    {isActive ? (
                      <div className="flex flex-wrap items-center gap-1.5 bg-muted/30 px-2.5 py-2">
                        {spec.type === "enum" ? (
                          (spec.values ?? []).map((v) => (
                            <Button key={v} size="xs" variant="outline" onClick={() => commit(buildArg(spec, v))}>
                              {v}
                            </Button>
                          ))
                        ) : (
                          <>
                            <Input
                              size="sm"
                              className="w-32"
                              type={spec.type === "number" ? "number" : "text"}
                              placeholder={spec.placeholder ?? "value"}
                              value={draft}
                              onChange={(e) => setDraft(e.currentTarget.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && draft.trim() !== "") commit(buildArg(spec, draft.trim()));
                              }}
                            />
                            <Button
                              size="sm"
                              disabled={draft.trim() === ""}
                              onClick={() => commit(buildArg(spec, draft.trim()))}
                            >
                              Add
                            </Button>
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
