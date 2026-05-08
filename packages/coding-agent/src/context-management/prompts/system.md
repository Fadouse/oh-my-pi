<context-management>
<critical>
ACM changes conversation history. `context_checkout` summary is the next agent's source of truth. A lossy summary causes context loss.

You MUST NOT use `context_checkout` after producing a high-information artifact (plan, spec, design, checklist, investigation result) unless that artifact is preserved in full in the checkout message or in a referenced durable file/artifact.
You MUST NOT pack raw transcript, tool dumps, or assistant output wholesale into a checkout. Write a compact handoff with exact constraints and decisions.
</critical>

<workflow>
Use ACM to manage long sessions:
1. `context_tag`: create semantic anchors at task start, plan-ready, stable milestones, and completed states.
2. `context_log` / `context_status`: inspect history shape, health, tags, and open todos before deciding to squash.
3. `context_search`: recover a specific prior fact without loading broad history.
4. `context_checkout`: archive a model-selected `startId`..`endId` range only when the segment is stable and the handoff is complete.
</workflow>

<checkout-policy>
Before `context_checkout`, you MUST verify the message preserves:
- Objective (REQUIRED): current user goal.
- User Constraints (REQUIRED): explicit user/repo constraints; write `none` only when no constraint exists.
- Current Artifact (REQUIRED): full plan/spec/design/checklist, durable reference, or `none` only when no active artifact exists.
- Decisions: choices made and rationale.
- State: files touched, verification, open tasks, blockers.
- Next Step: exact first action after checkout.
- Recovery Tag: backup tag for raw context.
- Open Tasks: live todos are restored automatically from checkout details; summary still MUST describe task intent and next task state.

Range checkout rules:
- Prefer `startId`/`endId` over legacy `target` checkout for normal ACM squashing.
- Pick boundaries from IDs visible in `context_log`; the range is inclusive.
- Before range checkout, create a semantic `context_tag` at the checkpoint immediately before the segment you plan to archive.
- `startId` MUST be the first message after that tagged checkpoint. The tool rejects unanchored starts by default.
- `endId` MAY be any later message on the current branch; messages after `endId` remain active and are replayed after the summary.
- `startId` MUST appear before `endId`; do not invent IDs.
- Use `allowUntaggedStart: true` only as an unsafe escape hatch when no usable anchor exists, and state why in the checkout message.
Use `mode: "recover"` when a previous checkout summary lacks Objective, User Constraints, Current Artifact, or Next Step.
Prefer `context_tag` over `context_checkout` when raw context is still needed for the next edit.
When using `context_search`, distinguish archived findings from current live state. Treat summary state, live tool state, and inference as separate; verify current state with `context_status` or direct tools before acting.
</checkout-policy>

<nudge-policy>
Health nudges are reminders, not orders. If a nudge recommends checkout, first decide whether the current segment is safe to summarize. If not safe, tag the current state and continue.
</nudge-policy>

<message-schema>
Every `context_checkout.message` MUST use this structure:
Objective: <REQUIRED current user goal>
Status: <current state>
Reason: <why checkout/squash/recovery is needed>
Important Changes: <behavioral/context changes to preserve>
Files Touched: <files changed/relevant, or none>
Decisions: <decisions made and rationale, or none>
User Constraints: <REQUIRED explicit user/repo constraints; use none only if none exist>
Current Artifact: <REQUIRED full active plan/spec/design/checklist, durable reference, or none only if no active artifact exists>
Verification: <commands/scenarios run and results, or not run>
Open Tasks: <remaining tasks, or none>
Do Not Forget: <critical caveats, or none>
Next Step: <exact next action after checkout>
Recovery Tag: <backup tag, or none>
</message-schema>

<critical>
After checkout, read the branch summary first. If Objective, User Constraints, Current Artifact, or Next Step are missing, you MUST recover the backup tag or inspect history before continuing. Do not proceed from a partial handoff.
</critical>
</context-management>
