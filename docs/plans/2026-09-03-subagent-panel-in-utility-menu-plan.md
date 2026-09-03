# Subagent backend panel inside the sidebar utility menu — plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** `SidebarSubagentBackend` renders inside `SidebarUtilityMenu`, so the settings page shows it.
**Spec:** docs/design/2026-09-03-subagent-panel-in-utility-menu-design.md

## Global Constraints

- Main sidebar footer markup stays byte-identical (static render before/after).
- Run web tests from `apps/web`: `pnpm exec vp test run <file>`.
- Format with `pnpm exec vp fmt <files>` before committing.

### Task 1: Move the mount, guard it, fix the settings-page alignment

**Files:**

- Modify: `apps/web/src/components/sidebar/SidebarChrome.tsx` (`SidebarUtilityMenu` ~137-284, `SidebarChromeFooter` ~286-294)
- Modify: `apps/web/src/components/settings/SettingsSidebarNav.tsx:297` (`items-center` → `items-end`)
- Modify: `apps/web/src/components/sidebar/sidebarChromeFooter.test.tsx`
- Modify: `docs/fork/README.md` §5b

- [ ] Step 1: In `sidebarChromeFooter.test.tsx`, change the `./SidebarSubagentBackend` mock to return `createElement("div", { "data-panel": "subagents" })`. Add:

```tsx
it("mounts the subagent disclosure inside the utility menu, which is what the settings page renders", () => {
  locationState.pathname = "/settings";
  const markup = renderToStaticMarkup(
    createElement(SidebarProvider, null, createElement(SidebarUtilityMenu)),
  );
  expect(markup).toContain('data-panel="subagents"');
});
it("mounts the subagent disclosure exactly once in the footer", () => {
  expect(renderFooterAt("/").split('data-panel="subagents"').length - 1).toBe(1);
});
```

(adapt `renderFooterAt`/`SidebarProvider`/`locationState` to the names the file already uses; import `SidebarUtilityMenu` from `./SidebarChrome`).

- [ ] Step 2: Run `pnpm exec vp test run src/components/sidebar/sidebarChromeFooter.test.tsx` — the first new test must FAIL, the second pass.
- [ ] Step 3: In `SidebarChrome.tsx`, make `SidebarUtilityMenu` return `<><SidebarSubagentBackend /><div className="relative" ref={footerRowRef}>…</div></>` and remove `<SidebarSubagentBackend />` from `SidebarChromeFooter`. Update the comment above the mount if it says where the panel lives.
- [ ] Step 4: In `SettingsSidebarNav.tsx:297`, `flex items-center gap-1` → `flex items-end gap-1`.
- [ ] Step 5: Run the test file again — all green. Run `pnpm exec vp test run src/components/sidebar src/components/settings/SettingsSidebarNav.test.tsx` (skip if the latter does not exist) and `pnpm run typecheck` from `apps/web`.
- [ ] Step 6: `docs/fork/README.md` §5b: replace the sentence naming "two footer-only panels … not in `SidebarChromeFooter`, which is a bare `<SidebarUtilityMenu />`" with one naming the four panels inside the menu (`SidebarLocalModels`, `SidebarResourceQueue`, `SidebarCrew`, `SidebarSubagentBackend`) and stating the footer keeps only `SidebarProviderUpdatePill` and `SidebarUpdateArchitectureWarning`.
- [ ] Step 7: `pnpm exec vp fmt` the four files; commit: `fix(web): show the subagent backend panel on the settings page`.
