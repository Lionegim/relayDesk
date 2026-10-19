import {createHash} from 'node:crypto';
import {badRequest} from '../http/errors.js';
import {contactField,FIELD_KINDS} from './fields.js';
import {normalizeIdentity} from './identity.js';
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clean=v=>String(v??'').trim();
const unescape=v=>v.replace(/\\([nN,;\\])/g,(_,c)=>c.toLowerCase()==='n'?'\n':c);
const escape=v=>String(v).replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
function components(v){const parts=[];let part='';for(let i=0;i<v.length;i++){if(v[i]==='\\' && i+1<v.length){part+=v[i]+v[++i];}else if(v[i]===';'){parts.push(unescape(part));part='';}else part+=v[i];}parts.push(unescape(part));return parts;}
export function csvRows(text) {
 const first=text.split(/\r?\n/,1)[0],delimiter=['\t',';',','].sort((a,b)=>first.split(b).length-first.split(a).length)[0];
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted)quoted=false;else if(!cell)quoted=true;else throw badRequest('Guillemets CSV invalides.');}else if(!quoted&&(c===delimiter||c==='\n'||c==='\r')){row.push(cell);cell='';if(c!==delimiter){if(c==='\r'&&text[i+1]==='\n')i++;if(row.some(Boolean))rows.push(row);row=[];}}else cell+=c;if(cell.length>10000 || rows.length>2001 || row.length>100)throw badRequest('Fichier trop volumineux.');}
 if(quoted)throw badRequest('Guillemet CSV non fermé.');row.push(cell);if(row.some(Boolean))rows.push(row);return rows;
}
export function guessContactColumn(header){const h=header.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');if(/type|label/.test(h))return 'custom';if(/email|courriel/.test(h))return 'email';if(/phone|mobile|telephone|tel/.test(h))return 'phone';return ({name:'name',fullname:'name',displayname:'name',nomcomplet:'name',nom:'familyName',lastname:'familyName',surname:'familyName',firstname:'givenName',prenom:'givenName',givenname:'givenName',company:'organization',organisation:'organization',organization:'organization',jobtitle:'jobTitle',title:'jobTitle',poste:'jobTitle',birthday:'birthday',anniversaire:'birthday',address:'address',adresse:'address',website:'website',siteweb:'website',notes:'notes'})[h] || 'custom';}
export function parseContactFile({text,format,mapping}) {
 if(typeof text!=='string' || Buffer.byteLength(text)>2*1024*1024 || text.includes('\0'))throw badRequest('Fichier UTF-8 de 2 Mo maximum.');text=text.replace(/^\uFEFF/,'');
 const records=[];let columns=[],selected=[];
 function record(name,identities,fields,uid=''){
  const good=identities.map(x=>{const n=normalizeIdentity(x.kind,x.value);if(!n && x.kind!=='phone')throw badRequest(`Email invalide : ${x.value}.`);if(!n && (clean(x.value).length>254 || !/[0-9]/.test(x.value)))throw badRequest('Téléphone invalide.');return {kind:x.kind,value:n || clean(x.value)};});
  const standard=fields.filter(f=>clean(f.value)).map(f=>{const v=contactField(f,'file');return {kind:v.kind,label:v.label,type:v.type,value:v.value,...(v.components.length?{components:v.components}:{})};});
  name=clean(name)||standard.filter(f=>['givenName','familyName'].includes(f.kind)).map(f=>f.value).join(' ')||good[0]?.value;
  if(!name || name.length>200 || /[\r\n]/.test(name))throw badRequest('Chaque contact doit avoir un nom ou une identité.');
  if(good.length>100 || standard.length>100)throw badRequest('100 champs maximum par contact.');records.push({name,identities:good,fields:standard,...(uid?{uid}: {})});
 }
 if(format==='csv') {
  const rows=csvRows(text);if(rows.length<2)throw badRequest('Le CSV doit contenir un en-tête et des contacts.');columns=rows.shift().map(clean);if(columns.length>100 || columns.some(x=>!x))throw badRequest('En-têtes CSV manquants.');selected=columns.map((h,i)=>mapping?.[i]??guessContactColumn(h));
  if(selected.some(k=>!['name','email','phone','ignore',...FIELD_KINDS].includes(k)))throw badRequest('Correspondance CSV invalide.');
  for(const row of rows){if(row.length>columns.length)throw badRequest('Une ligne contient plus de colonnes que l’en-tête.');let name='';const identities=[],fields=[];row.forEach((raw,i)=>{const value=clean(raw),kind=selected[i];if(!value || kind==='ignore')return;if(kind==='name')name=value;else if(['email','phone'].includes(kind))for(const v of value.split(/\s*\|\s*/))identities.push({kind,value:v});else fields.push({kind,label:kind==='custom'?columns[i]:'',value});});record(name,identities,fields);}
 }else if(format==='vcf'){
  const lines=text.replace(/\r?\n[ \t]/g,'').split(/\r?\n/);let card=null,count=0;
  for(const line of lines){if(!line)continue;if(line==='BEGIN:VCARD'){if(card)throw badRequest('vCard imbriquée invalide.');card={name:'',identities:[],fields:[],uid:''};count++;if(count>2000)throw badRequest('2 000 contacts maximum.');continue;}if(line==='END:VCARD'){if(!card?.version)throw badRequest('vCard invalide.');record(card.name,card.identities,card.fields,card.uid);card=null;continue;}if(!card)throw badRequest('Fichier vCard invalide.');
   const i=line.indexOf(':');if(i<0)throw badRequest('Propriété vCard invalide.');const head=line.slice(0,i),key=head.split(';')[0].split('.').at(-1).toUpperCase(),raw=line.slice(i+1),value=unescape(raw);
   if(['PHOTO','LOGO','SOUND'].includes(key))continue;
   if(/ENCODING=/i.test(head))throw badRequest('Enregistre ce fichier en vCard 3/4 UTF-8, sans encodage quoted-printable.');
   if(key==='VERSION'){card.version=value;if(!['3.0','4.0'].includes(value))throw badRequest('vCard 3.0 ou 4.0 requise.');}
   else if(key==='FN')card.name=value;else if(key==='UID')card.uid=value;
   else if(['EMAIL','TEL'].includes(key))card.identities.push({kind:key==='EMAIL'?'email':'phone',value:value.replace(/^tel:/i,'')});
   else if(key==='N'){const parts=components(raw);if(parts[1])card.fields.push({kind:'givenName',value:parts[1]});if(parts[0])card.fields.push({kind:'familyName',value:parts[0]});for(const [i,kind] of [[2,'additionalName'],[3,'prefix'],[4,'suffix']])if(parts[i])card.fields.push({kind,value:parts[i]});}
   else if(key==='ADR'){const parts=components(raw);while(parts.length<7)parts.push('');card.fields.push({kind:'address',value:parts.filter(Boolean).join('\n'),components:parts});}
   else if(key==='NICKNAME')card.fields.push({kind:'nickname',value});
   else if(key==='ORG'){const parts=components(raw);if(parts[0])card.fields.push({kind:'organization',value:parts[0]});for(const value of parts.slice(1).filter(Boolean))card.fields.push({kind:'department',value});}
   else if(['TITLE','NOTE','URL','BDAY'].includes(key))card.fields.push({kind:({ORG:'organization',TITLE:'jobTitle',NOTE:'notes',URL:'website',BDAY:'birthday'})[key],value:key==='BDAY'?value.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3').replace(/^--(\d{2})(\d{2})$/,'--$1-$2'):value});
   else if(key.startsWith('X-RELAY-FIELD-')){try{const f=JSON.parse(Buffer.from(raw,'base64url').toString());card.fields.push(f);}catch{throw badRequest('Champ personnalisé vCard invalide.');}}
   else if(key.startsWith('X-')&&!['X-ABLABEL','X-ABUID'].includes(key))card.fields.push({kind:'custom',label:key.slice(2),value});
  }if(card)throw badRequest('vCard incomplète.');
 }else throw badRequest('Format CSV ou vCard requis.');
 if(!records.length || records.length>2000)throw badRequest('De 1 à 2 000 contacts par import.');const unique=[...new Map(records.map(r=>[digest(r),r])).values()];return {records:unique,columns,mapping:selected,duplicatesInFile:records.length-unique.length,fingerprint:digest(unique)};
}
export function exportVCard(people) {
 const fold=line=>{const out=[];let chunk='',size=0;for(const c of line){const bytes=Buffer.byteLength(c);if(size+bytes>75){out.push(chunk);chunk=' ';size=1;}chunk+=c;size+=bytes;}out.push(chunk);return out.join('\r\n');};
 return people.map(p=>{const fields=p.fields || [],get=k=>fields.filter(f=>f.kind===k).map(f=>f.value),lines=['BEGIN:VCARD','VERSION:4.0',`UID:urn:relay:${encodeURIComponent(p.id)}`,`FN:${escape(p.name)}`,`N:${escape(get('familyName')[0]||'')};${escape(get('givenName')[0]||'')};${escape(get('additionalName')[0]||'')};${escape(get('prefix')[0]||'')};${escape(get('suffix')[0]||'')}`];
 for(const i of p.identities || [])lines.push(i.kind==='email'?`EMAIL:${escape(i.value)}`:i.needsCountryCode?`TEL;VALUE=text:${escape(i.value)}`:`TEL;VALUE=uri:tel:${i.normalized}`);
 for(const f of fields){if(f.kind==='organization'){lines.push(`ORG:${escape(f.value)}${get('department').map(v=>';'+escape(v)).join('')}`);continue;}if(f.kind==='department'){if(!get('organization').length)lines.push(`ORG:;${escape(f.value)}`);continue;}const key=({nickname:'NICKNAME',organization:'ORG',jobTitle:'TITLE',birthday:'BDAY',website:'URL',notes:'NOTE'})[f.kind];if(key)lines.push(`${key}:${f.kind==='website'?f.value:escape(f.kind==='birthday'?(f.value.startsWith('--')?'--'+f.value.slice(2).replace(/-/g,''):f.value.replace(/-/g,'')):f.value)}`);else if(f.kind==='address')lines.push(`ADR:${Array.isArray(f.components)&&f.components.length===7?f.components.map(escape).join(';'):';;'+escape(f.value)+';;;;'}`);else if(f.kind==='custom')lines.push(`X-RELAY-FIELD-${lines.length}:${Buffer.from(JSON.stringify({kind:f.kind,label:f.label,type:f.type,value:f.value})).toString('base64url')}`);}
 if(!get('jobTitle').length && p.title)lines.push(`TITLE:${escape(p.title)}`);return [...lines,'END:VCARD'].map(fold).join('\r\n');}).join('\r\n')+'\r\n';
}
