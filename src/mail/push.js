import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify} from 'jose';
import {HttpError} from '../http/errors.js';
import {credentialsMatch} from '../providers/mail-credentials.js';

const DAY=86400000;
const same=(a,b)=>{
  if(typeof a!=='string'||typeof b!=='string')return false;
  const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);
};
export function createGooglePushVerifier({keySet=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'),{timeoutDuration:5000}),audience,email}) {
  return async authorization=>{
    const token=/^Bearer ([A-Za-z0-9._-]{1,16000})$/.exec(authorization || '')?.[1];
    if(!token)throw new HttpError(401,'Notification non autorisée.','push_auth');
    try {
      const {payload}=await jwtVerify(token,keySet,{audience,issuer:['https://accounts.google.com','accounts.google.com'],algorithms:['RS256'],maxTokenAge:'2h'});
      if(payload.email!==email || ![true,'true'].includes(payload.email_verified))throw new Error();
    } catch {throw new HttpError(401,'Notification non autorisée.','push_auth');}
  };
}

// Durable coalescing is encrypted alongside each mailbox's OAuth credentials. No send path is called here.
export function createMailPush({config,store,vault,providers,clock=Date.now,verifyGoogle,log=console,reconcileMs=10*60000}) {
  const settings=config.mailPush || {},base=config.publicBaseUrl;
  const enabled=service=>config.connectorsEnabled!==false && !!settings[service==='gmail'?'gmailEnabled':'outlookEnabled'];
  const url=service=>`${base}/webhooks/${service}`;
  const configuration=service=>service==='gmail'?`${url(service)}|${settings.gmailTopic}|${settings.gmailSubscription}|${settings.gmailServiceAccount}`:`${url(service)}|${config.microsoftTenant}`;
  const verify=verifyGoogle || (enabled('gmail')?createGooglePushVerifier({audience:url('gmail'),email:settings.gmailServiceAccount}):null);
  const registering=new Set(),syncing=new Set(),tasks=new Set(),limits=new Map();
  let timer=null,paused=true;
  function load(id) {
    if(!store.hasAccount(id))return null;
    const account=store.getAccount(id),provider=providers[account.svc],sealed=store.getSecret(id);
    if(!provider || !sealed || !enabled(account.svc))return null;
    let cred;try {cred=vault.open(id,sealed);}catch{return null;}
    if(!credentialsMatch(provider.oauth,cred))return null;
    const state=cred.mailPush;
    const valid=state?.v===1 && typeof state.incarnation==='string' && state.identity===store.accountIdentity(id) && state.binding===provider.oauth.binding && state.configuration===configuration(account.svc);
    return {account,provider,cred,state:valid?state:null};
  }
  function update(id,fn) {
    const entry=load(id);if(!entry)return null;
    const state=fn(entry.state,entry);if(!state)return entry.state;
    store.putSecret(id,vault.seal(id,{...entry.cred,mailPush:state}));return state;
  }
  const live=state=>state?.status==='active' && state.expiresAt>clock()+30000;
  function track(set,id,job) {
    set.add(id);const task=Promise.resolve().then(job).catch(()=>{log.warn?.('Notification mail : opération différée.');}).finally(()=>{set.delete(id);tasks.delete(task);});tasks.add(task);
  }
  function seed(entry) {
    // Graph permits one resource/changeType lease per mailbox and application.
    // Profiles containing the same verified mailbox share its delivery identity.
    const sibling=entry.account.svc==='outlook'?store.accountsBySvc('outlook').filter(id=>id!==entry.account.id)
      .map(id=>load(id)).find(other=>other?.account.address?.toLowerCase()===entry.account.address?.toLowerCase() && other.state?.clientState):null;
    return {v:1,incarnation:randomBytes(16).toString('hex'),identity:store.accountIdentity(entry.account.id),binding:entry.provider.oauth.binding,configuration:configuration(entry.account.svc),status:'registering',expiresAt:0,renewAfter:0,revision:0,processed:0,leaseEpoch:0,...(entry.account.svc==='outlook'?{clientState:sibling?.state.clientState || randomBytes(32).toString('base64url'),...(sibling?.state.subscriptionId?{subscriptionId:sibling.state.subscriptionId}:{})}:{})};
  }
  async function ensureLease(id) {
    const entry=load(id);if(!entry || paused || entry.account.status==='À reconnecter')return;
    const lease=update(id,(s,e)=>({...s || seed(e),leaseEpoch:(s?.leaseEpoch || 0)+1,operation:randomBytes(16).toString('hex')}));
    if(!lease)return;
    try {
      const result=await entry.provider.sync.exclusive(id,async c=>{
        if(paused || !c.live())throw new Error();
        if(entry.account.svc==='gmail') {
          const watched=await c.gmail.post('watch',{topicName:settings.gmailTopic});
          if(!c.live())throw new Error();
          return {expiresAt:Number(watched.expiration)};
        }
        const graph=c.graph,expirationDateTime=new Date(clock()+2*DAY).toISOString();let subscription;
        if(lease.subscriptionId) {
          try {subscription=await graph.request('PATCH',`subscriptions/${encodeURIComponent(lease.subscriptionId)}`,{body:{expirationDateTime},forceRefresh:true});}
          catch(error){if(error.code!=='not_found')throw error;}
        }
        if(!subscription) {
          const existing=await graph.request('GET','subscriptions');
          subscription=(existing.value || []).find(s=>s.notificationUrl===url('outlook') && same(s.clientState,lease.clientState) && Date.parse(s.expirationDateTime)>clock()+3600000);
          if(!subscription) {
            // Graph disallows duplicate resource/changeType subscriptions. A reconnect
            // rotates clientState; remove only this app's matching callback/resource.
            for(const stale of existing.value || [])if(stale.notificationUrl===url('outlook') && stale.lifecycleNotificationUrl===url('outlook') && stale.resource==='me/messages' &&
              String(stale.changeType).split(',').sort().join(',')==='created,deleted,updated' && /^[a-zA-Z0-9-]{1,200}$/.test(stale.id || '')) {
              if(!c.live())throw new Error();
              try{await graph.request('DELETE',`subscriptions/${encodeURIComponent(stale.id)}`);}catch(error){if(error.code!=='not_found')throw error;}
            }
            if(!c.live())throw new Error();
            subscription=await graph.request('POST','subscriptions',{body:{changeType:'created,updated,deleted',notificationUrl:url('outlook'),lifecycleNotificationUrl:url('outlook'),resource:'me/messages',expirationDateTime,clientState:lease.clientState}});
          }
        }
        if(!c.live())throw new Error();
        if(typeof subscription.id!=='string' || !/^[a-zA-Z0-9-]{1,200}$/.test(subscription.id))throw new Error();
        return {subscriptionId:subscription.id,expiresAt:Date.parse(subscription.expirationDateTime)};
      });
      if(!Number.isFinite(result.expiresAt) || result.expiresAt<=clock()+60000)throw new Error();
      update(id,s=>s?.operation===lease.operation&&s.leaseEpoch===lease.leaseEpoch?{...s,...result,status:'active',renewAfter:Math.min(clock()+DAY,result.expiresAt-3600000),retryLeaseAfter:0,revision:s.revision+1}:null);
    } catch {
      update(id,s=>s?.operation===lease.operation&&s.leaseEpoch===lease.leaseEpoch?{...s,status:s.expiresAt>clock()+30000?'active':'retrying',retryLeaseAfter:clock()+60000}:null);
      log.warn?.('Notification mail : renouvellement différé, récupération périodique maintenue.');
    }
  }
  async function processPending(id) {
    const entry=load(id);if(!entry?.state || paused || entry.account.status==='À reconnecter')return;
    const revision=entry.state?.revision || 0;
    try {
      const ok=await entry.provider.sync.notify(id);
      update(id,s=>s && s.incarnation===entry.state.incarnation ? {...s,...(ok===true?{processed:Math.max(s.processed || 0,revision),retrySyncAfter:0}:{retrySyncAfter:clock()+60000})}:null);
    } catch {update(id,s=>s?.incarnation===entry.state.incarnation?{...s,retrySyncAfter:clock()+60000}:null);}
  }
  function tick() {
    if(paused)return;
    for(const service of ['gmail','outlook'])if(enabled(service))for(const id of store.accountsBySvc(service)) {
      const entry=load(id);if(!entry || entry.account.status==='À reconnecter')continue;
      const s=entry.state;
      if(!registering.has(id) && (!s || (s.renewAfter<=clock() || !live(s)) && !(s.retryLeaseAfter>clock())))track(registering,id,()=>ensureLease(id));
      if(s && s.revision>s.processed && !(s.retrySyncAfter>clock()) && !syncing.has(id))track(syncing,id,()=>processPending(id));
    }
  }
  function bump(id,extra={}) {
    update(id,(s,e)=>({...s || seed(e),...extra,revision:(s?.revision || 0)+1,lastNotificationAt:clock()}));
  }
  function limit(req) {
    const now=clock();for(const [key,v] of limits)if(v.until<=now)limits.delete(key);
    const key=req.socket?.remoteAddress || 'peer';
    if(!limits.has(key) && limits.size>=256)throw new HttpError(429,'Trop de notifications.','push_rate');
    const item=limits.get(key)||{count:0,until:now+60000};limits.set(key,item);
    if(++item.count>600)throw new HttpError(429,'Trop de notifications.','push_rate');
  }
  return {
    shouldPoll(service,id) {
      const entry=load(id);if(!entry || !live(entry.state))return true;
      const last=Date.parse(store.getSync(id)?.last_sync_at || '');
      return !Number.isFinite(last) || clock()-last>=reconcileMs;
    },
    status(id) {
      const entry=load(id),s=entry?.state;
      return {mode:entry&&live(s)?'push':'recovery',pending:!!s&&s.revision>s.processed,expiresAt:s?.expiresAt || null,lastNotificationAt:s?.lastNotificationAt || null};
    },
    async handle(req,res,requestUrl,readJson,respond) {
      const service=requestUrl.pathname==='/webhooks/gmail'?'gmail':requestUrl.pathname==='/webhooks/outlook'?'outlook':null;
      if(!service || !enabled(service))return false;
      limit(req);
      if(req.method!=='POST')throw new HttpError(405,'POST attendu.','method_not_allowed');
      const validation=requestUrl.searchParams.get('validationToken');
      if(service==='outlook' && validation!==null) {
        if(!validation || validation.length>4096)throw new HttpError(400,'Validation invalide.','push_invalid');
        respond(res,200,validation,'text/plain; charset=utf-8');return true;
      }
      if(service==='gmail')await verify(req.headers.authorization);
      const body=await readJson(req);
      if(service==='gmail') {
        if(body.subscription!==settings.gmailSubscription || typeof body.message?.data!=='string' || body.message.data.length>8192)throw new HttpError(400,'Notification invalide.','push_invalid');
        let data;try{data=JSON.parse(Buffer.from(body.message.data,'base64url').toString('utf8'));}catch{throw new HttpError(400,'Notification invalide.','push_invalid');}
        if(typeof data.emailAddress!=='string' || !/^\d{1,40}$/.test(data.historyId || ''))throw new HttpError(400,'Notification invalide.','push_invalid');
        for(const id of store.accountsBySvc('gmail')) {
          const entry=load(id);if(!entry || entry.account.address?.toLowerCase()!==data.emailAddress.toLowerCase())continue;
          if(entry.state?.lastNotificationHistoryId && BigInt(entry.state.lastNotificationHistoryId)>=BigInt(data.historyId))continue;
          bump(id,{lastNotificationHistoryId:data.historyId});
        }
      } else {
        if(!Array.isArray(body.value) || body.value.length>100 || body.value.some(item=>!item || typeof item!=='object' || Array.isArray(item)))throw new HttpError(400,'Notification invalide.','push_invalid');
        for(const item of body.value)for(const id of store.accountsBySvc('outlook')) {
          const s=load(id)?.state;
          if(!s || item.subscriptionId!==s.subscriptionId || !same(item.clientState,s.clientState) || typeof item.tenantId!=='string' || item.tenantId.toLowerCase()!==config.microsoftTenant?.toLowerCase())continue;
          if(item.lifecycleEvent) {
            if(!['missed','subscriptionRemoved','reauthorizationRequired'].includes(item.lifecycleEvent))continue;
            bump(id,{...(item.lifecycleEvent!=='missed'?{renewAfter:0,retryLeaseAfter:0,leaseEpoch:s.leaseEpoch+1}:{}),...(item.lifecycleEvent==='subscriptionRemoved'?{subscriptionId:null,expiresAt:0,status:'registering'}:{})});
          } else if(['created','updated','deleted'].includes(item.changeType))bump(id);
        }
      }
      // Acknowledge only after the encrypted pending revision is durable. Never await provider I/O here.
      respond(res,202,{accepted:true});queueMicrotask(tick);return true;
    },
    start(){
      if(!paused)return;
      paused=false;
      // Reconcile downtime immediately, retaining any already pending delivery.
      for(const service of ['gmail','outlook'])if(enabled(service))for(const id of store.accountsBySvc(service))
        update(id,s=>s && s.revision===s.processed?{...s,revision:s.revision+1}:null);
      tick();timer=setInterval(tick,1000);timer.unref?.();
    },
    pause(){paused=true;clearInterval(timer);},
    stop(){paused=true;clearInterval(timer);limits.clear();},
    async drain(){while(tasks.size)await Promise.allSettled([...tasks]);},
    tick,
  };
}
