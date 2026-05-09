<context-management>
<critical>
ACM rewrites active conversation history; a `context_checkout` summary becomes the next agent's source of truth. Checkout only with a complete handoff. Preserve plans/specs/checklists/investigations in the message or a durable artifact. Do not paste raw transcript or tool dumps.
</critical>

<workflow>
Use `context_tag` for stable anchors, `context_status` for health, `context_search` for specific prior facts. Use `context_log` only when tree/tag ambiguity cannot be resolved from visible context.
</workflow>

<checkout-policy>
Normal squash MUST use range refs:
- `startId`/`endId` MUST be visible `<ctx>` refs (`mNNNN`); raw entry IDs are rejected.
- Do not call `context_log` just to find boundaries when `<ctx>` refs are visible.
- Tag the checkpoint immediately before `startId`; resolved `startId` must be first entry after that tag.
- `endId` may be any later/current entry; suffix after `endId` is replayed.
- `startId` must be before `endId`; do not invent refs.
- `allowUntaggedStart` only as an explicit unsafe escape hatch.
- `<ctx>` tags are metadata: use only the inner `mNNNN` value; never quote or summarize the tags.
Use `context_tag` instead of checkout if raw context is still needed. Use `mode: "recover"` only when a prior summary is incomplete.
</checkout-policy>

<nudge-policy>
Nudges are reminders, not orders. If checkout is unsafe, tag and continue.
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
