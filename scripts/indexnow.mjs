#!/usr/bin/env node
/* Tells Bing -- and the other IndexNow engines, Yandex, Seznam and Naver -- about every page in
 * the sitemap, so they crawl the site now instead of whenever they next happen by.
 *
 * Google does not take IndexNow; it reads the sitemap through Search Console.
 *
 * The key file (KEY.txt at the site root, served by nginx) is what proves the submission comes
 * from the site's owner. The script checks that it is live before submitting anything.
 *
 *   node scripts/indexnow.mjs            submit every <loc> in the sitemap
 *   node scripts/indexnow.mjs --dry-run  print what would be sent
 *
 * Run it after a deploy that adds pages or changes what they say. Submitting unchanged pages again
 * does no harm, but it does nothing either.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEY = 'b63bc9282f0e07f343341371e6edd2c6';
export const HOST = 'donutluxe.com';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SITEMAP = path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/sitemap.xml');

/** Every page the sitemap lists, on this host only. */
export function sitemapUrls(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => match[1].trim())
    .filter((url) => new URL(url).host === HOST);
}

export function submission(urls) {
  return { host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls };
}

async function main() {
  const body = submission(sitemapUrls(readFileSync(SITEMAP, 'utf8')));
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const keyFile = await fetch(body.keyLocation);
  const served = keyFile.ok ? (await keyFile.text()).trim() : '';
  if (served !== KEY) {
    throw new Error(`${body.keyLocation} answered ${keyFile.status} without the key: deploy it first`);
  }
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  // 200 and 202 both mean accepted; 202 is "received, the key is still being checked".
  console.log(`IndexNow ${response.status} for ${body.urlList.length} URLs`);
  if (response.status !== 200 && response.status !== 202) {
    console.log(await response.text());
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
