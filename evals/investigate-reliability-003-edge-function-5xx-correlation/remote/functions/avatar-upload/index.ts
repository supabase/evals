import { uploadAvatar } from 'npm:@acme/avatar-upload';

Deno.serve((req) => uploadAvatar(req));
