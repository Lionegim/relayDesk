// One bounded provider operation per account per tick. Live sync and sends share
// the provider queue, which is released between archive batches.
export function createHistoryWorker({store,providers,intervalMs=1000}) {
 let timer,paused=true;const running=new Map(),repo=store.history;
 async function step(job){const id=job.account_id,provider=providers[store.getAccount(id).svc];
  if(!provider?.sync?.historyPage || !repo.current(job)){repo.pause(id);return;}
  const generation=provider.sync.generation(id),guard=()=>!paused && repo.current(job) && provider.sync.generation(id)===generation;
  try {
   const ids=repo.pending(id);
   if(ids.length){await provider.sync.historyApply(id,ids,guard);if(guard())repo.applied(job,ids);}
   else if(!job.enumerated){const page=await provider.sync.historyPage(id,job.cursor?JSON.parse(job.cursor):null,guard);if(guard())repo.page(job,page);}
   else if(guard())repo.complete(job);
  }catch(error){if(guard()){if(['gone_cursor','archive_cursor_expired'].includes(error?.code))repo.restart(job);else repo.failed(job,error);}}
 }
 function tick(){if(paused)return;for(const job of repo.due()){if(running.has(job.account_id))continue;const pending=step(job).catch(()=>{if(repo.current(job))repo.failed(job,{});});running.set(job.account_id,pending);pending.finally(()=>running.delete(job.account_id));}}
 return {tick,start(){paused=false;tick();timer=setInterval(tick,intervalMs);timer.unref?.();},pause(){paused=true;clearInterval(timer);},async drain(){await Promise.allSettled([...running.values()]);},async stop(){this.pause();await this.drain();}};
}
