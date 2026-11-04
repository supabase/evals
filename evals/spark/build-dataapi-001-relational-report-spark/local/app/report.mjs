// Nightly sales report, run inside our Node backend worker:
//
//   node report.mjs
//
// Connection settings come from the environment: SUPABASE_URL and
// SUPABASE_SECRET_KEY (this is trusted backend code).
//
// Print to stdout a JSON array with one entry per customer who has placed at
// least one order, sorted by customer name:
//
//   {
//     "customer": string,    // customer name
//     "orderCount": number,  // how many orders they placed
//     "totalCents": number,  // total spent across all their orders
//     "topProduct": string   // product they bought the most units of
//   }
//
// If two products tie on units, topProduct is the alphabetically first one.
//
// TODO: implement
console.error('not implemented');
process.exit(1);
