// Production entrypoint, isolated file DB and child-owned local IPC socket.
// Node built-in guards reduce accidental host access; they are not an OS sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here=fileURLToPath(import.meta.url);
const root=path.resolve(path.dirname(here),'..');
const url=name=>pathToFileURL(path.join(root,name)).href;
const clientUrl=url('src/db/client.ts'), serverUrl=url('src/server.ts');
const sqliteUrl=url('node_modules/better-sqlite3/lib/index.js');
const port=43070;
const pipePrefix=String.raw`\\.\pipe\shareai-snapshot-`;
const preload='data:text/javascript,'+encodeURIComponent(`
  import {registerHooks,syncBuiltinESMExports} from 'node:module';
  import childProcess from 'node:child_process';
  import {randomUUID} from 'node:crypto';
  import path from 'node:path';
  import net from 'node:net'; import tls from 'node:tls';
  const deny=()=>{throw Error('fixture operation denied')};
  const connect=net.Socket.prototype.connect,listen=net.Server.prototype.listen,address=net.Server.prototype.address;
  const isListening=Object.getOwnPropertyDescriptor(net.Server.prototype,'listening').get;
  const pipe=process.platform==='win32'?${JSON.stringify(pipePrefix)}+randomUUID():path.join(process.env.FIXTURE_DIR,'server.sock'); let owner;
  Object.defineProperty(globalThis,'__snapshotPipe',{value:pipe,writable:false,configurable:false});
  net.Server.prototype.listen=function(...args){
    if(owner||args[0]!==pipe)throw Error('unexpected listener');
    const result=listen.apply(this,args); owner=this; return result;
  };
  globalThis.__snapshotConnect=socket=>{
    if(!owner||!isListening.call(owner))throw Error('fixture listener unavailable');
    const bound=address.call(owner);
    if(bound!==pipe)throw Error('unexpected fixture address');
    return connect.call(socket,{path:pipe});
  };
  for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[name]=deny;
  net.connect=net.createConnection=deny;net.Socket.prototype.connect=deny;tls.connect=deny;globalThis.fetch=deny;syncBuiltinESMExports();
  registerHooks({resolve(specifier,context,next){
    if(context.parentURL?.startsWith(${JSON.stringify(url('src/'))})&&specifier.startsWith('.')&&specifier.endsWith('.js')){
      try{return next(specifier,context);}catch(error){if(error?.code!=='ERR_MODULE_NOT_FOUND')throw error;return next(specifier.slice(0,-3)+'.ts',context);}
    }
    return next(specifier,context);
  }});
`);

