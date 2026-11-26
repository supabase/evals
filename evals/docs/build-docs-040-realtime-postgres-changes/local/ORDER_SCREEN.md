# Order screen

Version 4.2 of the Leafline app is in both app stores. Once a customer signs in, its order screen calls
`watchMyOrders` in `app/order-updates.ts`. That code ships inside the app, so it stays as it is until the next
release.

The order screen should:

- show a new order as soon as the shop creates it,
- show each status change with the status before and after, for example "was packed, now shipped",
- drop an order from the list as soon as the shop deletes it.

Shop staff create, update and delete orders from the back office, which connects with the server key. The app
has always loaded orders through our backend, never straight from the database.

Customers see their own orders and nobody else's. People who have not signed in see no orders at all.

The open or closed banner at the top of every screen already updates by itself, for visitors and customers.
