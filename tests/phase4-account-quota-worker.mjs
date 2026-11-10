import { EventEmitter } from 'node:events';
const [db, port] = process.argv.slice(2);
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${db}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),PORT:'20100',LOG_LEVEL:'error',LOG_PRETTY:'false'});
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => originalFetch(`http://127.0.0.1:${port}/${String(url).includes('oauth/token') ? 'token' : 'inference'}`, opts);
const {forwardChat} = await import('../src/upstream/forward-chat.ts');
const res = Object.assign(new EventEmitter(),{statusCode:200,headersSent:false,writableEnded:false,status(n){this.statusCode=n;return this},json(){this.writableEnded=true;return this},getHeader(){},setHeader(){},end(){this.writableEnded=true},destroy(){}});
await forwardChat({user:{id:'fixture'},body:{model:'gpt-5',messages:[{role:'user',content:'hi'}]}},res);
console.log('RESULT:'+res.statusCode);
