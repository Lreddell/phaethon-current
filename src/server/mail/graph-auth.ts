import { graphMailAuth, type GraphAccount as MicrosoftAccount, type GraphMailScope } from "../integrations/graph-auth.ts";

export type GraphScope = GraphMailScope;
export type GraphAccount = MicrosoftAccount<GraphMailScope>;
export const { accounts: graphAccounts, token: graphToken, connect: connectGraph, disconnect: disconnectGraph, cancel: cancelGraphSignIn } = graphMailAuth;
