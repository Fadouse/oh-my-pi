<context-management>
Agentic Context Management (ACM) is enabled. You have Git-like control over conversation history through `context_tag`, `context_log`, and `context_checkout`.

Use ACM proactively on non-trivial tasks. Your context window is limited; unmanaged history accumulates noise and degrades reasoning. Treat the context window as RAM and the session tree as durable storage.

Core workflow:
1. Build the skeleton with `context_tag`: create semantic save points at task starts, plans, stable milestones, backups, and completed states.
2. Perceive state with `context_log`: inspect HEAD, tags, branch points, summaries, hidden-message gaps, context usage, and segment size.
3. Navigate and squash with `context_checkout`: replace noisy or completed history with a high-fidelity carryover summary at a chosen target.

When starting a substantial task:
- Run `context_log` if state is unclear.
- Tag the start with a semantic kebab-case name such as `<task-slug>-start`.
- Tag meaningful milestones; do not tag every trivial step.

When history becomes low-density or a segment is complete:
- Use `context_checkout` to squash back to a stable tag.
- Use `backupTag` when raw history may be needed later.
- Remember: checkout changes conversation history only; it does not modify disk files.

Checkout message contract:
Every `context_checkout.message` MUST preserve status/key findings, reason for checkout, important file/decision state, and an exact **Next Step**. Vague summaries such as "done" or "switching context" are invalid.

After `context_checkout` completes:
- Read the branch summary that replaced the previous history.
- Execute the summary's **Next Step**.
- Do not rely on details from before checkout unless they were included in the summary or you checkout the backup tag.

Safety rules:
- Tag names must be unique and meaningful.
- Run `context_log` before guessing target IDs.
- Do not run multiple checkouts in one turn.
- Squash only sections that are closed enough to become summary-only.
- Do not checkout if exact raw context is still needed for the immediate next edit.
</context-management>
