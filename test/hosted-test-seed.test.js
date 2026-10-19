import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const script=new URL('../deploy/hosted-test/seed.mjs',import.meta.url);
const seed=dir=>spawnSync(process.execPath,[script.pathname,dir],{encoding:'utf8'});
test('hosted fixture seeds only synthetic conversations, no provider credentials; rerun leaves bytes untouched',()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-hosted-test-'));
 try {
  const first=seed(dir);assert.equal(first.status,0,first.stderr);
  const db=new DatabaseSync(join(dir,'relay.db'),{readOnly:true});
  try {
   assert.equal(db.prepare('SELECT COUNT(*) n FROM profiles').get().n,1);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,3);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM secrets').get().n,0);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM whatsapp_messages').get().n,0);
   for(const m of db.prepare('SELECT body FROM messages').all())assert.match(m.body,/generated for the hosted test/);
   for(const a of db.prepare('SELECT address,status FROM accounts').all()){
    assert.match(a.address,/@example\.invalid$|^\+33000000000$/);assert.equal(a.status,'Test — disconnected');
   }
  }finally {db.close();}
  const before=readFileSync(join(dir,'relay.db'));assert.notEqual(seed(dir).status,0);assert.deepEqual(readFileSync(join(dir,'relay.db')),before);
 }finally {rmSync(dir,{recursive:true});}
});
test('hosted fixture rejects any nonempty directory before creating a database or lock',()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-hosted-refuse-'));
 try {writeFileSync(join(dir,'keep'),'untouched');assert.notEqual(seed(dir).status,0);assert.deepEqual(readdirSync(dir),['keep']);assert.equal(readFileSync(join(dir,'keep'),'utf8'),'untouched');}
 finally {rmSync(dir,{recursive:true});}
});
