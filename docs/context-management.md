# Agentic Context Management

Agentic Context Management (ACM) is a built-in `packages/coding-agent` extension that gives the agent Git-like control over its own conversation history.

Enable it in `/settings → Context → Agentic Context Management`. The setting key is `contextManagement.enabled`; it is off by default and takes effect on the next session (or after `/reload-plugins`).

When enabled, omp registers three tools:

- `context_tag`: bookmark an existing session-tree entry with a unique semantic label.
- `context_log`: render a compact history view with HEAD, user messages, tags, branch points, summaries, hidden-message gaps, and a context HUD.
- `context_checkout`: create a branch summary at a target entry and navigate to that summary after the current agent turn ends.

The extension does not expose a `context-management` skill. Instead, when ACM is enabled it appends ACM operating guidance directly to the model system prompt before each agent turn, similar to dynamic-context-pruning style plugins.

## How checkout works

`context_checkout` is deferred for agent-state safety:

1. The tool resolves the requested target (`root`, a hex entry ID, or a tag name).
2. It optionally tags the current leaf with `backupTag`.
3. It writes a `branch_summary` entry at the target using the provided carryover message.
4. At `turn_end`, the extension aborts the current turn.
5. At `agent_end`, it calls `navigateTree(summaryEntryId, { summarize: false })` so the agent message list and UI are rebuilt from the new leaf.
6. It injects a hidden follow-up prompt telling the agent to read the new summary and execute its **Next Step**.

Checkout changes conversation history only. It does not modify working-tree files.

## Relationship to existing session commands

ACM complements, rather than replaces, existing human-driven commands:

- `/tree` shows the user the underlying session graph. `context_log` gives the agent a compact operational view.
- `/branch` and `/fork` are user-initiated ways to move or split session history. `context_checkout` is the agent-initiated way to squash and continue.
- `/compact` summarizes context under user/session policy. `context_checkout` creates an explicit branch summary at a chosen graph target.
- `/checkpoint` and `rewind` are transient tool-session controls used for investigate-then-resume flows. ACM operates on the main conversation tree.

For the tree-and-leaf model that backs these operations, see [session.md](./session.md).
