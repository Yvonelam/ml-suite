const { ProxyAgent, Agent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const http=require('http');
const getJson=p=>new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9555,path:p},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej)});
(async()=>{
  const list=await getJson('/json/list').catch(()=>null);
  if(!list){console.log('need chrome on 9555');process.exit(0)}
  const t=list.find(x=>x.type==='page');
  const url=t.webSocketDebuggerUrl;
  const tries=[
    ['默认(继承全局代理)', ()=>new WebSocket(url)],
    ['显式 dispatcher=Agent', ()=>new WebSocket(url, { dispatcher: new Agent() })],
    ['数组+dispatcher', ()=>new WebSocket(url, [], { dispatcher: new Agent() })],
  ];
  for(const [name,fn] of tries){
    try{
      const ws=fn();
      await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',()=>rej(new Error('error')));setTimeout(()=>rej(new Error('timeout')),4000)});
      console.log('OK →',name); ws.close(); break;
    }catch(e){console.log('FAIL →',name,e.message)}
  }
})();
