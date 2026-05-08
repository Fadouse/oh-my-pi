# Agentic Context Management

Agentic Context Management (ACM) is a built-in `packages/coding-agent` extension that lets the agent manage its own conversation history with Git-like operations: tag stable points, inspect health, search prior context, and checkout a compact branch summary when the active context gets noisy.

Enable it in `/settings → Context → Agentic Context Management`. The setting key is `contextManagement.enabled`; it is off by default and takes effect on the next session, or after `/reload-plugins`.

## Tools

When enabled, omp registers five ACM tools:

| Tool | Purpose |
| --- | --- |
| `context_tag` | Bookmark an existing session-tree entry with a unique semantic label. |
| `context_log` | Render a compact history view with HEAD, user messages, tags, branch points, summaries, hidden-message gaps, context health, and open todos. |
| `context_search` | Search current-session ACM history for a specific fact without loading broad logs. |
| `context_status` | Return the ACM health snapshot as compact JSON for agent decisions. |
| `context_checkout` | Create or restore a branch-summary checkpoint and navigate to it after the current agent turn ends. |

ACM does not expose a `context-management` skill. When enabled, it appends operating guidance directly to the model system prompt before each agent turn, similar to dynamic-context-pruning plugins.

## Health and nudges

ACM computes a per-turn health snapshot from:

- context usage
- distance from the nearest tag
- recent tool-result density
- consecutive tool errors
- user-message distance
- latest `todo_write` phases

The health recommendation is one of `ok`, `tag`, `squash`, or `recover`.

`context_log` shows the dashboard for humans and the agent. `context_status` exposes the same data as JSON. When `contextManagement.nudges` is enabled, ACM may inject a hidden one-turn reminder only when thresholds degrade and the cooldown has elapsed. Nudges do not modify the cache-stable ACM system prompt.

## Checkout modes

`context_checkout` supports three modes:

| Mode | Behavior |
| --- | --- |
| `squash` | Default. Write a validated branch summary and navigate to it after the current turn. |
| `jump` | Exploratory movement with relaxed schema; still requires `Next Step`. |
| `recover` | Navigate to a known tag without writing a new summary. |

Checkout changes conversation history only. It does not modify working-tree files.

## Range checkout

For range checkout, the model supplies `startId` and `endId` from visible history IDs. By default, `startId` must be the first entry after an existing `context_tag` anchor: the entry immediately before `startId` must have a tag. This forces the model to declare a safe checkpoint before selecting the range. The selected inclusive range is replaced in the active message list by one `branch_summary` entry. The original entries remain in the session tree for recovery and UI expansion.

Range checkout may end before current HEAD. Entries after `endId` are replayed after the summary, so useful suffix context is not lost.

If no usable anchor exists, `allowUntaggedStart: true` is an explicit unsafe escape hatch. `mode: "jump"` also permits untagged starts for exploratory movement. Untagged range checkout records `details.range.untaggedStartAllowed` so logs and UI can distinguish it from a checkpoint-anchored squash.

Range checkout stores `details.range` with:

- resolved start/end entry IDs
- original start/end refs
- parent ID
- anchor tag ID/name when the start is anchored
- `untaggedStartAllowed` when the unsafe escape hatch was used
- topic
- selected entry IDs
- suffix entry IDs
- replayed suffix entry IDs

Optional string parameters are normalized before mode selection. Blank `target`, `startId`, `endId`, `topic`, and `backupTag` values are treated as omitted, so UI/tool-call serializers may include empty fields without forcing the wrong checkout mode.

## Deferred checkout lifecycle

`context_checkout` is deferred for agent-state safety:

1. Range mode resolves `startId` and `endId`, or legacy/recover mode resolves `target` (`root`, an entry ID, or a tag name).
2. If provided, ACM tags the current leaf with `backupTag`.
3. ACM writes a `branch_summary` entry before the selected range in range mode, or at the target in legacy mode.
4. At `turn_end`, ACM aborts the current turn.
5. At `agent_end`, ACM calls `navigateTree(summaryEntryId, { summarize: false })` so the agent message list and TUI are rebuilt from the new leaf.
6. ACM injects a hidden follow-up prompt that blocks implementation if required carryover fields are missing.

## Checkout summary schema

`context_checkout.message` is schema-validated by default through `contextManagement.checkout.strictSchema`.

Strict mode requires these sections:

- `Objective`
- `Reason`
- `User Constraints`
- `Current Artifact`
- `Next Step`
- either `Important Changes` or `Files Touched`

`User Constraints` and `Current Artifact` may contain `none` only when there is truly nothing to preserve. If validation fails, ACM returns a reusable template and does not create a backup tag, branch summary, or pending checkout.

Checkout summaries are handoffs, not transcript archives. High-information artifacts such as plans, specs, designs, checklists, and investigation findings must be preserved in `Current Artifact` or referenced from durable files/artifacts before checkout.

## TUI rendering

ACM checkout summaries render in TUI as a dedicated `context checkout` block instead of the generic branch-summary block.

Collapsed view shows:

- checkout mode
- range or target
- selected message count
- backup tag
- objective or topic
- next step

Expanded view shows:

1. the validated checkout summary
2. a top marker for the archived checkout range
3. the original messages from the selected range
4. a bottom marker for the archived checkout range

Original messages are rendered with the same normal chat components used outside checkout where possible: user messages, assistant messages, tool calls/results, bash execution, and eval/python execution. The markers are the only visual indication that the messages are inside a checkout range.

## Todo coupling

If checkout happens while live todos exist, ACM stores them in branch summary details. Todo state is restored from summary details after navigation, so `context_status` continues to reflect live open tasks instead of relying on the model to rewrite them.

`context_log` and `context_status` expose todo provenance through `openTodosSource`, which distinguishes no todos, user edits, branch-summary restoration, and tool-result state.

## Settings

| Setting | Purpose |
| --- | --- |
| `contextManagement.enabled` | Register ACM tools and guidance. |
| `contextManagement.nudges` | Inject hidden health nudges when thresholds degrade. |
| `contextManagement.checkout.strictSchema` | Enforce the checkout carryover schema. |
| `contextManagement.todoCoupling` | Snapshot open todos into checkout summary details and surface them in the dashboard. |

## Relationship to existing session commands

ACM complements, rather than replaces, existing human-driven commands:

- `/tree` shows the user the underlying session graph. `context_log` gives the agent a compact operational view.
- `/branch` and `/fork` are user-initiated ways to move or split session history. `context_checkout` is the agent-initiated way to squash and continue.
- `/compact` summarizes context under user/session policy. `context_checkout` creates an explicit branch summary at a chosen graph target.
- `/checkpoint` and `rewind` are transient tool-session controls used for investigate-then-resume flows. ACM operates on the main conversation tree.

For the tree-and-leaf model that backs these operations, see [session.md](./session.md).
