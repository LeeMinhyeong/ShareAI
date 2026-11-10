// Synthetic, complete text-only provider lifecycles used by route regressions.
const event=x=>`data: ${JSON.stringify(x)}\n\n`;
const part=text=>({type:'output_text',text,annotations:[]});
const item=(status,content)=>({id:'msg_1',type:'message',status,role:'assistant',content});
export const responseStream=[
 {type:'response.created',response:{id:'resp_1',status:'in_progress'}},
 {type:'response.in_progress',response:{id:'resp_1',status:'in_progress'}},
 {type:'response.output_item.added',output_index:0,item:item('in_progress',[])},
 {type:'response.content_part.added',item_id:'msg_1',output_index:0,content_index:0,part:part('')},
 {type:'response.output_text.delta',item_id:'msg_1',output_index:0,content_index:0,delta:'hello'},
 {type:'response.output_text.done',item_id:'msg_1',output_index:0,content_index:0,text:'hello'},
 {type:'response.content_part.done',item_id:'msg_1',output_index:0,content_index:0,part:part('hello')},
 {type:'response.output_item.done',output_index:0,item:item('completed',[part('hello')])},
 {type:'response.completed',response:{id:'resp_1',status:'completed',output:[item('completed',[part('hello')])]}}
].map(event).join('');
export const chatStream=event({choices:[{index:0,delta:{role:'assistant',content:'hello'},finish_reason:null}]})+event({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';

// The same complete Responses lifecycle whose terminal event reports provider usage.
export const responseStreamWithUsage=usage=>responseStream.replace('"status":"completed","output"',`"status":"completed","usage":${JSON.stringify(usage)},"output"`);
