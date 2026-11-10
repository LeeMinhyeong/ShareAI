import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer as createHttpServer} from 'node:http';
import {once} from 'node:events';
import {createServer,loadConfigFromFile} from 'vite';
import {RoutingSnapshotView, ROUTING_SNAPSHOT_URL} from '../src/pages/RoutingSnapshot.tsx';

test('same-origin snapshot path reaches the admin route through Vite proxy', {timeout:15000}, async()=>{
 const backend=createHttpServer((req,res)=>{res.setHeader('cache-control','no-store');res.end(JSON.stringify({path:req.url,auth:req.headers.authorization}));});
 let vite;
 try {
  backend.listen(0,'127.0.0.1'); await once(backend,'listening');
  const loaded=await loadConfigFromFile({command:'serve',mode:'test'});
  const proxy=loaded.config.server.proxy;
  const route=proxy['/api/admin/routing-snapshot'];
  assert.equal(route.target,'http://localhost:20100');
  vite=await createServer({configFile:false,server:{host:'127.0.0.1',port:0,proxy:{...proxy,'/api/admin/routing-snapshot':{...route,target:`http://127.0.0.1:${backend.address().port}`}}}});
  await vite.listen();
  const response=await fetch(`http://127.0.0.1:${vite.httpServer.address().port}${ROUTING_SNAPSHOT_URL}`,{headers:{authorization:'Bearer synthetic-admin'},signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200); assert.match(response.headers.get('cache-control'),/no-store/);
  assert.deepEqual(await response.json(),{path:'/admin/routing-snapshot',auth:'Bearer synthetic-admin'});
 } finally {if(vite) await vite.close(); if(backend.listening) await new Promise((resolve,reject)=>backend.close(err=>err?reject(err):resolve()));}
});

test('UTC dates and invalid timestamps are rendered safely',()=>{
 const html=renderToStaticMarkup(React.createElement(RoutingSnapshotView,{snapshot:{as_of:'not a date',note:'Global',accounts:[{kind:'upstream',id:'x',state:'cooldown_until',cooldown_until:8640000000000001},{kind:'siwc',id:'y',state:'cooldown_until',cooldown_until:0}]}}));
 assert.match(html,/invalid timestamp/i); assert.match(html,/1970-01-01T00:00:00.000Z/); assert.doesNotMatch(html,/Invalid Date/);
});

test('routing snapshot displays both account kinds and observed states',()=>{
 const html=renderToStaticMarkup(React.createElement(RoutingSnapshotView,{snapshot:{as_of:'2026-01-01T00:00:00.000Z',note:'Routing snapshot best-effort',accounts:[{kind:'upstream',id:'one',state:'open'},{kind:'siwc',id:'two',state:'cooldown_until',cooldown_until:2000000000000},{kind:'siwc',id:'three',state:'unavailable'},{kind:'upstream',id:'four',state:'no_known_block'}]}}));
 for(const value of ['Routing snapshot','one','two','three','four','upstream','siwc','OPEN','cooldown','no_known_block','unavailable','UTC']) assert.ok(html.includes(value),value);
});
