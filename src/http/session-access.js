import {createHash,randomBytes} from 'node:crypto';
import {HttpError} from './errors.js';
import {readComposeInput} from '../mail/input.js';

// Approbations d'envoi et états fournisseur restent propres à une session d'appareil.
// Aucun de ces tickets n'est conservé après redémarrage ou rejoué après un appel fournisseur.
export function createSessionAccess({clock=Date.now}={}) {
 const approvals=new Map(),oauth=new Map(),limits=new Map();
 const prune=map=>{for(const [key,value] of map) if(value.expires<=clock()) map.delete(key);};
 const bounded=(map,key,value)=>{prune(map);if(map.size>=1000) map.delete(map.keys().next().value);map.set(key,value);};
 const fingerprint=input=>createHash('sha256').update(JSON.stringify({...readComposeInput(input),attachmentId:input.attachmentId ?? null,replyTo:input.replyTo ?? null})).digest('hex');
 return {
  limit(session,path,method) {
   const sensitive=!['GET','HEAD'].includes(method) && /\/(send|whatsapp-reaction|links|start|disconnect)(\/|$)/.test(path);
   const key=`${session.id}:${sensitive?'sensitive':'api'}`;prune(limits);
   const entry=limits.get(key) || {count:0,expires:clock()+60000};
   if(++entry.count>(sensitive?20:240)) throw new HttpError(429,'Trop de demandes : patiente un instant.','rate_limited');
   bounded(limits,key,entry);
  },
  rememberPreview(session,id,input,preview) {
   const approvalToken=randomBytes(32).toString('base64url');
   bounded(approvals,approvalToken,{sessionId:session.id,id,digest:preview.digest,fingerprint:fingerprint(input),expires:clock()+300000});
   return {...preview,approvalToken};
  },
  consumePreview(session,id,input) {
   prune(approvals);const ticket=approvals.get(input.approvalToken);
   if(!ticket || ticket.sessionId!==session.id || ticket.id!==id || ticket.digest!==input.digest || ticket.fingerprint!==fingerprint(input)) throw new HttpError(409,'Vérifie à nouveau l’aperçu exact dans cette session avant d’envoyer.','session_approval_invalid');
   approvals.delete(input.approvalToken);
  },
  rememberOAuth(session,provider,location,context=null) {
   const state=new URL(location).searchParams.get('state');
   if(!state) throw new HttpError(500,'Connexion indisponible.','oauth_state_missing');
   bounded(oauth,`${provider}:${state}`,{sessionId:session.id,context,expires:clock()+600000});
  },
  consumeOAuth(session,provider,state) {
   prune(oauth);const key=`${provider}:${state}`,ticket=oauth.get(key);
   if(!ticket || ticket.sessionId!==session.id) throw new HttpError(403,'Cette connexion ne correspond pas à la session active.','oauth_session_invalid');
   oauth.delete(key);return ticket.context;
  },
 };
}
