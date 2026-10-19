// Secondary help: one-second mouse dwell, immediate keyboard focus, tap toggle.
export function installTooltips(doc=document) {
 let trigger=null,tip=null,timer=null,closing=null,previousDescription=null,pointerFocus=false;
 function close(){clearTimeout(timer);clearTimeout(closing);if(trigger && tip){if(previousDescription)trigger.setAttribute('aria-describedby',previousDescription);else trigger.removeAttribute('aria-describedby');trigger.setAttribute('aria-expanded','false');}tip?.remove();trigger=null;tip=null;}
 function position(){if(!tip || !trigger?.isConnected)return close();const r=trigger.getBoundingClientRect(),w=tip.offsetWidth,h=tip.offsetHeight;tip.style.left=Math.max(12,Math.min(innerWidth-w-12,r.left+r.width/2-w/2))+'px';tip.style.top=Math.max(12,r.bottom+h+16<innerHeight?r.bottom+8:r.top-h-8)+'px';}
 function open(el){if(trigger!==el)close();trigger=el;if(tip)return;clearTimeout(timer);previousDescription=el.getAttribute('aria-describedby');tip=doc.createElement('div');tip.id='relay-context-help';tip.className='context-tooltip';tip.role='tooltip';tip.textContent=el.dataset.tooltip;doc.body.appendChild(tip);el.setAttribute('aria-describedby',[previousDescription,tip.id].filter(Boolean).join(' '));el.setAttribute('aria-expanded','true');tip.addEventListener('pointerenter',()=>clearTimeout(closing));tip.addEventListener('pointerleave',()=>{closing=setTimeout(close,150);});position();}
 function schedule(el){if(trigger===el)return;close();trigger=el;timer=setTimeout(()=>{if(el.isConnected)open(el);},1000);}
 doc.addEventListener('pointerover',e=>{if(e.pointerType==='touch')return;const el=e.target.closest?.('[data-tooltip]');if(el && !el.contains(e.relatedTarget)){clearTimeout(closing);schedule(el);}});
 doc.addEventListener('pointerout',e=>{const el=e.target.closest?.('[data-tooltip]');if(el && !el.contains(e.relatedTarget)){clearTimeout(timer);closing=setTimeout(close,150);}});
 doc.addEventListener('pointerdown',()=>{pointerFocus=true;},true);
 doc.addEventListener('focusin',e=>{const el=e.target.closest?.('[data-tooltip]');if(el && !pointerFocus)open(el);});
 doc.addEventListener('focusout',e=>{if(trigger?.contains(e.target))close();});
 doc.addEventListener('click',e=>{const el=e.target.closest?.('[data-tooltip]');if(el){e.preventDefault();e.stopPropagation();if(trigger===el && tip && e.detail!==0)close();else open(el);}else if(!tip?.contains(e.target))close();},true);
 doc.addEventListener('keydown',e=>{pointerFocus=false;if(e.key==='Escape' && tip){e.preventDefault();close();}},true);
 const observer=new MutationObserver(()=>{if(trigger && (!trigger.isConnected || tip && trigger.dataset.tooltip!==tip.textContent))close();});observer.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-tooltip']});
 doc.addEventListener('scroll',close,true);globalThis.addEventListener('resize',close);return close;
}
