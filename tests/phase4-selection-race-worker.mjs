const [file,id]=process.argv.slice(2);
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {invokeAccountAttempt}=await import('../src/upstream/account-quota.ts');
const {closeDatabase}=await import('../src/db/client.ts');
const a=new AccountRepository().findById(id);
await invokeAccountAttempt(a,new AbortController().signal,async()=>new Response('ok'));
closeDatabase();
