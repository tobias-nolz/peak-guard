/**
 * Print an scrypt hash for AUTH_PASSWORD_HASH:
 *   docker compose run --rm api node dist/hash-password.js 'my secret password'
 */
import { hashPassword } from './auth.js';

const pw = process.argv[2];
if (!pw || pw.length < 8) {
  console.error('usage: hash-password <password>   (at least 8 characters)');
  process.exit(1);
}
console.log(await hashPassword(pw));
