import {accountPolicy} from '../providers/account-policy.js';
import { createGoogleOAuth } from '../providers/gmail/oauth.js';
import { createGmailSync } from '../providers/gmail/sync.js';
import { createGmailDisconnect } from '../providers/gmail/disconnect.js';
import { createGmailOutbox } from '../providers/gmail/outbox.js';
import { createMicrosoftOAuth } from '../providers/outlook/oauth.js';
import { createOutlookSync } from '../providers/outlook/sync.js';
import { createOutlookOutbox } from '../providers/outlook/outbox.js';
import { createOutlookDisconnect } from '../providers/outlook/disconnect.js';
import { createWhatsAppProvider } from '../providers/whatsapp/index.js';
import {createMailPush} from '../mail/push.js';

export async function assembleProviders({config,store,vault,log,fetchImpl=globalThis.fetch}) {
  // Le mode de test ne construit aucun adaptateur réseau : ni import, ni OAuth, ni envoi ni reprise WhatsApp.
  if(!config.connectorsEnabled) return {providers:{},gmail:null,syncs:[]};
  const assertAccountAllowed=accountPolicy(config.allowedAccounts,{required:config.mode==='hosted'});
  const secret=config.secrets,web=config.mailOAuthMode==='web';
  let push;
  const oauth=createGoogleOAuth({clientId:web?secret.GOOGLE_WEB_CLIENT_ID:secret.GOOGLE_CLIENT_ID,clientSecret:web?secret.GOOGLE_WEB_CLIENT_SECRET:secret.GOOGLE_CLIENT_SECRET,mode:config.mailOAuthMode,redirectUri:config.googleRedirectUri,fetchImpl});
  const sync=createGmailSync({store,vault,oauth,log,fetchImpl,assertAccountAllowed,shouldPoll:id=>push?.shouldPoll('gmail',id) ?? true});
  const gmail={oauth,sync,disconnect:createGmailDisconnect({store,vault,sync,fetchImpl}),outbox:createGmailOutbox({store,sync,ownerName:config.ownerName}),redirectUri:config.googleRedirectUri};
  const microsoftOAuth=createMicrosoftOAuth({clientId:web?secret.MICROSOFT_WEB_CLIENT_ID:secret.MICROSOFT_CLIENT_ID,clientSecret:web?secret.MICROSOFT_WEB_CLIENT_SECRET:undefined,tenant:config.microsoftTenant,mode:config.mailOAuthMode,redirectUri:config.microsoftRedirectUri,fetchImpl});
  const outlookSync=createOutlookSync({store,vault,oauth:microsoftOAuth,log,fetchImpl,assertAccountAllowed,shouldPoll:id=>push?.shouldPoll('outlook',id) ?? true});
  const outlook={oauth:microsoftOAuth,sync:outlookSync,outbox:createOutlookOutbox({store,sync:outlookSync,ownerName:config.ownerName}),disconnect:createOutlookDisconnect({store,vault,sync:outlookSync}),redirectUri:config.microsoftRedirectUri};
  const whatsapp=await createWhatsAppProvider({store,vault,log,requireLinkedIdentity:config.mode==='hosted'});
  push=createMailPush({config,store,vault,providers:{gmail,outlook},log});
  return {providers:{outlook,whatsapp},gmail,push,syncs:[push,sync,outlookSync,whatsapp.sync]};
}
