import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGmailClient} from '../src/providers/gmail/api.js';
import {createGraphClient} from '../src/providers/outlook/api.js';
const json=x=>new Response(JSON.stringify(x),{status:200});
const oauth={refresh:async()=>({access_token:'synthetic-only',expires_in:3600})};
test('Google contacts pagination stays on People endpoint and reads structured contact fields',async()=>{
 const seen=[];const client=createGmailClient({refreshToken:'synthetic',oauth,fetchImpl:async(url,opts)=>{seen.push(String(url));assert.equal(opts.redirect,'error');return seen.length===1?json({connections:[{resourceName:'people/a',names:[{displayName:'A',givenName:'Alice',familyName:'Test'}],organizations:[{name:'Studio',department:'Design'}],addresses:[{formattedValue:'1 rue Test, Paris',streetAddress:'1 rue Test',city:'Paris',postalCode:'75001',country:'France'}],birthdays:[{date:{month:2,day:29}}],emailAddresses:[{value:'a@example.test'}],phoneNumbers:[{value:'06 12',canonicalForm:'+33612345678'}]}],nextPageToken:'second'}):json({connections:[{resourceName:'people/b',names:[{displayName:'B'}]}]});}});
 const r=await client.contacts();assert.equal(r.length,2);assert.equal(r[0].identities[1].value,'+33612345678');assert.equal(r[0].fields.find(f=>f.kind==='birthday').value,'--02-29');assert.equal(r[0].fields.find(f=>f.kind==='address').components[3],'Paris');assert.ok(seen.every(x=>new URL(x).host==='people.googleapis.com'));assert.equal(new URL(seen[1]).searchParams.get('pageToken'),'second');assert.equal(new URL(seen[0]).searchParams.get('sources'),'READ_SOURCE_TYPE_CONTACT');
});
test('Google repeated pagination and later page refusal fail without a partial result',async()=>{
 let n=0;const client=createGmailClient({refreshToken:'synthetic',oauth,fetchImpl:async()=>{n++;return json({connections:[],nextPageToken:'repeat'});}});await assert.rejects(client.contacts(),e=>e.code==='contacts_paging');assert.equal(n,2);
 let page=0;const denied=createGmailClient({refreshToken:'synthetic',oauth,fetchImpl:async()=>++page===1?json({connections:[],nextPageToken:'next'}):new Response('',{status:403})});await assert.rejects(denied.contacts(),e=>e.code==='contacts_provider');
});
test('Outlook reads default and nested contact folders; never sends token to off-domain paging URL',async()=>{
 const paths=[];const client=createGraphClient({refreshToken:'synthetic',oauth,fetchImpl:async url=>{const path=new URL(url).pathname;paths.push(path);return json(path==='/v1.0/me/contacts'?{value:[{id:'a',displayName:'A',givenName:'Alice',businessAddress:{street:'1 Test street',city:'Amsterdam',postalCode:'1000AA',countryOrRegion:'Netherlands'},jobTitle:'Designer',emailAddresses:[{address:'a@example.test'}]}]}:path==='/v1.0/me/contactFolders'?{value:[{id:'f'}]}:path==='/v1.0/me/contactFolders/f/contacts'?{value:[{id:'b',displayName:'B',mobilePhone:'+33612345678'}]}:{value:[]});}});
 const contacts=await client.contacts();assert.equal(contacts.length,2);assert.equal(contacts[0].fields.find(f=>f.kind==='address').components[3],'Amsterdam');assert.equal(contacts[0].fields.find(f=>f.kind==='jobTitle').value,'Designer');assert.ok(paths.includes('/v1.0/me/contactFolders/f/childFolders'));
 let calls=0;const hostile=createGraphClient({refreshToken:'synthetic',oauth,fetchImpl:async()=>{calls++;return json({value:[], '@odata.nextLink':'https://other.example.test/token-theft'});}});await assert.rejects(hostile.contacts(),/inattendu/);assert.equal(calls,1);
});

test('Outlook refreshes a cached mail token before reading newly authorized contacts',async()=>{
 let refreshes=0;const scopes=[];
 const client=createGraphClient({refreshToken:'synthetic',oauth:{refresh:async()=>({access_token:++refreshes===1?'mail-only':'contacts-granted',expires_in:3600})},fetchImpl:async(url,opts)=>{const path=new URL(url).pathname;scopes.push(opts.headers.authorization);if(path.endsWith('/me'))return json({mail:'owner@example.test'});assert.equal(opts.headers.authorization,'Bearer contacts-granted');return json({value:[]});}});
 await client.me();await client.contacts();assert.equal(refreshes,2);assert.equal(scopes[0],'Bearer mail-only');
});
