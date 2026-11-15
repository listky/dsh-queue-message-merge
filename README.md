# DSH Queue Message Merge

[简体中文](./README.zh-CN.md)

A small DSH plugin for merging ordinary queued text messages in the **current session**. It adds a compact icon button beside the chat composer. The merge keeps the result queued; it never submits or sends a message.

## Intended workflow

This plugin was originally created to complement [`dsbot-session-create`](https://github.com/Gaudi-XIX/dsbot-session-create). When several derived sessions return results or receipt messages around the same time, and those messages are already queued in the current session, you can merge them into one queued message and then forward it to the main session through your usual workflow. This makes it easier for the main session to review and handle the results together instead of one by one.

This is a companion use case, not an automatic integration: the plugin does not create or manage derived sessions, collect messages across sessions, route messages to the main session, or send anything. It only merges eligible ordinary text already queued in the current session; you decide when and where to send it.

## Features

- Merges the current session's ordinary `inbox['next-turn']` queue in its existing order.
- Joins each message's text blocks verbatim and separates messages with an English semicolon (`;`).
- Edits the first queued message and removes the remaining queued messages by stable ID. On success, exactly one combined message remains queued.
- Leaves steering (`next-step`) and context items untouched.
- Shows a compact, accessible icon button. Its tooltip reports the queued-message count or why merging is unavailable; visible Toasts report success, failure, or recovery instructions. During recovery protection, activating the button only opens recovery guidance and cannot start a merge.

## Install

This repository is a local DSH bundle and is not currently listed in a DSH plugin market.

1. Clone or download this repository.

   ```sh
   git clone https://github.com/listky/dsh-queue-message-merge.git
   ```

2. In DSH, open **Plugins → Add plugin** and select the cloned folder that contains `package.json`.
3. Confirm that the bundle is enabled. When replacing an already-loaded installation, restart DSH so it loads the new Client module.

The declared compatibility range is DSH `>=0.2.2-rc.1 <0.3.0`; the plugin was verified on DSH `0.2.2-rc.1`.

## Use

1. Open the session whose queue you want to combine.
2. Queue at least two ordinary, nonblank, plain-text messages as usual.
3. Hover the merge icon to see the message count, then click it. The merge action is disabled when the queue is ineligible. During recovery protection, clicking only opens recovery guidance; it does not start a merge.
4. On success, a Toast confirms the merge. The combined message remains queued; use DSH's normal send control when you are ready to submit it.

The entire ordinary queue must be eligible. The plugin fails closed rather than skipping an item if the inbox projection is unavailable or invalid, or if a queued message has a missing or duplicate ID, blank text, an attachment, or a non-text content block.

## Safety and recovery

Queue updates use DSH's session API. The plugin does not call `prompt` or `send`, and it makes no direct third-party network requests. DSH may restore a cold session while applying a queue edit; that does not submit the queued messages.

The Host API currently exposes separate single-item queue updates, not an atomic batch, compare-and-swap, or queue lock. The plugin rechecks the projected queue between updates, but another window or actor can still change it between a check and a request. Treat merging as best-effort, not as a concurrency-safe transaction.

Before its first update, the plugin writes a session-scoped recovery flag to the DSH Client store. The flag stores only a boolean, never message text. Confirmed success or an explicit rejection of the first edit clears it. If a request has an uncertain outcome, projection confirmation times out, or a later removal fails, the flag remains set to prevent blind retries.

If recovery is required, inspect the current queue and manually resolve any partial merge before unlocking. The recovery Toast offers an **I checked; unlock** action; use it only after review. Clearing the flag does not repair queue contents. The flag is persisted through browser storage when available; if storage is unavailable, it may not survive an application restart.

## Development and tests

Requires Node.js with ES modules and the built-in test runner.

```sh
npm run build
npm test
npm pack --dry-run
```

Edit `client.source.mjs`, then run `npm run build` to regenerate `client.js`. The `prepack` script builds automatically when packaging. The test suite uses fake sessions and projections to cover ordering, eligibility, recovery locking, uncertain outcomes, and retry blocking; it also checks ModuleLoader dependency resolution and Toast wiring. These unit tests are not end-to-end tests of DSH Host behavior or real concurrent queue changes.

## License

MIT. See [LICENSE](./LICENSE).
