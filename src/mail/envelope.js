// Les mêmes destinataires explicites pour chaque fournisseur, sans entrée invalide ignorée silencieusement.
import { parseAddressList, MimeError } from './mime.js';
export function newEnvelope({ to, cc, subject }) {
  const seen = new Set();
  const unique = list => list.filter(a => !seen.has(a.email) && seen.add(a.email));
  const recipients = unique(parseAddressList(to, { strict: true }));
  if (!recipients.length) throw new MimeError('Indique au moins un destinataire valide.');
  return { to: recipients, cc: unique(parseAddressList(cc, { strict: true })), subject };
}
