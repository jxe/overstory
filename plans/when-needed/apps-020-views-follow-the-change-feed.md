# Apps 020: Beetle views rerun only for changes they read

**Why and when:** left from [Apps 015](../../status.md#apps-015-beetle-views-and-mutations-on-the-host--2026-11-16)
when it closed on 2026-11-16. When needed: when a tree's open views measurably rerun too often
(the host's view streams spend noticeable CPU, or views lag behind edits they don't read).

## Status

**PLANNED · not started · S effort · low risk.** Host only.

## The change

Today an open Beetle view reruns on every accepted update to its tree, or to a profile it
drew (`beetle-host.ts`, `liveViewStream`). Make view streams a consumer of the change feed
(`packages/overstoryd/src/change-feed.ts`) with their own cursor, and rerun a view only when a
record touches what its plan reads: the collection folders a record names
(`ChangeRecord.collections`), the page a view reads as `page`, and the files its code version
covers. Missing precision still reruns (reading and watching §4.2); results never change.
Measure reruns per edit before and after on a tree with several open views.
