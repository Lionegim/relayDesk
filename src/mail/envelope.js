// Les mêmes destinataires explicites pour chaque fournisseur, sans entrée invalide ignorée silencieusement.
import { parseAddressList, MimeError } from './mime.js';
export function newEnvelope({ to, cc, subject }) {
  const seen = new Set();
  const unique = list => list.filter(a => !seen.has(a.email) && seen.add(a.email));
  const recipients = unique(parseAddressList(to, { strict: true }));
  if (!recipients.length) throw new MimeError('Indique au moins un destinataire valide.');
  return { to: recipients, cc: unique(parseAddressList(cc, { strict: true })), subject };
}

// Pendant la saisie mobile, un destinataire incomplet reste un brouillon Relay Desk.
// L’aperçu continue à valider strictement toutes les adresses avant un envoi.
export function draftRecipientsReady({mode,to,cc}) {
 if(!['new','forward'].includes(mode)) return true;
 try {return newEnvelope({to,cc:mode==='new'?cc:null,subject:''}).to.length>0;}
 catch(error) {if(error instanceof MimeError) return false;throw error;}
}
