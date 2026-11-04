// Restock alert worker, run inside our Node backend worker:
//
//   node restock.mjs
//
// Connection settings come from the environment: SUPABASE_URL and
// SUPABASE_SECRET_KEY (this is trusted backend code).
//
// Print to stdout a JSON array with one entry per warehouse/product
// combination that's below its reorder threshold, sorted by warehouse name
// then product name:
//
//   {
//     "warehouse": string,        // warehouse name
//     "product": string,          // product name
//     "quantity": number,         // current quantity on hand
//     "reorderThreshold": number, // reorder threshold for this product
//     "supplierEmail": string     // email of the product's supplier
//   }
//
// Only include rows where quantity is strictly below the reorder threshold.
//
// TODO: implement
console.error('not implemented');
process.exit(1);
