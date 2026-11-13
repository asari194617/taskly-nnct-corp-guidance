import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,writeFile,rm,mkdir,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {metadata,files,secureHTML,prepare} from './plan.mjs';
test('private documents and unknown types cannot be uploaded',()=> {
  for(const key of ['private/source.png','data/example.txt','handbook.pdf','.env.txt','source.map','data.json']) assert.throws(()=>metadata(key));
  assert.equal(metadata('_next/static/a.js').CacheControl,'public, max-age=31536000, immutable');
  assert.equal(metadata('index.html').CacheControl,'no-cache');
});
test('CSP hashes bootstrap bytes and permits only trusted signed document image origins',()=> {
  const script='self.__next_f.push([1,"synthetic"]);';
  const html=secureHTML(`<html><head><script>${script}</script><script src="/app.js"></script></head></html>`,'https://api.example.test');
  assert.ok(html.includes(`sha256-${createHash('sha256').update(script).digest('base64')}`));
  assert.ok(html.includes('connect-src https://api.example.test'));
  assert.ok(html.includes("img-src 'self' https://cdn.taskly.iy0306.com https://api.example.test"));
  assert.ok(html.includes("frame-src 'none'"));
  assert.ok(html.includes("object-src 'none'"));
  assert.ok(!html.includes('blob:'));
  assert.throws(()=>secureHTML('<head>','http://api.example.test'));
  assert.throws(()=>secureHTML('<head>','https://api.example.test/path'));
});
test('assets precede HTML; index required; symlinks rejected',async()=> {
  const root=await mkdtemp(join(tmpdir(),'nnct-r2-test-'));
  try {
    await assert.rejects(prepare(root,'https://api.example.test'));
    await writeFile(join(root,'index.html'),'<html><head></head></html>');
    await mkdir(join(root,'_next')); await writeFile(join(root,'_next','a.js'),'');
    assert.deepEqual(await files(root),['_next/a.js','index.html']);
    await prepare(root,'https://api.example.test');
    await symlink(join(root,'index.html'),join(root,'link.html'));
    await assert.rejects(files(root));
  } finally { await rm(root,{recursive:true,force:true}); }
});
