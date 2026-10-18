// Contrat de rédaction commun à tous les fournisseurs.
import { badRequest } from '../http/errors.js';
const MODES = ['reply', 'replyAll', 'forward', 'new'];
const MAX_TEXT = 20000;
const MAX_TO = 2000;
export function readComposeInput(body) {
  const { text, mode = 'reply', to = null, cc = null, subject = '' } = body || {};
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw badRequest('Texte invalide');
  if (!MODES.includes(mode)) throw badRequest('Mode de réponse invalide');
  if (to !== null && (typeof to !== 'string' || to.length > MAX_TO || /[\r\n\0]/.test(to))) throw badRequest('Destinataires invalides');
  if (cc !== null && (typeof cc !== 'string' || cc.length > MAX_TO || /[\r\n\0]/.test(cc))) throw badRequest('Copies invalides');
  if (typeof subject !== 'string' || subject.length > 998 || /[\r\n\0]/.test(subject)) throw badRequest('Objet invalide');
  return { text, mode, to: ['forward', 'new'].includes(mode) ? (to || '') : null, ...(mode === 'new' ? { cc: cc || '', subject } : {}) };
}

