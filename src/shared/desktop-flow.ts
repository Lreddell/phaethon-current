const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const id = new RegExp(`^${uuid}$`, "i");
const environment = new RegExp(`^(?:Default-)?${uuid}$`, "i");
const runPath = "ms-powerautomate:/console/flow/run";

export function desktopFlowIds(raw: string): { environmentId: string; workflowId: string } | null {
  if (raw.length > 512) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "ms-powerautomate:" || url.host || url.pathname !== "/console/flow/run" || url.hash) return null;
    const pairs = [...url.searchParams];
    if (pairs.length !== 2) return null;
    const environmentId = url.searchParams.get("environmentId");
    const workflowId = url.searchParams.get("workflowId");
    if (!environmentId || !workflowId || !environment.test(environmentId) || !id.test(workflowId)) return null;
    return { environmentId, workflowId };
  } catch {
    return null;
  }
}

export function desktopFlowRunUrl(environmentId: string, workflowId: string, runId: string): string {
  if (!environment.test(environmentId) || !id.test(workflowId) || !id.test(runId)) throw new Error("The Power Automate flow identifiers are invalid.");
  return `${runPath}?${new URLSearchParams({ environmentId, workflowId, runId })}`;
}
