import { useEffect, useId, useState } from "react";
import { create } from "zustand";
import { SIDEBAR_SECTION_NAME_MAX_LENGTH } from "@t3tools/contracts";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type Request = {
  readonly title: string;
  readonly initialName: string;
  readonly resolve: (name: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Create and rename share this: resolves to the trimmed name, or null when cancelled. */
export function requestSidebarSectionName(input: {
  readonly title: string;
  readonly initialName: string;
}): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...input, resolve } }));
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function SidebarSectionNameDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <SidebarSectionNameDialog request={request} /> : null;
}

function SidebarSectionNameDialog({ request }: { readonly request: Request }) {
  const id = useId();
  const [name, setName] = useState(request.initialName);
  // A blank name is refused here: the settings merge drops an invalid entry, so a blank rename
  // would silently delete the section.
  const trimmed = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== "") finish(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-1.5">
              <Label htmlFor={id}>Name</Label>
              <Input
                id={id}
                autoFocus
                maxLength={SIDEBAR_SECTION_NAME_MAX_LENGTH}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed === ""}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
