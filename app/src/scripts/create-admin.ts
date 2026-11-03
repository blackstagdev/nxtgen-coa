/**
 * Creates (or resets) an administrator account.
 *
 *   npm run create-admin -- --email you@example.com --name "Dr. Name"
 *   (prompts for the password; or set CREATE_ADMIN_PASSWORD for non-interactive use)
 */
import readline from 'node:readline';
import { createUser, setPassword } from '../auth/users.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function prompt(q: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => {
      if (s.includes(q)) out.output.write(s);
      else out.output.write('*');
    };
  }
  return new Promise((resolve) =>
    rl.question(q, (a) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(a);
    }),
  );
}

async function main() {
  const email = (arg('email') ?? (await prompt('Email: '))).trim().toLowerCase();
  const name = (arg('name') ?? (await prompt('Full name: '))).trim();
  const password = process.env.CREATE_ADMIN_PASSWORD ?? (await prompt('Password (min 12 chars): ', true));
  const cfg = loadConfig();
  const db = createPool(cfg);
  try {
    const existing = await db.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
    if (existing.rows[0]) {
      await setPassword(db, existing.rows[0].id, password);
      await db.query(`UPDATE users SET role = 'admin', is_active = true, locked_until = NULL WHERE id = $1`, [existing.rows[0].id]);
      console.log(`Reset password and granted admin to ${email}.`);
    } else {
      await createUser(db, { email, name: name || email, role: 'admin', password });
      console.log(`Created administrator ${email}.`);
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
