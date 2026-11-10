import {randomInt} from 'node:crypto';

// Select before binding; never ask the OS for port 0 or bind the reserved port.
export async function listenFixture(server, choose=()=>randomInt(30000,60000)) {
  for(let attempt=0;attempt<32;attempt++) {
    const port=choose();
    if(!Number.isInteger(port) || port<1 || port>65535 || port===20128) continue;
    try {
      await new Promise((resolve,reject)=>{
        const cleanup=()=>{server.off('error',onError);server.off('listening',onListen);};
        const onError=e=>{cleanup();reject(e);};
        const onListen=()=>{cleanup();resolve();};
        server.once('error',onError); server.once('listening',onListen);
        try {server.listen(port,'127.0.0.1');} catch(e) {cleanup();reject(e);}
      });
      return;
    } catch(e) {
      if(e?.code!=='EADDRINUSE') throw e;
    }
  }
  throw new Error('fixture listener candidate limit exhausted');
}
