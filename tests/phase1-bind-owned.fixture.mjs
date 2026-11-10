import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = name => pathToFileURL(path.join(root, name)).href;
const client = url('src/db/client.ts');
const server = url('src/server.ts');
const sqlite = url('node_modules/better-sqlite3/lib/index.js');
const logicalSnapshot = `
  const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  function logicalSnapshot(db){
    const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    const tables=schema.filter(row=>row.type==='table').map(row=>row.name);
    const data=tables.map(name=>{
      const quoted='"'+name.replaceAll('"','""')+'"';
      const rows=db.prepare('SELECT * FROM '+quoted).all().map(row=>{
        for(const value of Object.values(row)) if(typeof value==='bigint'||(typeof value==='number'&&(!Number.isSafeInteger(value)))) throw Error('unsupported fixture value');
        return JSON.stringify(row);
      }).sort();
      return [name,rows];
    });
    return {schemaHash:digest(schema),dataHash:digest(data),schemaVersion:db.pragma('schema_version',{simple:true}),userVersion:db.pragma('user_version',{simple:true}),integrity:db.pragma('integrity_check',{simple:true})};
  }
`;
// Native Node TS transformation avoids a tsx/esbuild helper process. Only
// unresolved relative .js imports from this project's src are mapped to .ts.
const preload = 'data:text/javascript,' + encodeURIComponent(`
  import {registerHooks,syncBuiltinESMExports} from 'node:module';
  import childProcess from 'node:child_process';
  import net from 'node:net'; import tls from 'node:tls';
  const deny=()=>{throw new Error('fixture operation denied')};
  if(process.env.FIXTURE_ALLOW_HEALTH==='1'){
    const ownedConnect=net.Socket.prototype.connect, ownedListen=net.Server.prototype.listen;
    const ownedAddress=net.Server.prototype.address;
    const isListening=Object.getOwnPropertyDescriptor(net.Server.prototype,'listening').get;
    const port=Number(process.env.PORT); let owner;
    if(port!==43040) throw Error('invalid fixture port');
    net.Server.prototype.listen=function(...args){
      if(owner||args[0]!==port||args[1]!=='127.0.0.1')throw Error('unexpected fixture listener');
      const result=ownedListen.apply(this,args); owner=this; return result;
    };
    globalThis.__fixtureConnect=socket=>{
      if(!owner||!isListening.call(owner))throw Error('invalid fixture listener');
      const address=ownedAddress.call(owner);
      if(!address||address.address!=='127.0.0.1'||address.port!==port)throw Error('invalid fixture listener');
      return ownedConnect.call(socket,{host:'127.0.0.1',port});
    };
  }
  for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[key]=deny;
  net.connect=net.createConnection=deny; net.Socket.prototype.connect=deny; tls.connect=deny;
  globalThis.fetch=deny; syncBuiltinESMExports();
  registerHooks({resolve(specifier,context,next){
    if(context.parentURL?.startsWith(${JSON.stringify(url('src/'))}) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      try{return next(specifier,context)}catch(error){if(error?.code!=='ERR_MODULE_NOT_FOUND')throw error;return next(specifier.slice(0,-3)+'.ts',context)}
    }
    return next(specifier,context);
  }});
`);

// Owned test resources only. A close timeout retains the fixture directory.
async function runChild(script, cwd, env, owned) {
  const child = spawn(process.execPath, ['--experimental-transform-types', '--import', preload, '--input-type=module', '-e', script], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  owned.add(child);
  let stdout = '', stderr = '', bytes = 0, failed = false, timedOut = false, closed = false, grace;
  const done = new Promise(resolve => {
    child.on('error', () => { failed = true; });
    for (const [stream, isOut] of [[child.stdout, true], [child.stderr, false]]) {
      stream.on('error', () => { failed = true; });
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 16384) { failed = true; child.kill(); return; }
        if (isOut) stdout += chunk.toString(); else stderr += chunk.toString();
      });
    }
    child.once('close', (code, signal) => { closed = true; owned.delete(child); resolve({code, signal}); });
  });
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill();
    grace = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }, 5000);
  }, 12000);
  let result;
  try {
    result = await Promise.race([done, new Promise((_, reject) => {
      const watchdog = setTimeout(() => reject(new Error(`owned child close not confirmed; PID ${child.pid}; fixture retained`)), 17500);
      done.then(() => clearTimeout(watchdog));
    })]);
  } finally { clearTimeout(deadline); clearTimeout(grace); }
  assert.equal(closed && !failed && !timedOut && result.signal === null, true, 'owned child failed or close was not confirmed');
  return {...result, stdout, stderr};
}

