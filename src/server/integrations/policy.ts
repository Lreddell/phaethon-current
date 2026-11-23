import { Refusal } from "../rpc/registry.ts";

/** Only application entry points may set the actor. Tool arguments never supply it. */
export type IntegrationActor = "user" | "agent" | "unattended";
export type IntegrationAction = "read" | "send" | "execute" | "modify" | "delete";

export function authorizeIntegration(action: IntegrationAction, actor: IntegrationActor, allowed: boolean): void {
  if (!allowed) throw new Refusal("This operation isn’t permitted for the selected account or space.");
  if (action !== "read" && actor !== "user") throw new Refusal("This action requires approval in Phaethon.");
}
