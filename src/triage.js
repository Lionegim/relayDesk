// Triage par règles locales, sans appel IA. Renvoie le libellé affiché et la ligne d'explication.
export function triageEmail({ labels, headers }) {
  const bulk = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'].some(l => labels.has(l)) || !!headers['list-unsubscribe'];
  if (bulk) return { label: 'Newsletter', triage: 'Newsletter ou notification : classée automatiquement, aucune revue nécessaire.' };
  if (labels.has('IMPORTANT') && labels.has('UNREAD')) return { label: 'À traiter', triage: 'Marqué important par Gmail : à lire.' };
  return { label: 'Perso', triage: 'Message reçu : aucune action automatique.' };
}
