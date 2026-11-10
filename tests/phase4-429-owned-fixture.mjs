import fs from 'node:fs';
import path from 'node:path';

// Pinned to the approved Hermes scratch on this host; never fall back to temp.
// These checks guard accidental misuse, not concurrent filesystem replacement.
export function create429Fixture() {
  const root = path.resolve('C:/Users/Administrator/AppData/Local/hermes/cache/scratch');
  if (process.platform !== 'win32') throw new Error('429 fixture requires the approved Windows Hermes scratch');
  let part = path.parse(root).root;
  for (const name of root.slice(part.length).split(path.sep).filter(Boolean)) {
    part = path.join(part, name);
    const stat = fs.lstatSync(part);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe 429 fixture scratch component');
  }
  const dir = fs.mkdtempSync(path.join(root, 'phase4-429-owned-'));
  const owned = fs.lstatSync(dir);
  const previousCwd = process.cwd(), previousEnv = {...process.env};
  let changedCwd = false;
  return {
    dir,
    enter() {
      const stat = fs.lstatSync(dir);
      if (path.dirname(dir).toLowerCase() !== root.toLowerCase() || stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== owned.dev || stat.ino !== owned.ino) throw new Error('unsafe 429 fixture directory');
      // Not created here: a DB-using test provisions it (tests/helpers/fresh-db.mjs)
      // after enter(), because the production client never creates a database.
      const file = path.join(dir, 'fixture.sqlite');
      process.chdir(dir); changedCwd = true;
      const {PATH, SystemRoot} = process.env;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, {PATH:PATH ?? '', SystemRoot:SystemRoot ?? '', HOME:dir, USERPROFILE:dir, TEMP:dir, TMP:dir, TMPDIR:dir,
        NODE_ENV:'test', DATABASE_URL:`sqlite:${file}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'synthetic-test-admin-key-only', LOG_LEVEL:'error', LOG_PRETTY:'false', HOST:'127.0.0.1', PORT:'20100'});
    },
    cleanup(safe) {
      const errors = [];
      if (changedCwd) {
        try { process.chdir(previousCwd); changedCwd = false; } catch (e) { errors.push(e); safe = false; }
      }
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      if (safe) {
        try {
          const stat=fs.lstatSync(dir);
          if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== owned.dev || stat.ino !== owned.ino) throw new Error('429 fixture ownership changed; retained');
          fs.rmSync(dir, {recursive:true});
        } catch (e) { errors.push(e); }
      } else errors.push(new Error(`429 fixture retained because closure was not confirmed: ${dir}`));
      if (errors.length) throw new AggregateError(errors, '429 fixture cleanup failed');
    },
  };
}

export function bounded429(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 8000); })]).finally(() => clearTimeout(timer));
}
