import {randomUUID,createHash} from 'node:crypto';
import {badRequest,HttpError} from '../http/errors.js';
export const FIELD_KINDS=['displayName','givenName','familyName','additionalName','prefix','suffix','nickname','department','organization','jobTitle','birthday','address','website','notes','custom'];
export function contactField(input,source='manual') {
 if(!input || !FIELD_KINDS.includes(input.kind))throw badRequest('Champ contact invalide.');
 const type=input.kind==='custom'?(input.type || 'text'):input.kind==='birthday'?'date':input.kind==='website'?'url':'text';
 if(!['text','number','date','url','boolean'].includes(type))throw badRequest('Type de champ invalide.');
 const value=String(input.value ?? '').replace(/\r\n?/g,'\n').trim(),label=String(input.label || '').trim();
 if(!value || value.length>(input.kind==='notes'?5000:2000) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || label.length>80 || /[\r\n]/.test(label) || input.kind==='custom'&&!label)throw badRequest('Valeur ou libellé invalide.');
 if(input.kind==='displayName' && (value.length>200 || /[\r\n]/.test(value)))throw badRequest('Nom sur une ligne, 200 caractères maximum.');
 if(type==='url'){let u;try{u=new URL(value);}catch{}if(/[\r\n]/.test(value) || !u || !['http:','https:'].includes(u.protocol) || u.username || u.password)throw badRequest('Adresse web http(s) requise.');}
 if(type==='number' && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value))))throw badRequest('Nombre invalide.');
 if(type==='boolean' && !['true','false'].includes(value))throw badRequest('Utilise true ou false.');
 if(type==='date'){const match=/^(?:(\d{4})-|--)(\d{2})-(\d{2})$/.exec(value);if(!match)throw badRequest('Date au format AAAA-MM-JJ ou --MM-JJ.');const y=Number(match[1] || 2000),m=Number(match[2]),d=Number(match[3]),date=new Date(Date.UTC(y,m-1,d));if(date.getUTCFullYear()!==y || date.getUTCMonth()!==m-1 || date.getUTCDate()!==d)throw badRequest('Date invalide.');}
 const components=input.kind==='address'&&Array.isArray(input.components)?input.components:[];if(components.length && (components.length!==7 || components.some(x=>typeof x!=='string'||x.length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\r]/.test(x))))throw badRequest('Adresse structurée invalide.');
 return {id:randomUUID(),kind:input.kind,label,type,value,source,components};
}
export function createContactFields(db,changed) {
 const q=s=>db.prepare(s);
 return {
  list(ids){return ids.flatMap(id=>q('SELECT * FROM contact_fields WHERE contact_id=? ORDER BY rowid').all(id).map(f=>({...f,components:JSON.parse(f.components)})));},
  revision(ids){const anchors=ids.map(id=>q('SELECT c.id,c.external_id,c.name,a.identity FROM contacts c LEFT JOIN accounts a ON a.id=c.account_id WHERE c.id=?').get(id));return createHash('sha256').update(JSON.stringify([anchors,this.list(ids)])).digest('hex');},
  write(id,input,source='manual'){if(source==='manual' && q("SELECT count(*) n FROM contact_fields WHERE contact_id=? AND source='manual'").get(id).n>=100)throw badRequest('100 champs locaux maximum.');const field=contactField(input,source);q('INSERT INTO contact_fields VALUES(?,?,?,?,?,?,?,?)').run(field.id,id,field.kind,field.label,field.type,field.value,source,JSON.stringify(field.components));changed();return field;},
  replaceSource(id,fields,source){const valid=(fields || []).slice(0,100).map(f=>contactField(f,source));q('DELETE FROM contact_fields WHERE contact_id=? AND source=?').run(id,source);for(const f of valid)q('INSERT INTO contact_fields VALUES(?,?,?,?,?,?,?,?)').run(f.id,id,f.kind,f.label,f.type,f.value,source,JSON.stringify(f.components));},
  assert(ids,revision){if(typeof revision!=='string' || revision!==this.revision(ids))throw new HttpError(409,'La fiche a changé. Rouvre-la avant de modifier ses champs.','contact_changed');},
  update(ids,id,input){const old=q('SELECT * FROM contact_fields WHERE id=?').get(id);if(!old || !ids.includes(old.contact_id) || old.source!=='manual')throw badRequest('Champ modifiable introuvable.');const f=contactField(input);q('UPDATE contact_fields SET kind=?,label=?,type=?,value=?,components=? WHERE id=?').run(f.kind,f.label,f.type,f.value,JSON.stringify(f.components),id);changed();},
  remove(ids,id){const f=q('SELECT * FROM contact_fields WHERE id=?').get(id);if(!f || !ids.includes(f.contact_id) || f.source!=='manual')throw badRequest('Seuls les champs ajoutés ici peuvent être retirés.');q('DELETE FROM contact_fields WHERE id=?').run(id);changed();},
 };
}
