Find the answer to this question from the retrieved conversation-history excerpts.

Question:
{{query}}

Retrieved excerpts:
{{#each candidates}}
---
Entry: {{id}}
Role: {{role}}
Type: {{type}}
{{#if label}}Tag: {{label}}
{{/if}}Timestamp: {{timestamp}}
Text:
{{text}}
{{/each}}

Return JSON matching the requested schema. If no excerpt answers the question, set `answer` to a concise no-answer statement, `confidence` to `low`, and `citations` to an empty array.
