process.on('SIGTERM',()=>{});
process.send({ready:true,cwd:process.cwd()});
setInterval(()=>{},1000);
