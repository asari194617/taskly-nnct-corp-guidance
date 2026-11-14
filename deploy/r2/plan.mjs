import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'parse5';
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg' };
export function metadata(key) {
  const extension = key.slice(key.lastIndexOf('.'));
  if (!(extension in types) || /(^|\/)(data|private|\.env)(\/|\.|$)/i.test(key)) throw new Error(`Disallowed deployment asset: ${key}`);
  return {ContentType:types[extension], CacheControl:key.startsWith('_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache'};
}
export async function files(root, directory=root) {
  const output=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name);
    if(entry.isSymbolicLink()) throw new Error('Deployment symlinks are forbidden');
    if(entry.isDirectory()) output.push(...await files(root,path));
    else if(entry.isFile()) { const key=relative(root,path).replaceAll('\\','/'); metadata(key); output.push(key); }
  }
  return output.sort((a,b)=>Number(a.endsWith('.html'))-Number(b.endsWith('.html')) || a.localeCompare(b));
}
export function secureHTML(html, apiOrigin, documentOrigin) {
  const api=new URL(apiOrigin);
  if(api.protocol!=='https:' || api.pathname!=='/' || api.search || api.hash) throw new Error('HTTPS API origin required');
  let documentSource='';
  if(documentOrigin) {
    const documentURL=new URL(documentOrigin);
    if(documentURL.protocol!=='https:' || documentURL.pathname!=='/' || documentURL.search || documentURL.hash || documentURL.username || documentURL.password) throw new Error('HTTPS document origin required');
    documentSource=` ${documentURL.origin}`;
  }
  const hashes=[];
  function visit(node) {
    if(node.tagName==='script' && !node.attrs.some(attribute=>attribute.name==='src')) {
      // CSP hashes the browser-parsed child text, including its HTML newline
      // normalization. Parsing only discovers scripts; never serialize the HTML.
      const body=node.childNodes.filter(child=>child.nodeName==='#text').map(child=>child.value).join('');
      if(body.length) hashes.push(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
    }
    for(const child of node.childNodes ?? []) visit(child);
  }
  visit(parse(html,{scriptingEnabled:true}));
  const policy=`default-src 'none'; script-src 'self' ${[...new Set(hashes)].join(' ')}; style-src 'self' 'unsafe-inline'; connect-src ${api.origin}; img-src 'self' https://cdn.taskly.iy0306.com ${api.origin}${documentSource}; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self' ${api.origin}`;
  return html.replace(/<head>/i,`<head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`);
}
export async function prepare(root,apiOrigin,documentOrigin) {
  const keys=await files(root);
  if(!keys.includes('index.html')) throw new Error('Static index.html missing');
  for(const key of keys.filter(k=>k.endsWith('.html'))) {
    const path=join(root,key);
    const html=await readFile(path,'utf8');
    if(!html.includes('http-equiv="Content-Security-Policy"')) await writeFile(path,secureHTML(html,apiOrigin,documentOrigin));
  }
  return keys;
}
