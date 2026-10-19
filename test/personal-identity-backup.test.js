import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const tool=fileURLToPath(new URL('../deploy/personal/identity-archive.mjs',import.meta.url));
const run=(mode,key,extra=[],input)=>spawnSync(process.execPath,[tool,mode,'--key-file',key,...extra],{input,maxBuffer:2*1024*1024});
test('identity backup : authenticated roundtrip, no overwrite, corrupt/wrong key emits no plaintext',t=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-id-backup-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const key=join(dir,'key'),wrong=join(dir,'wrong'),archive=join(dir,'dump.kcbak');
 writeFileSync(key,'12'.repeat(32));writeFileSync(wrong,'13'.repeat(32));
 const input=Buffer.from('Synthetic PostgreSQL dump, never actual credentials.\n'.repeat(100));
 let result=run('encrypt',key,['--out',archive],input);assert.equal(result.status,0,result.stderr.toString());
 assert.equal(statSync(archive).mode&0o777,0o400);const encrypted=readFileSync(archive);assert.equal(encrypted.includes(input.subarray(0,40)),false);
 assert.equal(run('verify',key,['--archive',archive]).status,0);
 result=run('decrypt',key,['--archive',archive]);assert.equal(result.status,0,result.stderr.toString());assert.deepEqual(result.stdout,input);
 assert.notEqual(run('encrypt',key,['--out',archive],Buffer.from('replacement')).status,0);assert.deepEqual(readFileSync(archive),encrypted);
 for(const mode of ['verify','decrypt']){result=run(mode,wrong,['--archive',archive]);assert.notEqual(result.status,0);assert.equal(result.stdout.length,0);}
 const broken=join(dir,'corrupt');encrypted[25]^=1;writeFileSync(broken,encrypted);
 for(const mode of ['verify','decrypt']){result=run(mode,key,['--archive',broken]);assert.notEqual(result.status,0);assert.equal(result.stdout.length,0);}
});
