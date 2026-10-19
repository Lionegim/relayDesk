import {createHash,randomUUID} from 'node:crypto';
import {badRequest,HttpError} from '../http/errors.js';
import {transaction} from '../db/index.js';
import {parseContactFile,exportVCard,csvRows,guessContactColumn} from './formats.js';
import {createContactFields} from './fields.js';
import {normalizeIdentity} from './identity.js';
export function createContactFiles(db,{people,unified,changed}) {
 const fields=createContactFields(db,changed),q=s=>db.prepare(s);
 const scope=p=>{if(!q('SELECT 1 FROM profiles WHERE id=?').get(p))throw badRequest('Choisis un profil pour importer.');};
 function exactExisting(profile,r) {
  if(!r.uid?.startsWith('urn:relay:'))return false;
  let id;try{id=decodeURIComponent(r.uid.slice(10));}catch{return false;}
  if(!q('SELECT 1 FROM contacts WHERE id=? AND profile_id=?').get(id,profile))return false;
  const canonical=x=>JSON.stringify({name:x.name,identities:x.identities.map(i=>JSON.stringify(i)).sort(),fields:x.fields.map(f=>JSON.stringify(f)).sort()});
  const current=parseContactFile({format:'vcf',text:exportVCard([people.detail(profile,id)])}).records[0];return canonical(current)===canonical(r);
 }
 function prepare(profile,input){scope(profile);const parsed=parseContactFile(input);const seen=q('SELECT imported FROM contact_file_imports WHERE profile_id=? AND fingerprint=?').get(profile,parsed.fingerprint);return {...parsed,alreadyImported:!!seen};}
 return {
  preview(profile,input){scope(profile);let p;try{p=prepare(profile,input);}catch(error){if(input?.format==='csv' && error.status===400 && typeof input.text==='string' && Buffer.byteLength(input.text)<=2*1024*1024){try{const rows=csvRows(input.text.replace(/^\uFEFF/,'')),columns=rows[0]?.map(x=>x.trim());if(columns?.length)return {error:error.message,columns,mapping:columns.map((h,i)=>input.mapping?.[i]??guessContactColumn(h)),total:rows.length-1,sample:[]};}catch{}}throw error;}return {fingerprint:p.fingerprint,total:p.records.length,duplicatesInFile:p.duplicatesInFile,alreadyImported:p.alreadyImported,columns:p.columns,mapping:p.mapping,sample:p.records.slice(0,5)};},
  commit(profile,input){const p=prepare(profile,input);if(input.fingerprint!==p.fingerprint)throw new HttpError(409,'Le fichier a changé : prépare de nouveau l’import.','import_changed');if(p.alreadyImported)return {imported:0,skipped:p.records.length,profileId:profile};let imported=0,skipped=0;
   transaction(db,()=>{for(const r of p.records){const key=createHash('sha256').update(JSON.stringify([profile,r])).digest('hex'),id='file-'+key.slice(0,32);if(q('SELECT 1 FROM contacts WHERE id=? AND profile_id=?').get(id,profile)){skipped++;continue;}
    if(exactExisting(profile,r)){skipped++;continue;}
    q("INSERT INTO contacts(id,profile_id,name,title,channels,position) VALUES(?,?,?,'','[]',(SELECT COALESCE(MAX(position),0)+1 FROM contacts))").run(id,profile,r.name);
    for(const i of r.identities)q('INSERT OR IGNORE INTO contact_identities VALUES(?,?,?,?,?)').run(id,i.kind,normalizeIdentity(i.kind,i.value) || 'unresolved:'+i.value,i.value,'manual');for(const f of r.fields)fields.write(id,f);
    imported++;}q('INSERT INTO contact_file_imports VALUES(?,?,?,?)').run(profile,p.fingerprint,new Date().toISOString(),imported);});changed();return {imported,skipped,profileId:profile};
  },
  create(profile,input){scope(profile);const name=String(input.name || '').trim();if(!name || name.length>200 || /[\r\n\u0000]/.test(name))throw badRequest('Nom requis (200 caractères maximum).');const id='local-'+randomUUID();q("INSERT INTO contacts(id,profile_id,name,title,channels,position) VALUES(?,?,?,'','[]',(SELECT COALESCE(MAX(position),0)+1 FROM contacts))").run(id,profile,name);changed();return people.detail(profile,id);},
  export(profile){if(profile!=='all')scope(profile);return exportVCard(profile==='all'?unified.list():people.list().filter(p=>p.p===profile));},
 };
}
