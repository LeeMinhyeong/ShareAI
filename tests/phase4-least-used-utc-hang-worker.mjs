import http from 'node:http';
// A real socket and a handler that ignores client disconnect and never settles.
const server=http.createServer((req,res)=>{
 console.log('UNCOOPERATIVE_HANDLER_STARTED');
 void new Promise(()=>{});
});
server.listen(0,'127.0.0.1',()=>{
 if(server.address().port===20128) process.exit(2);
 const request=http.get({host:'127.0.0.1',port:server.address().port,path:'/'},()=>{});
 request.on('error',()=>{});
});
