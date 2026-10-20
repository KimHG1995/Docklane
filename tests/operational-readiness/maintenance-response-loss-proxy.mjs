import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Disposable loopback relay used ONLY by the real Swarm acceptance harness.
 * It waits until the real mTLS Agent has responded to a Docker mutation and
 * then destroys the Control Plane-facing response. This proves "applied,
 * response lost", not merely a failed connection before dispatch.
 */
export async function createPostApplyResponseLossProxy({targetUrl,cert,key,ca}) {
  const events=[];
  const endpoint=new URL(targetUrl);
  let lost=false;
  const server=createServer((request,response)=>{
    const headers={...request.headers,host:endpoint.host};
    delete headers.connection;
    delete headers['transfer-encoding'];
    const upstream=httpsRequest({
      hostname:endpoint.hostname,port:endpoint.port,
      path:request.url,method:request.method,
      cert,key,ca,rejectUnauthorized:true,headers,
    },received=>{
      const mutation=request.method==='POST' && /^\/v2\/(services|nodes)\/[^/]+\/(scale|restart|image|rollback|drain|activate|labels)$/.test(request.url ?? '');
      if(mutation) {
        let body='';
        received.setEncoding('utf8');
        received.on('data',chunk=>{body+=chunk;});
        received.on('end',()=>{
          events.push({
            path:request.url,method:request.method,
            status:received.statusCode,
            code:(()=>{try{return JSON.parse(body).code??null;}catch{return null;}})(),
            acknowledgedByAgent:received.statusCode===200,
          });
          if(!lost && received.statusCode===200) {
            lost=true;
            response.destroy();
            return;
          }
          if(!response.destroyed){
            response.writeHead(received.statusCode??502,{
              'content-type':'application/json',
            });
            response.end(body);
          }
        });
      } else {
        response.writeHead(received.statusCode??502,received.headers);
        received.pipe(response);
      }
    });
    upstream.once('error',err=>{
      events.push({transportError:String(err)});
      if(!response.destroyed){
        response.statusCode=502;
        response.setHeader('content-type','application/json');
        response.end(JSON.stringify({error:'relay upstream unavailable'}));
      }
    });
    request.once('aborted',()=>upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const address=server.address();
  if(!address || typeof address==='string') throw new Error('Loss proxy did not allocate a port');
  return {
    baseUrl:`http://127.0.0.1:${address.port}`,
    events,
    close:()=>new Promise((resolve,reject)=>{
      server.close(err=>err?reject(err):resolve());
      server.closeAllConnections();
    }),
  };
}
