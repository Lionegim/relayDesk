// Encrypted PostgreSQL dump transport. Decryption authenticates in container /tmp before stdout.
// Run in the operator container with /tmp mounted as tmpfs; never restore directly into the live DB.
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {readFileSync,createReadStream,createWriteStream,openSync,readSync,closeSync,statSync,appendFileSync,chmodSync,linkSync,unlinkSync,mkdtempSync,rmSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Writable} from 'node:stream';
import {join} from 'node:path';
const MAGIC=Buffer.from('RLYID01\n');
const args=process.argv.slice(2),mode=args.shift(),options={};
for(let i=0;i<args.length;i+=2){if(!['--key-file','--out','--archive'].includes(args[i])||!args[i+1])throw new Error('Invalid arguments');options[args[i]]=args[i+1];}
if(!['encrypt','verify','decrypt'].includes(mode)||!options['--key-file'])throw new Error('Mode and key file required');
const raw=readFileSync(options['--key-file'],'utf8').trim();if(!/^[a-f0-9]{64}$/i.test(raw))throw new Error('Invalid backup key');
const key=Buffer.from(raw,'hex');
if(mode==='encrypt'){
 const out=options['--out'];if(!out)throw new Error('Output required');
 const temp=out+'.'+randomBytes(8).toString('hex')+'.partial';
 try{
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce),dest=createWriteStream(temp,{flags:'wx',mode:0o600});
  dest.write(Buffer.concat([MAGIC,nonce]));await pipeline(process.stdin,cipher,dest);
  appendFileSync(temp,cipher.getAuthTag());chmodSync(temp,0o400);linkSync(temp,out);
 }finally{try{unlinkSync(temp);}catch{}}
}else{
 const path=options['--archive'];if(!path)throw new Error('Archive required');
 const size=statSync(path).size;if(size<36)throw new Error('Truncated archive');
 const fd=openSync(path,'r'),header=Buffer.alloc(20),tag=Buffer.alloc(16);
 try{readSync(fd,header,0,20,0);readSync(fd,tag,0,16,size-16);}finally{closeSync(fd);}
 if(!header.subarray(0,8).equals(MAGIC))throw new Error('Invalid archive');
 const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(8));decipher.setAuthTag(tag);
 const input=createReadStream(path,{start:20,end:size-17});
 if(mode==='verify')await pipeline(input,decipher,new Writable({write(chunk,enc,done){done();}}));
 else{
  const temp=mkdtempSync('/tmp/relay-identity-restore-'),plain=join(temp,'dump');
  try{await pipeline(input,decipher,createWriteStream(plain,{flags:'wx',mode:0o600}));await pipeline(createReadStream(plain),process.stdout);}
  finally{rmSync(temp,{recursive:true,force:true});}
 }
}
