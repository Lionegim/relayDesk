// libsignal 6 journalise parfois l'objet SessionRecord, qui contient des clés privées.
// On conserve le diagnostic, mais jamais ses arguments. Le logger Baileys muet ne couvre pas ces console.*.
const installed = new WeakSet();
const sensitive = ['Closing session:', 'Opening session:', 'Removing old closed session:', 'Session already closed'];
export function redactSignalLogs(target = console) {
  if (installed.has(target)) return;
  installed.add(target);
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = target[method].bind(target);
    target[method] = (...args) => {
      if (typeof args[0] === 'string' && sensitive.some(prefix => args[0].startsWith(prefix))) {
        original('[WhatsApp Signal] Changement de session ; détails confidentiels masqués.');
      } else original(...args);
    };
  }
}
