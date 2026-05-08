# Agentic Context Management

Agentic Context Management (ACM) is a built-in `packages/coding-agent` extension that gives the agent Git-like control over its own conversation history.

Enable it in `/settings → Context → Agentic Context Management`. The setting key is `contextManagement.enabled`; it is off by default and takes effect on the next session (or after `/reload-plugins`).

When enabled, omp registers four tools:

- `context_tag`: bookmark an existing session-tree entry with a unique semantic label.
- `context_log`: render a compact history view with HEAD, user messages, tags, branch points, summaries, hidden-message gaps, context health, and open todos.
- `context_status`: return the same ACM health snapshot as compact JSON for agent decisions.
- `context_checkout`: create a branch summary at a target entry and navigate to that summary after the current agent turn ends.
The extension does not expose a `context-management` skill. Instead, when ACM is enabled it appends ACM operating guidance directly to the model system prompt before each agent turn, similar to dynamic-context-pruning style plugins.


## Health and nudges

ACM computes a per-turn health snapshot from context usage, distance from the nearest tag, recent tool-result density, consecutive tool errors, user-message distance, and the latest `todo_write` phases. The snapshot recommends one of `ok`, `tag`, `squash`, or `recover`.

`context_log` shows the health dashboard for humans and the agent. `context_status` exposes the same data as JSON. When `contextManagement.nudges` is enabled, ACM can inject a hidden one-turn reminder only when thresholds degrade and the cooldown has elapsed; nudges do not modify the cache-stable ACM system prompt.

## How checkout works

`context_checkout` is deferred for agent-state safety:

1. The tool resolves the requested target (`root`, a hex entry ID, or a tag name).
2. It optionally tags the current leaf with `backupTag`.
3. It writes a `branch_summary` entry at the target using the provided carryover message.
4. At `turn_end`, the extension aborts the current turn.
5. At `agent_end`, it calls `navigateTree(summaryEntryId, { summarize: false })` so the agent message list and UI are rebuilt from the new leaf.
6. It injects a hidden follow-up prompt telling the agent to read the new summary and execute its **Next Step**.


`context_checkout.message` is schema-validated by default (`contextManagement.checkout.strictSchema`). Strict mode requires `Reason`, `Next Step`, and either `Important Changes` or `Files Touched`. Failure returns a reusable template and does not create a backup tag, branch summary, or pending checkout.

Checkout supports three modes:

- `squash` (default): existing summary-and-navigate behavior.
- `jump`: relaxed schema for exploratory movement, but still requires `Next Step`.
- `recover`: target must be a known tag; ACM navigates to that tag without writing a summary.

Checkout changes conversation history only. It does not modify working-tree files.


## Settings

- `contextManagement.enabled`: register ACM tools and guidance.
- `contextManagement.nudges`: inject hidden health nudges when thresholds degrade.
- `contextManagement.checkout.strictSchema`: enforce the checkout carryover schema.
- `contextManagement.todoCoupling`: snapshot open todos into checkout summary details and surface them in the dashboard.

## Relationship to existing session commands

ACM complements, rather than replaces, existing human-driven commands:

- `/tree` shows the user the underlying session graph. `context_log` gives the agent a compact operational view.
- `/branch` and `/fork` are user-initiated ways to move or split session history. `context_checkout` is the agent-initiated way to squash and continue.
- `/compact` summarizes context under user/session policy. `context_checkout` creates an explicit branch summary at a chosen graph target.
- `/checkpoint` and `rewind` are transient tool-session controls used for investigate-then-resume flows. ACM operates on the main conversation tree.

For the tree-and-leaf model that backs these operations, see [session.md](./session.md).
