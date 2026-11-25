import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createBackupClient } from './storage.js';

const BUCKET = 'notes';

export async function backUpEverything(targetDir) {
  const client = await createBackupClient();
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token })
    );
    for (const object of page.Contents ?? []) {
      const { Body } = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: object.Key })
      );
      const path = join(targetDir, object.Key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await Body.transformToByteArray());
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}
