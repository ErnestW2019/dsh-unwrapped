/**
 * Mint a valid browser-session cookie for a running harness instance, so a
 * headless check can read an auth-gated route (the plugin's /unwrapped) without the
 * user's token. Dev tool only.
 *
 *   node scripts/mint-cookie.mjs --authority 127.0.0.1:8080
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const COOKIE_PREFIX = 'dsh-conn-';
const PAYLOAD_VERSION = 1;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const authority = process.argv.includes('--authority')
  ? process.argv[process.argv.indexOf('--authority') + 1]
  : '127.0.0.1:8080';
const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const text = readFileSync(join(home, '.credentials.yaml'), 'utf8');
const match = /secret:\s*(\S+)/.exec(text);
if (!match) throw new Error('no browser-session secret in .credentials.yaml');
const secret = Buffer.from(match[1], 'base64url');

const now = Date.now();
const payload = {
  version: PAYLOAD_VERSION,
  authority,
  issuedAt: now,
  expiresAt: now + 30 * 86_400_000,
};
const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
const signature = createHmac('sha256', secret).update(body).digest();
const name = `${COOKIE_PREFIX}${b64url(createHash('sha256').update(authority).digest())}`;
const value = `v1.${body}.${b64url(signature)}`;
process.stdout.write(`${name}=${value}`);
