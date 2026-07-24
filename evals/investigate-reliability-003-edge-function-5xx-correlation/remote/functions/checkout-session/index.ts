import { createCheckoutSession } from 'npm:@acme/checkout';

Deno.serve((req) => createCheckoutSession(req));
