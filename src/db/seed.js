// Premier démarrage : profils, et données d'exemple si `demo` est vrai.
import { PROFILES, FOLDERS, MESSAGES, CONTACTS } from '../demo-data.js';
import { transaction } from './index.js';

export function seedIfEmpty(db, { demo = true, seed = { PROFILES, FOLDERS, MESSAGES, CONTACTS } } = {}) {
  if (db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n) return;
  transaction(db, () => {
    const insProfile = db.prepare('INSERT INTO profiles (id, name, kind, initials, position) VALUES (?, ?, ?, ?, ?)');
    const insAccount = db.prepare('INSERT INTO accounts (profile_id, name, channel, svc, status, c, position) VALUES (?, ?, ?, ?, ?, ?, ?)');
    seed.PROFILES.forEach((p, i) => {
      insProfile.run(p.id, p.name, p.kind, p.initials, i);
      if (demo) p.accounts.forEach((a, j) => insAccount.run(p.id, a.name, a.channel, a.svc ?? null, a.status, a.c, j));
    });
    if (!demo) return;

    const insFolder = db.prepare('INSERT INTO folders (id, profile_id, name, parent_id, position) VALUES (?, ?, ?, ?, ?)');
    seed.FOLDERS.forEach((f, i) => insFolder.run(f.id, f.p, f.name, f.parent, i));

    const insMessage = db.prepare(`INSERT INTO messages (id, profile_id, from_name, initials, handle, channel, account, time_label, sort_at, unread, flagged,
      folder_id, label, subject, preview, body, triage, trail, message_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = Date.now();
    seed.MESSAGES.forEach((m, i) => insMessage.run(m.id, m.p, m.from, m.initials, m.handle, m.channel, m.account, m.time, now - i * 60000,
      +m.unread, +m.flagged, m.folderId, m.label, m.subject, m.preview, m.body, m.triage, JSON.stringify(m.trail), m.trail.length + 1));

    const insContact = db.prepare('INSERT INTO contacts (id, profile_id, name, title, freq, channels, last, groups, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    seed.CONTACTS.forEach(c => insContact.run(c.id, c.p, c.name, c.title, c.freq, JSON.stringify(c.ch), c.last, JSON.stringify(c.g), c.order));
  });
}
