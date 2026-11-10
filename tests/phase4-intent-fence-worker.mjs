const [file,id] = process.argv.slice(2);
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {closeDatabase}=await import('../src/db/client.ts');
const repo=new AccountRepository(); const account=repo.findById(id);
if (!account) throw new Error('fixture missing');
repo.claimRefresh(id,account.credentials);
closeDatabase();
