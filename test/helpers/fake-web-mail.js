// Autorités OAuth et API de courrier entièrement fictives. Aucune requête réseau réelle.
import {createHash,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {fakeGoogle} from './fake-google.js';
import {fakeMicrosoft,ALL_SCOPES} from '../outlook-helpers.js';
import {GMAIL_SCOPES} from '../../src/providers/gmail/oauth.js';

export function fakeWebMail() {
 const google=fakeGoogle(),microsoft=fakeMicrosoft({scope:ALL_SCOPES});microsoft.add({});
 const codes=new Map(),refresh=new Map(),access=new Map(),tokenCalls=[];
 let seq=0;const json=(body,status=200)=>new Response(JSON.stringify(body),{status});
 const api={google,microsoft,tokenCalls,beforeToken:null};
 api.grant=(provider,location,{email}={})=>{
  const params=new URL(location).searchParams,code=randomBytes(16).toString('hex');
  codes.set(code,{provider,clientId:params.get('client_id'),redirect:params.get('redirect_uri'),challenge:params.get('code_challenge'),email:email || (provider==='google'?'jh@gmail.com':'jh@outlook.fr')});
  return {code,state:params.get('state')};
 };
 api.fetch=async(url,init={})=>{
  const u=new URL(url),provider=u.host==='oauth2.googleapis.com'?'google':u.host==='login.microsoftonline.com'?'microsoft':null;
  if(provider) {
   const p=new URLSearchParams(String(init.body));tokenCalls.push({provider,...Object.fromEntries(p)});
   if(api.beforeToken) await api.beforeToken(provider,p);
   assert.equal(p.get('client_id'),`${provider}-web-client`);assert.equal(p.get('client_secret'),`${provider}-web-secret-fake`);
   let identity;
   if(p.get('grant_type')==='authorization_code') {
    const entry=codes.get(p.get('code'));codes.delete(p.get('code'));if(!entry || entry.provider!==provider)return json({error:'invalid_grant'},400);
    assert.equal(p.get('redirect_uri'),entry.redirect);assert.equal(p.get('client_id'),entry.clientId);
    assert.equal(createHash('sha256').update(p.get('code_verifier')).digest('base64url'),entry.challenge);
    identity={provider,email:entry.email};
   } else {
    identity=refresh.get(p.get('refresh_token'));if(!identity || identity.provider!==provider)return json({error:'invalid_grant'},400);
    refresh.delete(p.get('refresh_token'));
   }
   const rt=`fake-refresh-${++seq}`,at=`at-web-${seq}`;refresh.set(rt,identity);access.set(at,identity);
   return json({access_token:at,refresh_token:rt,expires_in:3600,scope:provider==='google'?Object.values(GMAIL_SCOPES).join(' '):ALL_SCOPES,id_token:'untrusted.ignored.in-web'});
  }
  const authorization=init.headers?.authorization || '',identity=access.get(authorization.replace(/^Bearer /,''));
  if(!identity) return json({},401);
  if(u.host==='gmail.googleapis.com' && identity.provider==='google') {
   if(u.pathname.endsWith('/profile'))return json({emailAddress:identity.email,historyId:'10'});
   return google.fetch(url,init);
  }
  if(u.host==='graph.microsoft.com' && identity.provider==='microsoft') {
   if(u.pathname==='/v1.0/me')return json({mail:identity.email,userPrincipalName:'sign-in@example.test'});
   return microsoft.fetch(url,init);
  }
  throw new Error('Destination inattendue dans le faux réseau');
 };
 return api;
}