test('bind conflict reaches the listener and leaves an existing SQLite file unchanged', {timeout: 75000}, async () => {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch && path.isAbsolute(scratch), 'explicit absolute TMPDIR required');
  const dir = fs.mkdtempSync(path.join(scratch, 'shareai-bind-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  const owned = new Set();
  let safe = true;
  try {
    const windows = process.env.SystemRoot;
    assert.ok(windows && path.isAbsolute(windows), 'explicit Windows system root required');
    const env = { SystemRoot: windows, SYSTEMROOT: windows, WINDIR: windows, PATH: `${path.join(windows, 'System32')};${windows}`, NODE_ENV: 'test', PORT: '43040', HOST: '127.0.0.1', DATABASE_URL: `sqlite:${dbPath}`, ENCRYPTION_KEY: '00'.repeat(32), ADMIN_API_KEY: 'synthetic-admin-key-12345', LOG_LEVEL: 'error', LOG_PRETTY: 'false' };
    const setup = `import Database from ${JSON.stringify(sqlite)}; import fs from 'node:fs'; import {createHash} from 'node:crypto'; import {provisionFreshSafetySchema,initDatabase,closeDatabase} from ${JSON.stringify(client)}; ${logicalSnapshot} const db=new Database(process.env.DATABASE_URL.slice(7)); db.transaction(()=>provisionFreshSafetySchema(db)).immediate(); db.close(); const app=initDatabase(); app.exec("CREATE TABLE fixture_sentinel(value TEXT); INSERT INTO fixture_sentinel VALUES ('untouched')"); if(app.prepare('SELECT value FROM fixture_sentinel').get().value!=='untouched')throw Error('sentinel'); fs.writeFileSync('baseline.json',JSON.stringify(logicalSnapshot(app))); closeDatabase(); process.stdout.write('SETUP_OK\\n');`;
    const ready = await runChild(setup, dir, env, owned);
    assert.equal(ready.code, 0, 'synthetic database setup failed');
    assert.ok(ready.stdout.includes('SETUP_OK\n'), 'database setup marker missing');
    const snapshot = () => Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name))]));
    const before = snapshot();
    // The same child owns both the occupied port and the production attempt.
    // If child closure is unconfirmed, no parent cleanup can release its listener.
    const probe = `import net from 'node:net'; let held,port;for(let candidate=43040;candidate<=43060;candidate++){const s=net.createServer();try{await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(candidate,'127.0.0.1',resolve)});held=s;port=candidate;break}catch(e){if(e.code!=='EADDRINUSE')throw e}}if(!held)throw Error('no candidate');process.env.PORT=String(port);const original=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){if(args[0]!==port||args[1]!=='127.0.0.1')throw Error('unexpected listener');process.stdout.write('LISTEN_ATTEMPT\\n');this.once('error',error=>{if(error.code==='EADDRINUSE')process.stdout.write('BIND_CONFLICT\\n')});return original.apply(this,args)};await import(${JSON.stringify(server)});`;
    const result = await runChild(probe, dir, env, owned);
    assert.equal(result.code, 1, 'bind conflict must exit with status 1');
    assert.ok(result.stdout.includes('LISTEN_ATTEMPT\n'), 'production listener was not attempted');
    assert.ok(result.stdout.includes('BIND_CONFLICT\n'), 'expected EADDRINUSE was not observed');
    const after = snapshot();
    // Open the same owned fixture only after the physical snapshot; a readonly
    // SQLite connection can itself change WAL/SHM state.
    const inspect = `import Database from ${JSON.stringify(sqlite)}; import fs from 'node:fs'; import {createHash} from 'node:crypto'; ${logicalSnapshot} const before=JSON.parse(fs.readFileSync('baseline.json','utf8')); const db=new Database(process.env.DATABASE_URL.slice(7),{readonly:true,fileMustExist:true}); const after=logicalSnapshot(db); db.close(); process.stdout.write('LOGICAL:'+JSON.stringify({schemaEqual:before.schemaHash===after.schemaHash,dataEqual:before.dataHash===after.dataHash,userVersionEqual:before.userVersion===after.userVersion,versionBefore:before.schemaVersion,versionAfter:after.schemaVersion,integrityBefore:before.integrity==='ok',integrityAfter:after.integrity==='ok'})+'\\n');`;
    const inspected = await runChild(inspect, dir, env, owned);
    assert.equal(inspected.code, 0, 'owned DB logical inspection failed');
    const lines = inspected.stdout.split(/\r?\n/).filter(line => line.startsWith('LOGICAL:'));
    assert.equal(lines.length, 1, 'logical inspection marker missing or duplicated');
    let logical;
    try { logical = JSON.parse(lines[0].slice('LOGICAL:'.length)); }
    catch { assert.fail('logical inspection marker malformed'); }
    assert.equal(typeof logical.schemaEqual, 'boolean');
    assert.equal(typeof logical.dataEqual, 'boolean');
    assert.equal(typeof logical.userVersionEqual, 'boolean');
    assert.equal(typeof logical.integrityBefore, 'boolean');
    assert.equal(typeof logical.integrityAfter, 'boolean');
    assert.ok(Number.isSafeInteger(logical.versionBefore) && Number.isSafeInteger(logical.versionAfter));
    const file = path.basename(dbPath);
    const sameMain = !!before[file] && !!after[file] && after[file].equals(before[file]);
    const sameFiles = Object.keys(after).join('\0') === Object.keys(before).join('\0');
    const sameContents = sameFiles && Object.keys(before).every(name => after[name].equals(before[name]));
    const walBytes = after[`${file}-wal`]?.length ?? 0;
    assert.ok(sameMain && sameContents && logical.schemaEqual && logical.dataEqual && logical.userVersionEqual && logical.integrityBefore && logical.integrityAfter, `DB changed on bind failure: mainUnchanged=${sameMain}, filesUnchanged=${sameFiles}, walBytes=${walBytes}, schemaEqual=${logical.schemaEqual}, dataEqual=${logical.dataEqual}, userVersionEqual=${logical.userVersionEqual}, schemaVersionBefore=${logical.versionBefore}, schemaVersionAfter=${logical.versionAfter}, integrityBefore=${logical.integrityBefore}, integrityAfter=${logical.integrityAfter}`);
  } finally {
    if (owned.size) safe = false;
    if (safe) fs.rmSync(dir, {recursive:true, force:true});
  }
});

