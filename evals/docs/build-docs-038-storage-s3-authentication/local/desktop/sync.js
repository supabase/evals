import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { createStorageClient } from './storage.js';

const BUCKET = 'notes';

export async function signIn(email, password) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PUBLISHABLE_KEY
  );
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data.session;
}

export async function listNotes(session) {
  const client = await createStorageClient(session.access_token);
  const { Contents = [] } = await client.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${session.user.id}/` })
  );
  return Contents.map((object) => object.Key);
}

export async function readNote(session, name) {
  const client = await createStorageClient(session.access_token);
  const { Body } = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: `${session.user.id}/${name}` })
  );
  return Body.transformToString();
}

export async function saveNote(session, name, text) {
  const client = await createStorageClient(session.access_token);
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${session.user.id}/${name}`,
      Body: text,
      ContentType: 'text/markdown',
    })
  );
}
