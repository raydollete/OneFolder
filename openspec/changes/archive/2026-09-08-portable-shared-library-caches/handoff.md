# Handoff — portable-shared-library-caches (2026-09-08)

## Where we are

Planning is COMPLETE for the new change `portable-shared-library-caches` (Tier 3, feature): all 4 artifacts written and validated (`openspec validate --strict` passes; radflow-lint clean except one expected WARN — the peer-review MCP is unavailable so the Tier-3 external review is recorded Unavailable). **0 of 14 implementation tasks done — no implementation code has been written yet.** Next lifecycle step is apply.

This change was born out of a dual-boot support question during the still-open `add-portable-linux-appimage` work (whose task 5.1 manual acceptance remains outstanding — see Open questions). This session also did a partial headless acceptance of that other change; details under Done this session.

## Owner's verbatim words

<!-- Exact user text, quoted. Times are the nearest UTC marker from this session's context (approximate). -->
- (~18:32) "run the whole sheet" — work order to run the 5.1 dual-boot/GUI acceptance sheet for add-portable-linux-appimage.
- (~18:33, decision answering "How should I proceed on 5.1 given this shell has no GUI display?") selected: "Rebuild + headless serve smoke".
- (~19:27) "The executable runs" — confirming the packaged AppImage launches on the owner's GNOME Wayland session.
- (~19:29) "I am running this in the same directory as I had previously built a Windows database.  Is there a way I can remap the Windows path to the Linux equivalent path (it is relative to the executable) so that I don't have to build the same library twice?"
- (~19:32) "What about going back and forth?  I'm on a dual boot system.  I don't want to have to do location recovery each time."
- (~20:19) "The library that I manage has thousands of entries and I'd strongly like to not re-derive the thumbnails"
- (~20:29, decision answering "How do you want to avoid re-deriving the thumbnails across the dual boot?") selected: "Durable code fix (OpenSpec)".
- (~20:29) "it needs to be a shared library.  The 2 executables will sit in the same directory."
- (~20:44, decision answering "What should this change cover?") selected: "Also portable location root".
- (~20:54, decision answering "Bomb-squad found the DB keys file identity on the absolute path ... How should the change fix that?") selected: "Re-base identity on location+relative path (durable)".
- (~21:07) "/rad-propose Track progress in your native task list: seed it with the propose phase steps (proposal, design, external review, spec deltas, tasks) now and keep step statuses updated as you work." followed by "run ~/dev/radflow/adopt.sh".

## Done this session

- **Investigated the dual-boot problem against real code** — confirmed: location stores one absolute root (`src/api/location.ts` `LocationDTO.path`); files store forward-slash `relativePath` + derived `absolutePath` (`src/frontend/entities/File.ts:88`); thumbnails/previews key on `hash(absolutePath)` (`common/fs.ts:8`, `src/server/thumbnails.ts:168`, duplicated hash at `:180`).
- **Ran a bomb-squad latent-defect hunt** — it found the originally-scoped change would DUPLICATE the whole library on first cross-boot (file identity in SQLite is the absolute path). Findings A–J are transcribed in `design.md` → `## Bomb-squad findings`. This reshaped scope; the owner chose the durable identity re-basing.
- **Installed the rad-\* skills** via `~/dev/radflow/adopt.sh --harness claude` (rad-propose etc. now available). Doctor WARNs: peer-review MCP not detected; a stale `.agents/skills/openspec-*` duplicate surface (non-blocking; `/rad-update` clears it).
- **Wrote and validated the full change** under `openspec/changes/portable-shared-library-caches/`: `proposal.md` (Tier 3, verbatim Stated Requirements, 22-site Blast Radius), `specs/portable-location-roots/spec.md` + `specs/portable-thumbnail-cache/spec.md`, `design.md`, `tasks.md` (14 boxes). Design decisions the owner made are recorded IN `design.md` — not restated here.
- **Partial acceptance of the OTHER change (add-portable-linux-appimage, task 5.1)** — rebuilt `dist/OneFolder-1.1.2-x86_64.AppImage` (`yarn package:appimage`, exit 0), `yarn verify:appimage` PASSED. Headless Block D finding: `--serve` is read-only and refuses to run without an existing library DB, so it needs a normal GUI first-launch first; it did create the sibling `data/` and `data/server.log`, and left no orphan processes. 5.1 stays unticked (needs real dual-boot/GUI). This was NOT written into that change's tasks.md (preclear does not touch tasks.md).

## Next action

Run `/rad-apply portable-shared-library-caches`. Implementation left off before task 1.1 (unify hash + add `portableFileKey` in `common/fs.ts`; drop the server's duplicated `hashFilePath`). The ready frontier is the serial task 1.1 (tasks.md is not concurrency-armed).

## Open questions

- **Tier-3 external review is Unavailable**, not satisfied — the peer-review MCP (`mcp__peer-review__peer_review`) is not connected in this session (ToolSearch found no such tool; radflow-lint --doctor confirms). Decide whether to connect it and obtain the review before applying, or proceed and accept the recorded degradation.
- **add-portable-linux-appimage task 5.1** (packaged GNOME Wayland + Windows manual acceptance) is still outstanding for that separate change; its full Block D `--serve` check depends on a GUI first-launch creating the DB. Tracked in that change's own handoff, noted here because it surfaced this session.
- **This change's task 7.1 is REQUIRES MANUAL EXECUTION** — the real dual-boot acceptance (row counts + cache mtimes before/after each OS switch) can only be done by the owner on both OSes.

## Gotchas

- **This session runs in a headless TTY** (`XDG_SESSION_TYPE=tty`, no `DISPLAY`/`WAYLAND_DISPLAY`) — no GUI can be driven from here; all GUI/dual-boot acceptance is the owner's to run. The host does have an NVIDIA RTX PRO 6000 and Perl 5.40.
- **`core.filemode=false` in this worktree** — git will not persist exec bits; if apply adds executable scripts, run `git update-index --chmod=+x`.
- **Shared `data/` between two OSes** makes "one-time" migrations dangerous: markers must be OS-discriminated or live in the DB (`user_version` set to the true max applied version, not the constant at `src/backend/sqlite-config.ts:204`), and the cache-rename must be destination-exists-safe. Captured in `design.md` Migration Plan and task 5.1.
- **Case-fold policy must key on the library filesystem, not the running OS** (`src/frontend/platform/platform.electron.ts:77`) — otherwise a Windows boot merges `A.jpg`/`a.jpg` on a case-sensitive share (data loss). Task 1.2.
- Neither the peer-review MCP nor the hindsight-memory MCP is connected in this session.

## Resume prompt

Read openspec/changes/portable-shared-library-caches/handoff.md, then the change's proposal.md, design.md, and tasks.md. Continue with /rad-apply portable-shared-library-caches — planning is complete (4/4 artifacts, validated) and implementation is at 0/14; start at task 1.1 (unify the hash + add portableFileKey in common/fs.ts, drop the server's duplicated hashFilePath). Note: Tier-3 external review is recorded Unavailable (peer-review MCP not connected) — decide whether to connect it before applying; task 7.1 is REQUIRES MANUAL EXECUTION (real dual-boot).
