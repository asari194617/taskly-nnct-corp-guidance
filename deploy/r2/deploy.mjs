import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PutObjectCommand,S3Client } from '@aws-sdk/client-s3';
import { prepare,metadata } from './plan.mjs';
const required=['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET','NEXT_PUBLIC_API_URL'];
for(const key of required) if(!process.env[key]) throw new Error(`${key} required`);
if(!/^[a-f0-9]{32}$/i.test(process.env.R2_ACCOUNT_ID)) throw new Error('Invalid R2 account identifier');
const root=resolve(process.argv[2] ?? 'apps/web/out');
const keys=await prepare(root,process.env.NEXT_PUBLIC_API_URL,`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
const client=new S3Client({region:'auto',endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}});
for(const key of keys) {
  await client.send(new PutObjectCommand({Bucket:process.env.R2_BUCKET,Key:key,Body:await readFile(resolve(root,key)),...metadata(key)}));
  console.log(`Uploaded ${key}`);
}
// Keep prior immutable assets for browsers that still have the previous HTML open.
console.log(`Deployed ${keys.length} static UI assets. No application data was uploaded.`);