if(process.argv[2]!=='--snapshot-child'){
  test('production server snapshot parser errors, auth, and same-origin alias', {timeout:75000}, async()=>{
    const scratch=process.env.TMPDIR, windows=process.env.SystemRoot;
    assert.ok(scratch&&path.isAbsolute(scratch),'explicit absolute TMPDIR required');
    if(process.platform==='win32')assert.ok(windows&&path.isAbsolute(windows),'explicit Windows system root required');
    const dir=fs.mkdtempSync(path.join(scratch,'shareai-snapshot-'));
    let child, closed=false, timer, grace;
    try {
      const systemEnv=process.platform==='win32'?{SystemRoot:windows,SYSTEMROOT:windows,WINDIR:windows,PATH:`${path.join(windows,'System32')};${windows}`} : {};
      const env={...systemEnv,FIXTURE_DIR:dir,NODE_ENV:'test',PORT:String(port),HOST:'127.0.0.1',DATABASE_URL:`sqlite:${path.join(dir,'fixture.sqlite')}`,
        ENCRYPTION_KEY:'00'.repeat(32),ADMIN_API_KEY:'synthetic-admin-key-12345',LOG_LEVEL:'error',LOG_PRETTY:'false',CORS_ORIGIN:''};
      child=spawn(process.execPath,['--experimental-transform-types','--import',preload,here,'--snapshot-child'],{cwd:dir,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
      let bytes=0, stdout='', failed=false, timedOut=false;
      const done=new Promise(resolve=>{
        child.on('error',()=>{failed=true;});
        for(const [stream,isOut] of [[child.stdout,true],[child.stderr,false]]){
          stream.on('error',()=>{failed=true;});
          stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>16384){failed=true;child.kill();return;}if(isOut)stdout+=chunk.toString();});
        }
        child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});
      });
      timer=setTimeout(()=>{timedOut=true;child.kill();grace=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();child.unref();},5000);},45000);
      let watchdog;
      try {
        const result=await Promise.race([done,new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(Error(`owned child close unconfirmed; PID ${child.pid}; fixture retained`)),51000);})]);
        assert.equal(closed&&!failed&&!timedOut&&result.signal===null,true,'owned child failure or closure unconfirmed');
        const stages=['SCHEMA','STARTUP','ALIAS','PARSER','AUTH','OTHER'];
        const category=stages.find(stage=>stdout.includes('SNAPSHOT_FAILED:'+stage+'\n'));
        assert.equal(result.code,0,category?`isolated snapshot child failed: ${category}`:'isolated snapshot child failed');
        assert.equal(stdout.split(/\r?\n/).filter(line=>line==='SNAPSHOT_OK').length,1,'snapshot success marker missing or duplicated');
        assert.equal(category,undefined,'snapshot child also reported failure');
      } finally {clearTimeout(watchdog);}
    } finally {
      clearTimeout(timer);clearTimeout(grace);
      if(!child||closed)fs.rmSync(dir,{recursive:true,force:true});
    }
  });
}else{
  const key='synthetic-admin-key-12345';
  let stage='SCHEMA';
  try {
    assert.equal(process.env.FIXTURE_DIR,process.cwd());
    assert.ok(path.basename(process.cwd()).startsWith('shareai-snapshot-'));
    const expectedDb=path.join(process.cwd(),'fixture.sqlite');
    assert.equal(process.env.DATABASE_URL,`sqlite:${expectedDb}`);
    const descriptor=fs.openSync(expectedDb,'wx');fs.closeSync(descriptor);
    const [{default:Database},client,net,http]=await Promise.all([import(sqliteUrl),import(clientUrl),import('node:net'),import('node:http')]);
    const db=new Database(expectedDb,{fileMustExist:true});
    db.transaction(()=>client.provisionFreshSafetySchema(db)).immediate();db.close();
    const agent=new http.Agent({keepAlive:false});
    agent.createConnection=()=>{const socket=new net.Socket();globalThis.__snapshotConnect(socket);return socket;};
    let requestCount=0;
    function request(route,{body,authorization,method='GET'}={}){
      requestCount++;
      return new Promise((resolve,reject)=>{
        const headers={};if(authorization)headers.authorization=authorization;
        if(body!==undefined){headers['content-type']='application/json';headers['content-length']=Buffer.byteLength(body);}
        const req=http.request({socketPath:globalThis.__snapshotPipe,path:route,method,headers,agent,timeout:5000},res=>{
          let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;if(text.length>65536)req.destroy(Error('response too large'));});
          res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));res.on('error',reject);
        });
        req.on('timeout',()=>req.destroy(Error('request timeout')));req.on('error',reject);req.end(body);
      });
    }
    async function exercise(){
      const auth=`Bearer ${key}`;
      stage='ALIAS';
      const alias=await request('/api/admin/routing-snapshot',{authorization:auth});
      assert.equal(alias.status,200);assert.ok(Array.isArray(JSON.parse(alias.text).accounts));
      assert.equal((await request('/api/admin/routing-snapshot?fixture=1',{authorization:auth})).status,200);
      assert.equal((await request('/api/admin/routing-snapshot',{method:'POST',authorization:auth})).status,404);
      for(const route of ['/admin/routing-snapshot','/api/admin/routing-snapshot']){
        stage='PARSER';
        for(const [body,status] of [['{',400],[' '.repeat(10*1024*1024+1),413]]){
          const res=await request(route,{body});assert.equal(res.status,status);assert.match(res.headers['cache-control']??'',/(?:^|,)\s*no-store\s*(?:,|$)/i);
        }
        stage='AUTH';
        for(const [authorization,status] of [[undefined,401],['Bearer invalid-user-key',403],[auth,200]]){
          const res=await request(route,{authorization});assert.equal(res.status,status);assert.match(res.headers['cache-control']??'',/(?:^|,)\s*no-store\s*(?:,|$)/i);
          if(status===200)assert.ok(Array.isArray(JSON.parse(res.text).accounts));
        }
      }
      stage='OTHER';
      const unrelated=await request('/health',{body:'{'});assert.equal(unrelated.status,400);assert.equal(unrelated.headers['cache-control'],undefined);
      assert.equal((await request('/api/admin/users',{authorization:auth})).status,404);
      assert.equal(requestCount,15);
    }
    let resolveReady,rejectReady;
    const done=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const original=net.Server.prototype.listen;
    net.Server.prototype.listen=function(...args){
      if(args[0]!==port||args[1]!=='127.0.0.1')throw Error('unexpected listener');
      const owner=this;
      owner.once('listening',()=>setImmediate(()=>{exercise().then(resolveReady,rejectReady);}));
      // Keep the real production HTTP server, but redirect its bind to the
      // unique test-owned pipe instead of risking any existing TCP service.
      return original.call(owner,globalThis.__snapshotPipe,args[2]);
    };
    stage='STARTUP';
    await import(serverUrl);
    await done;
    agent.destroy();
    process.stdout.write('SNAPSHOT_OK\n',()=>process.emit('SIGTERM'));
  }catch{
    process.stdout.write(`SNAPSHOT_FAILED:${stage}\n`);process.exitCode=1;process.emit('SIGTERM');
  }
}
