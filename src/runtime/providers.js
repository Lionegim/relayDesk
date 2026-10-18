import { createGoogleOAuth } from '../providers/gmail/oauth.js';
import { createGmailSync } from '../providers/gmail/sync.js';
import { createGmailDisconnect } from '../providers/gmail/disconnect.js';
import { createGmailOutbox } from '../providers/gmail/outbox.js';
import { createMicrosoftOAuth } from '../providers/outlook/oauth.js';
import { createOutlookSync } from '../providers/outlook/sync.js';
import { createOutlookOutbox } from '../providers/outlook/outbox.js';
import { createOutlookDisconnect } from '../providers/outlook/disconnect.js';
import { createWhatsAppProvider } from '../providers/whatsapp/index.js';

export async function assembleProviders({config,store,vault,log}) {
  // Le mode de test ne construit aucun adaptateur réseau : ni import, ni OAuth, ni envoi ni reprise WhatsApp.
  if(!config.connectorsEnabled) return {providers:{},gmail:null,syncs:[]};
  const secret=config.secrets;
  const oauth=createGoogleOAuth({clientId:secret.GOOGLE_CLIENT_ID,clientSecret:secret.GOOGLE_CLIENT_SECRET});
  const sync=createGmailSync({store,vault,oauth,log});
  const gmail={oauth,sync,disconnect:createGmailDisconnect({store,vault,sync}),outbox:createGmailOutbox({store,sync,ownerName:config.ownerName}),redirectUri:config.googleRedirectUri};
  const microsoftOAuth=createMicrosoftOAuth({clientId:secret.MICROSOFT_CLIENT_ID,tenant:config.microsoftTenant});
  const outlookSync=createOutlookSync({store,vault,oauth:microsoftOAuth,log});
  const outlook={oauth:microsoftOAuth,sync:outlookSync,outbox:createOutlookOutbox({store,sync:outlookSync,ownerName:config.ownerName}),disconnect:createOutlookDisconnect({store,vault,sync:outlookSync}),redirectUri:config.microsoftRedirectUri};
  const whatsapp=await createWhatsAppProvider({store,vault,log});
  return {providers:{outlook,whatsapp},gmail,syncs:[sync,outlookSync,whatsapp.sync]};
}
