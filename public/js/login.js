// Aucun paramètre de retour arbitraire ni code OAuth affiché ou journalisé.
if(new URLSearchParams(location.search).has('error')) document.getElementById('login-error').hidden=false;
fetch('/auth/session',{credentials:'same-origin',cache:'no-store'}).then(async response=>{
 if(!response.ok) return;
 const info=await response.json();
 if(info.authenticated || info.enabled===false) location.replace('/');
}).catch(()=>{});
