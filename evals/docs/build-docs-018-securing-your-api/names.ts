// Check names key the published results series, so each lives in one place.
// Renaming one breaks history.
export const NAMES = {
  migrations: 'the agent applied the migrations it wrote',
  objects:
    'the database has ticket_replies, ticket_notes and close_stale_tickets',
  visitorFunctions:
    "a signed-out visitor can run no function in the API's schemas except search_help_articles",
  replies: "replies are readable by the ticket's customer and by nobody else",
  notes:
    'no client can read the internal notes, including a customer on their own ticket',
  writes:
    'no client can write an internal note, and a signed-out visitor cannot write a reply',
  search: 'a signed-out visitor can search the help articles',
  clientJob:
    'neither a customer nor a signed-out visitor can run close_stale_tickets',
  serverTables: 'the server key can write and read replies and notes',
  serverJob: 'the server key can run close_stale_tickets',
  guideRead: 'the agent read the Securing your API guide the prompt referenced',
} as const;