test('production listener serves health after initialization on its owned port', {timeout: 60000}, async () => {
  const scratch=process.env.TMPDIR;
  assert.ok(scratch && path.isAbsolute(scratch), 'explicit absolute TMPDIR required');
  const dir=fs.mkdtempSync(path.join(scratch, 'shareai-start-'));
  const dbPath=path.join(dir, 'fixture.sqlite');
  const owned=new Set();
  try {
    const windows=process.env.SystemRoot;
    assert.ok(windows && path.isAbsolute(windows), 'explicit Windows system root required');
    const env={SystemRoot:windows,SYSTEMROOT:windows,WINDIR:windows,PATH:`${path.join(windows,'System32')};${windows}`,FIXTURE_ALLOW_HEALTH:'1',NODE_ENV:'test',PORT:'43040',HOST:'127.0.0.1',DATABASE_URL:`sqlite:${dbPath}`,ENCRYPTION_KEY:'00'.repeat(32),ADMIN_API_KEY:'synthetic-admin-key-12345',LOG_LEVEL:'error',LOG_PRETTY:'false'};
    const setup=`import Database from ${JSON.stringify(sqlite)}; import {provisionFreshSafetySchema,initDatabase,closeDatabase} from ${JSON.stringify(client)}; const db=new Database(process.env.DATABASE_URL.slice(7));db.transaction(()=>provisionFreshSafetySchema(db)).immediate();db.close();initDatabase();closeDatabase();process.stdout.write('SETUP_OK\\n');`;
    const setupResult=await runChild(setup,dir,env,owned);
    assert.equal(setupResult.code,0,'synthetic database setup failed');
    assert.ok(setupResult.stdout.includes('SETUP_OK\n'),'setup marker missing');
    // Only connect after the actual production listener emits listening; the
    // startup callback runs synchronously before the setImmediate request.
    const probe=`import net from 'node:net';import http from 'node:http';const port=Number(process.env.PORT),original=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){if(args[0]!==port||args[1]!=='127.0.0.1')throw Error('unexpected listener');const owner=this;owner.once('listening',()=>setImmediate(()=>{if(!owner.listening)throw Error('listener lost');const agent=new http.Agent({keepAlive:false});agent.createConnection=()=>{const socket=new net.Socket();globalThis.__fixtureConnect(socket);return socket;};const req=http.request({host:'127.0.0.1',port,path:'/health',method:'GET',agent},res=>{let body='';res.setEncoding('utf8');res.on('data',part=>{body+=part;if(body.length>4096)throw Error('response too large')});res.on('end',()=>{if(res.statusCode!==200||JSON.parse(body).status!=='ok')throw Error('health failed');process.stdout.write('HEALTH_OK\\n');agent.destroy();process.emit('SIGTERM');});});req.on('error',()=>{throw Error('request failed')});req.end();}));return original.apply(owner,args)};await import(${JSON.stringify(server)});`;
    const result=await runChild(probe,dir,env,owned);
    assert.equal(result.code,0,'owned production listener did not exit normally');
    assert.ok(result.stdout.includes('HEALTH_OK\n'),'production listener health marker missing');
  } finally {
    if(!owned.size) fs.rmSync(dir,{recursive:true,force:true});
  }
});
