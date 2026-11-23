import { GoogleDesktopAuth } from "../integrations/google-auth.ts";

const root = "https://www.googleapis.com/auth";
export const gmailRead = `${root}/gmail.readonly`;
export const gmailSend = `${root}/gmail.send`;
export const gmailCompose = `${root}/gmail.compose`;
export const gmailAuth = new GoogleDesktopAuth("google-mail", [gmailRead], [gmailSend, gmailCompose]);
