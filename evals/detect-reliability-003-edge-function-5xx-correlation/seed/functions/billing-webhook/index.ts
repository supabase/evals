import { handleBillingWebhook } from "npm:@acme/billing";

Deno.serve((req) => handleBillingWebhook(req));
