# build-docs-003-api-keys-guide-find

Findability variant of `build-docs-003-api-keys-guide`. Same local starter, same scorer, same task. The only change is in `PROMPT.md`: the REFERENCE URL is removed and the agent is told to find the right guide in the Supabase docs itself.

Two numbers come out of running this next to the sibling:

- **IA tax**: pass rate of `build-docs-003-api-keys-guide` minus pass rate of this eval. How much task completion is lost when the agent has to find the page.
- **Reach rate**: share of runs where the `checkGuideWasRead` check passes. Whether the agent found the page at all.

Keep this file in sync with the sibling. If the sibling's checks change, copy them here.
