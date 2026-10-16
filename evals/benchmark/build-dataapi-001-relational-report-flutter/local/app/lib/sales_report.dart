// Data layer for the sales dashboard. The UI in main.dart calls these three
// functions; everything that talks to the backend lives here.
//
// connect() runs once at startup with the project URL and publishable key,
// which the app is built with:
//
//   flutter run --dart-define=SUPABASE_URL=... --dart-define=SUPABASE_PUBLISHABLE_KEY=...
//
// signIn() signs a staff member in with their email and password. Every
// account in the project is a staff member; sign-ups are disabled and an
// admin creates the accounts.
//
// loadSalesReport() returns, for the signed-in staff member, one entry per
// customer who has placed at least one order, sorted by customer name:
//
//   {
//     "customer": String,    // customer name
//     "orderCount": int,     // how many orders they placed
//     "totalCents": int,     // total spent across all their orders
//     "topProduct": String   // product they bought the most units of
//   }
//
// If two products tie on units, topProduct is the alphabetically first one.

Future<void> connect({required String url, required String publishableKey}) {
  // TODO: implement
  throw UnimplementedError();
}

Future<void> signIn({required String email, required String password}) {
  // TODO: implement
  throw UnimplementedError();
}

Future<List<Map<String, Object>>> loadSalesReport() {
  // TODO: implement
  throw UnimplementedError();
}
