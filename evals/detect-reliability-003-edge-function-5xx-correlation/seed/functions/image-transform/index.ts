import { transformImage } from "npm:@acme/image-transform";

Deno.serve((req) => transformImage(req));
