// The caller must independently establish that no handler can access the DB.
export async function cleanupFixture({primaryFailed,primary,timeout=8000,safeToCloseDb,closeServer,closeProvider,closeDb}) {
  const errors=primaryFailed?[primary]:[];
  const run=(fn,label)=>{
    let timer;
    return Promise.race([
      Promise.resolve().then(fn),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} close timed out`)),timeout);}),
    ]).finally(()=>clearTimeout(timer));
  };
  const settled=await Promise.allSettled([run(closeServer,'server'),run(closeProvider,'provider')]);
  for(const item of settled) if(item.status==='rejected') errors.push(item.reason);
  if(safeToCloseDb) {
    const [item]=await Promise.allSettled([run(closeDb,'database')]);
    if(item.status==='rejected') errors.push(item.reason);
  }
  return {errors};
}

// Even a failure of closeAllConnections must not prevent close() being called.
export async function closeFixtureServer(server) {
  if(!server?.listening) return;
  const errors=[];
  try {server.closeAllConnections();} catch(e) {errors.push(e);}
  try {await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));} catch(e) {errors.push(e);}
  if(errors.length) throw new AggregateError(errors,'fixture server close failed');
}
