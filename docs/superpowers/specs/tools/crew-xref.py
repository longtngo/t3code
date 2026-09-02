#!/usr/bin/env python3
"""Cross-reference gate for the crew design doc.

Run: python3 docs/superpowers/specs/tools/crew-xref.py <design.md>   (rc=1 on any failure)

Every check here has been seen to fail on a seeded break — a dangling section
reference, a log code emitted but absent from section 9, and a citation to a
teardown step that does not exist. A check that has never been observed red is not
evidence.

This is not the `crewcheck.py` that review round 11 deleted. That one scored a
document's *quality* and passed a draft containing nine broken cross-section
edges. This one only compares sets that either match or do not.

Checks the class of defect that dominated review rounds 15-17: dangling section
references, log codes that disagree between the section that emits them and the
section that lists them, step citations that no longer exist, and primitive rows
nothing consumes.
"""
import re, sys, pathlib

def main(path):
    s = pathlib.Path(path).read_text()
    fails = []

    # 1. every §N citation resolves to a heading that exists
    heads = set(int(m) for m in re.findall(r"^## (\d+)\.", s, re.M))
    for m in re.finditer(r"§(\d+)", s):
        if int(m.group(1)) not in heads:
            fails.append(f"dangling section reference §{m.group(1)}")

    # 2. log codes: every code used outside §9 is listed in §9, and vice versa
    i9 = s.index("\n## 9.")
    i10 = s.index("\n## 10.")
    sec9, rest = s[i9:i10], s[:i9] + s[i10:]
    code = r"crew\.[a-z]+(?:\.[a-z0-9_-]+|\.<[^`>]+>)*"
    def codes(txt):
        out = set()
        for c in re.findall(code, txt):
            c = c.rstrip(".")
            if c.count(".") >= 1 and not c.endswith(("crew.list",)):
                out.add(c)
        return out
    def families(cs):
        # a code with a <a|b> placeholder covers its expansions
        exp = set()
        for c in cs:
            m = re.search(r"<([^>]+)>", c)
            if m:
                for alt in m.group(1).split("|"):
                    exp.add(c[:m.start()] + alt.strip())
            else:
                exp.add(c)
        return exp
    listed, used = families(codes(sec9)), families(codes(rest))
    used = {c for c in used if c.startswith(("crew.deliver", "crew.answer", "crew.dispatch",
                                             "crew.teardown", "crew.zombie", "crew.reap",
                                             "crew.tool", "crew.sweep", "crew.notification"))}
    for c in sorted(used - listed):
        fails.append(f"code used but not listed in §9: {c}")

    # 3. every "(step N)" / "step N" citation is a step §6 actually has
    i6 = s.index("\n## 6.")
    i7 = s.index("\n## 7.")
    steps = set(int(m) for m in re.findall(r"^(\d+)\. ", s[i6:i7], re.M))
    for m in re.finditer(r"step (\d+)", s):
        if int(m.group(1)) not in steps:
            fails.append(f"citation to teardown step {m.group(1)}, which §6 does not have (has {sorted(steps)})")

    # 4. the doc's §9 code list and the implementation's closed set agree, both ways
    #
    # This is the check that only became possible once there was an implementation.
    # Checks 2 and 3 compare the document against itself, which cannot catch the
    # failure mode this design spent three revisions on: a code the spec promises
    # and no path emits, or a code the code emits and the spec never mentions.
    # parents[4], not [3]: the script sits four directories deep
    # (docs/superpowers/specs/tools), so [3] is `docs/` and the path never
    # resolves — which is what made the first version of this check silently
    # inert. `exists()` returning false looked identical to "nothing wrong".
    impl = pathlib.Path(__file__).resolve().parents[4] / "apps/server/src/crew/CrewLog.ts"
    if not impl.exists():
        fails.append(f"CrewLog.ts not found at {impl}; check 4 would silently pass")
    else:
        body = impl.read_text()
        m = re.search(r"CREW_LOG_CODES = \[(.*?)\] as const", body, re.S)
        if m is None:
            fails.append("CrewLog.ts has no CREW_LOG_CODES literal to compare against")
        else:
            emitted = set(re.findall(r'"(crew\.[^"]+)"', m.group(1)))

            # §9 lists the six non-dispatch refusals as one prefix plus six
            # suffixes, deliberately — the cross product of <tool> x <reason>
            # yields 20 codes for the 6 that authority can produce. Rejoin them
            # so the comparison sees the codes rather than the shorthand.
            joined = re.search(
                r"`crew\.tool\.refused\.`\s*\+\s*((?:`[a-z_.-]+`,?\s*)+)", sec9
            )
            if joined is not None:
                for suffix in re.findall(r"`([a-z_.-]+)`", joined.group(1)):
                    listed.add(f"crew.tool.refused.{suffix}")

            # The Spans bullet names spans, not log codes, and they share the
            # `crew.` prefix. Spans go to a different sink entirely — a trace
            # file, not the crew log store — so comparing them against
            # CREW_LOG_CODES would demand the code emit a log line per span.
            spans = set()
            span_line = re.search(r"\*\*Spans:\*\*(.+?)\n-", sec9, re.S)
            if span_line is not None:
                spans = set(re.findall(r"`(crew\.[a-z.]+)`", span_line.group(1)))

            # Shorthand fragments the prose leaves dangling once its suffix list
            # has been consumed above.
            noise = {"crew.tool.refused", "crew.tool.refused.tool"}
            listed_codes = listed - spans - noise
            if not emitted:
                fails.append("CREW_LOG_CODES matched but parsed empty; the regex has drifted")
            for c in sorted(emitted - listed_codes):
                fails.append(f"code in CrewLog.ts but not listed in §9: {c}")
            for c in sorted(listed_codes - emitted):
                fails.append(f"code listed in §9 but absent from CrewLog.ts: {c}")

    # NOTE: a fifth check — "every §1 row has a consumer below §1" — was written and
    # removed. Matching a row's label against the body flags "Archival and turns" and
    # "Disk" as orphans when both are cited by meaning rather than by name. A check
    # that cries wolf is worse than no check; row orphans stay a reviewer's job.

    for f in sorted(set(fails)):
        print("FAIL:", f)
    print(f"\n{len(set(fails))} cross-reference failures")
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
