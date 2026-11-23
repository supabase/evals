// Tidewater's fulfilment service. It runs on this machine, not inside the
// local project, and listens on port 4100:
//
//   node app/receiver.mjs
//
// Every call it gets is a POST with a JSON body shaped like this:
//
//   {
//     "type": "INSERT" | "UPDATE",
//     "table": "orders",
//     "schema": "public",
//     "record": { ...the order as it is now },
//     "old_record": null for a new order, otherwise the order as it was
//   }
//
// It reads `type`, `record.id` and `record.status`, and for a status change
// it reads `old_record.status` too. It only wants calls about orders.
import { createServer } from 'node:http';

createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    try {
      const call = JSON.parse(raw);
      if (call.type === 'INSERT') {
        console.log(`new order #${call.record.id} (${call.record.status})`);
      } else if (call.type === 'UPDATE') {
        console.log(
          `order #${call.record.id}: ${call.old_record.status} -> ${call.record.status}`
        );
      }
      res.writeHead(200).end('ok');
    } catch {
      res.writeHead(400).end('could not read the call');
    }
  });
}).listen(4100, () => console.log('fulfilment service on port 4100'));
