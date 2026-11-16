# Apps 002: agents beside an app

**Why:** an app should be able to offer a conversation as well as its views: a visitor opens
the app's agent page, says what they want in plain language, and the agent answers from the
app's data and changes it only through the app's own mutations. The point is that an agent
and the app's views are two interfaces over the same typed operations. Joe filed it under
features on 2026-11-16, when it was rewritten from the 2026-09 plan (overstoryd running a
model beside compiled TypeScript handles; that text is in git history).

**Order:** after [Agents 005](agents-005-webhook-runners.md) (webhook runners) and
[Apps 015](../soon/apps-015-the-view-language.md)'s host evaluator. Visitors other than the
app's own people also need [Apps 010](../later/apps-010-activation-and-lending.md).

## Status

**SKETCH · M effort · medium risk.** Direction agreed with Joe on 2026-11-16; the open
questions below come first.

## The shape

- **An agent is a page.** Its body is the instruction; its front matter names the Beetle
  views it may read for context and the mutations it may call as tools, plus where
  transcripts go:

  ```markdown
  ---
  context: [views/practices.beetle#findPractices, views/list.beetle#List]
  tools: [mutations.beetle#createList, mutations.beetle#addPractice]
  transcripts: ./conversations
  ---
  Help a person find practices that fit what they are trying to do. Explain your
  suggestions, and create or update a list only when they ask you to.
  ```

- **A runner runs it, not overstoryd.** Code never runs in the host, and Story's agents run
  through Claude Code or Codex on a runner without an API token
  ([Agents 002](../../status.md#agents-002-run-tasks-from-anywhere--2026-11-07)). A
  conversation turn is a request to the app owner's runner (present or webhook), which runs
  the model with the page's instruction and gets the declared views and mutations as its
  only tools.
- **Tools are the app's mutations, called as the visitor.** Each tool call goes through the
  ordinary mutate route as the visitor, with the visitor's authority (and the app's, once
  Apps 010 lends it), so the agent can do nothing the visitor couldn't do in the app's
  views. Context reads go through the views route the same way. No SQL, arbitrary tree
  writes, source edits or administration.
- **The answer is commentary; the data is the record.** Mutation receipts are the
  authority. A name, email address or handle the visitor types is never proof of identity.
- **Transcripts are ordinary rows** written at the declared destination by a mutation:
  messages, tool calls with their safe inputs and results, mutation IDs and receipts, and
  how the turn ended. Never provider reasoning, credentials or rows a view didn't disclose.
  A public agent page doesn't make a visitor's conversations public: the destination must be
  private per visitor or owned by the app before the first turn.
- **Story draws it.** Opening an agent page shows a conversation surface Story provides
  (apps don't ship their own chat UI): what the agent can help with and which mutations it
  may call, tool progress at the level of "searched practices" or "created a list", and links
  to the rows a mutation touched. Cancelling stops further work but can't undo a committed
  mutation, and Story says so.
- **First slice: Supplies.** An agent that asks what the visitor is trying to do, searches
  practices and lists they can read, explains a few suggestions with links, and creates a
  private list and adds practices to it only when asked.

## Open questions

- **Whose model.** The runner is the app owner's device, so a visitor's conversation spends
  the owner's subscription. Is that acceptable (with limits per visitor), or does a visitor
  bring their own runner, so the agent runs on the visitor's account against the app's
  tools?
- **Where a turn's stream goes.** Presence messages, as Agents 004's talk-to-the-agent uses,
  or a stream of its own.
- **Effects outside Overstory** (email, calendar, payments) wait for a concrete effect
  contract; [Apps 017](../later/apps-017-data-runners.md)'s runners are where they would go.
