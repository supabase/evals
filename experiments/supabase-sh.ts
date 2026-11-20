/**
 * Project instructions for supabase.sh, Supabase's docs served over SSH
 * (https://supabase.com/blog/supabase-docs-over-ssh). This is the output of
 * `ssh supabase.sh agents`, the snippet the post tells users to add to
 * AGENTS.md or CLAUDE.md. Experiments pass it as `instructions`, so the agent
 * gets the same setup a user would have while the prompt stays unchanged.
 *
 * Captured 2026-11-20. Re-run `ssh supabase.sh agents` to refresh it.
 */
export const supabaseShInstructions = `## Supabase Docs

Before working on a Supabase feature, check the docs via \`ssh supabase.sh <command>\`.

\`\`\`bash
# Search for a topic
ssh supabase.sh grep -rl 'auth' /supabase/docs/

# Read a specific guide
ssh supabase.sh cat /supabase/docs/guides/auth/passwords.md

# Find all guides in a section
ssh supabase.sh find /supabase/docs/guides/database -name '*.md'

# Search with context
ssh supabase.sh grep -r 'RLS' /supabase/docs/guides/auth --include='*.md' -l
\`\`\`

All docs live under \`/supabase/docs/\` as markdown files. You can use any standard Unix tools (grep, find, cat, etc.) to search and read them.
`;
