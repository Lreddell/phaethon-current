import { useEffect, useState } from "react";
import { FieldError, cleanMessage } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { AppMark, MailMark, providerLabel } from "@/components/mail-mark";
import { SkeletonRows } from "@/components/skeletons";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  getShortcuts,
  cancelGraph,
  cancelGmail,
  connectGmail,
  connectGraph,
  disconnectGmail,
  disconnectGraph,
  gmailStatus,
  graphStatus,
  mailSettings,
  refreshAccounts,
  setAccountSpaces,
  setAllowedShortcuts,
  setConnector,
  setMailSettings,
  type MailAppView,
  type MailSettings,
  type MailView,
} from "@/features/life/api";
import { useNav } from "@/app/store";
import { cn } from "@/lib/utils";
import { EmptyRow, Loader, Row, SettingsGroup, SwitchRow, useLoad, type Loaded } from "../ui";
import { SmallSelect, SpaceSelect, SpacesPicker, useSpaceList, type SpaceLite } from "./shared";

/**
 * Settings › Mail & connectors: the mail apps Phaethon may talk to, which
 * space may use which account, how sending works, what mail teaches about
 * people, and the Shortcuts each space may run.
 */


const delayLabel = (s: number) => (s < 60 ? `${s} s` : `${s / 60} min`);

function GraphConnection({ app, onChanged }: { app: MailAppView; onChanged: () => Promise<void> }) {
  const local = useLoad(graphStatus, [], "mail:graph");
  const [clientId, setClientId] = useState("");
  const [pending, setPending] = useState<"signin" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = async (kind: "signin" | "disconnect", task: () => Promise<unknown>) => {
    setPending(kind);
    setError(null);
    try {
      await task();
      await Promise.all([local.reload(), onChanged()]);
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setPending(null);
    }
  };
  return (
    <div>
      <Row label={<span className="flex items-center gap-3"><AppMark app="graph" />Microsoft Graph</span>}
        description={app.reason ?? "Connects to Outlook or Microsoft 365 through Microsoft’s cloud."} />
      {local.data?.accounts.map((a) => (
        <Row key={a.key} label={a.name} description={`${a.email} · ${a.scopes.includes("Mail.Send") ? "Read and send" : "Read only"}${a.scopes.includes("Mail.ReadWrite") ? " · Save drafts" : ""}`}>
          <div className="flex flex-wrap justify-end gap-1">
            <Button size="xs" variant="outline" disabled={!!pending} onClick={() => void change("signin", () => connectGraph({ key: a.key, scope: "Mail.Read" }))}>Reconnect</Button>
            {!a.scopes.includes("Mail.Send") && <Button size="xs" variant="outline" disabled={!!pending} onClick={() => void change("signin", () => connectGraph({ key: a.key, scope: "Mail.Send" }))}>Enable sending</Button>}
            {!a.scopes.includes("Mail.ReadWrite") && <Button size="xs" variant="outline" disabled={!!pending} onClick={() => void change("signin", () => connectGraph({ key: a.key, scope: "Mail.ReadWrite" }))}>Enable mailbox drafts</Button>}
            <Button size="xs" variant="ghost" disabled={!!pending} onClick={() => void change("disconnect", () => disconnectGraph(a.key))}>Disconnect</Button>
          </div>
        </Row>
      ))}
      {local.data?.desktop ? (
        <Row label="Desktop application ID" description="Use a Microsoft Entra public desktop registration with the loopback redirect URI http://localhost/oauth/callback.">
          <Input aria-label="Microsoft application ID" size="compact" value={clientId} disabled={!!pending} onChange={(e) => setClientId(e.target.value)} />
          <Button size="xs" variant="outline" disabled={!!pending || !clientId.trim()} onClick={() => void change("signin", () => connectGraph({ clientId }))}>Connect</Button>
        </Row>
      ) : local.data ? <EmptyRow>Use the desktop app to sign in with Microsoft.</EmptyRow> : null}
      {pending === "signin" ? <Row label="Finish signing in in your browser"><Button size="xs" variant="outline" onClick={() => void cancelGraph()}>Cancel</Button></Row> : null}
      {error || local.error ? <FieldError className="px-3 py-2">{error ?? cleanMessage(local.error)}</FieldError> : null}
    </div>
  );
}

const sendScope = "https://www.googleapis.com/auth/gmail.send";
const draftsScope = "https://www.googleapis.com/auth/gmail.compose";

function GmailConnection({ app, onChanged }: { app: MailAppView; onChanged: () => Promise<void> }) {
  const local = useLoad(gmailStatus, [], "mail:gmail");
  const [pending, setPending] = useState<"sign-in" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = async (kind: NonNullable<typeof pending>, action: () => Promise<unknown>) => {
    setPending(kind);
    setError(null);
    try { await action(); await Promise.all([local.reload(), onChanged()]); }
    catch (reason) { setError(cleanMessage(reason)); }
    finally { setPending(null); }
  };
  const connect = (input: Parameters<typeof connectGmail>[0]) => change("sign-in", () => connectGmail(input));
  return <div>
    <Row label={<span className="flex items-center gap-3"><AppMark app="google-mail" />Gmail</span>}
      description={app.reason ?? "Connects directly to your mailbox through the Google Gmail API."} />
    {local.data?.accounts.map(({ key, email, scopes }) => <Row key={key} label={email} description={`${scopes.includes(sendScope) ? "Read and send" : "Read only"}${scopes.includes(draftsScope) ? " · Save drafts" : ""}`}>
      <div className="flex flex-wrap justify-end gap-1">
        <Button size="xs" variant="outline" disabled={!!pending} onClick={() => void connect({ key })}>Reconnect</Button>
        {!scopes.includes(sendScope) ? <Button size="xs" variant="outline" disabled={!!pending} onClick={() => void connect({ key, scope: sendScope })}>Enable sending</Button> : null}
        {!scopes.includes(draftsScope) ? <Button size="xs" variant="outline" disabled={!!pending} onClick={() => void connect({ key, scope: draftsScope })}>Enable mailbox drafts</Button> : null}
        <Button size="xs" variant="ghost" disabled={!!pending} onClick={() => void connect({ key, replaceClient: true })}>Replace client JSON</Button>
        <Button size="xs" variant="ghost" disabled={!!pending} onClick={() => void change("disconnect", () => disconnectGmail(key))}>Disconnect</Button>
      </div>
    </Row>)}
    {local.data?.desktop ? <Row label="Desktop OAuth client" description="Enable the Gmail API in Google Cloud and download a Desktop app OAuth client JSON. Test projects require a permitted test account.">
      <Button size="xs" variant="outline" disabled={!!pending} onClick={() => void connect({})}>Choose JSON and connect</Button>
    </Row> : local.data ? <EmptyRow>Use the desktop app to sign in to Gmail.</EmptyRow> : null}
    {pending === "sign-in" ? <Row label="Finish signing in in your browser"><Button size="xs" variant="outline" onClick={() => void cancelGmail()}>Cancel</Button></Row> : null}
    {error || local.error ? <FieldError className="px-3 py-2">{error ?? cleanMessage(local.error)}</FieldError> : null}
  </div>;
}

function ConnectorRow({ app, onChanged }: { app: MailAppView; onChanged: () => Promise<void> }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flip = async (on: boolean) => {
    setPending(on);
    setError(null);
    try {
      const r = await setConnector(app.app, on);
      await onChanged();
      if (on) toast.success(`${app.label} connected`, r.accounts.filter((a) => a.app === app.app).length ? undefined : "It has no accounts yet.");
    } catch (e) {
      const msg = cleanMessage(e);
      setError(msg);
      toast.error(on ? `Couldn’t connect ${app.label}` : `Couldn’t turn off ${app.label}`, msg);
    } finally {
      setPending(null);
    }
  };
  const id = `connector-${app.app}`;
  const checked = pending ?? app.enabled;
  return (
    <Row
      htmlFor={id}
      className={cn(!app.ok && !app.enabled && "opacity-60")}
      label={
        <span className="flex min-w-0 items-center gap-3">
          <AppMark app={app.app} className="size-6" />
          <span className="min-w-0 truncate">{app.label}</span>
        </span>
      }
      description={pending === true ? <span className="ms-9 block">Asking {app.label} for its accounts…</span> : !app.ok && app.reason ? <span className="ms-9 block">{app.reason}</span> : undefined}
      below={error ? <FieldError className="ms-9">{error}</FieldError> : undefined}
    >
      {pending !== null ? <Spinner size="sm" tone="muted" /> : null}
      <Switch id={id} checked={checked} disabled={pending !== null || (!app.ok && !app.enabled)} aria-busy={pending !== null || undefined} onCheckedChange={(v) => void flip(v)} />
    </Row>
  );
}

function AccountsGroup({ view, state, spaces }: { view: MailView; state: Loaded<MailView>; spaces: SpaceLite[] }) {
  const [refreshing, setRefreshing] = useState(false);
  const s = view.settings;
  const accounts = s.known.filter((a) => s.connectors[a.app] === true);
  const anyOn = view.apps.some((a) => a.enabled);
  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await refreshAccounts();
      await state.reload();
      if (r.errors.length) toast.error("Some accounts couldn’t be read", r.errors.map((e) => e.message).join(" "));
    } catch (e) {
      toast.error("Couldn’t refresh the accounts", cleanMessage(e));
    } finally {
      setRefreshing(false);
    }
  };
  const assign = async (key: string, next: string[]) => {
    const before = state.data;
    if (!before) return;
    state.setData({
      ...before,
      settings: {
        ...before.settings,
        access: { ...before.settings.access, [key]: next },
      },
    });
    try {
      const settings = await setAccountSpaces(key, next);
      state.setData({ ...before, settings });
    } catch (e) {
      state.setData(before);
      toast.error("Couldn’t change who uses that account", cleanMessage(e));
    }
  };
  return (
    <SettingsGroup
      label="Accounts"
      action={
        anyOn ? (
          <Button size="xs" variant="ghost" onClick={() => void refresh()} pending={refreshing}>
            <Icon icon={icons.sync} />
            Refresh
          </Button>
        ) : null
      }
    >
      {!anyOn ? (
        <EmptyRow>Turn on a mail app to see its accounts.</EmptyRow>
      ) : accounts.length === 0 ? (
        <EmptyRow>No accounts found in your mail apps.</EmptyRow>
      ) : (
        accounts.map((a) => {
          const reach = s.access[a.key] ?? [];
          return (
            <div key={a.key} className="flex min-h-12 items-center gap-3 py-1.5 ps-3 pe-2">
              <MailMark provider={a.provider} decorative={false} />
              <div className="flex min-w-0 flex-1 flex-col">
                <Truncate className="text-sm">{a.name}</Truncate>
                <Truncate className="text-muted-foreground text-xs">{a.emails.join(", ") || providerLabel(a.provider)}</Truncate>
                {reach.length ? null : <span className="text-subtle-foreground text-xs">No space can use this account</span>}
              </div>
              <SpacesPicker value={reach} spaces={spaces} label={`Spaces that may use ${a.name}`} onChange={(next) => void assign(a.key, next)} />
            </div>
          );
        })
      )}
    </SettingsGroup>
  );
}

function useMailSetting(state: Loaded<MailView>) {
  const [pending, setPending] = useState<string | null>(null);
  const save = async (key: keyof MailSettings, patch: Parameters<typeof setMailSettings>[0]) => {
    const before = state.data;
    if (!before) return;
    state.setData({ ...before, settings: { ...before.settings, ...patch } });
    setPending(key);
    try {
      const settings = await setMailSettings(patch);
      state.setData({ ...before, settings });
    } catch (e) {
      state.setData(before);
      toast.error("Couldn’t change that", cleanMessage(e));
    } finally {
      setPending(null);
    }
  };
  return { pending, save };
}

function ShortcutsGroup({ spaces }: { spaces: SpaceLite[] }) {
  const active = useNav((s) => s.activeSpace);
  const state = useLoad(() => getShortcuts(), [], "mail:shortcuts");
  const [space, setSpace] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const chosen = space ?? (spaces.some((s) => s.id === active) ? active : spaces[0]?.id) ?? null;
  useEffect(() => setQuery(""), [chosen]);
  const allowedMap = (state.data?.allowed && !Array.isArray(state.data.allowed) ? state.data.allowed : {}) as Record<string, string[]>;
  const allowed = chosen ? (allowedMap[chosen] ?? []) : [];
  const toggle = async (name: string, on: boolean) => {
    if (!chosen || !state.data) return;
    const before = state.data;
    const next = on ? [...allowed, name] : allowed.filter((n) => n !== name);
    state.setData({ ...before, allowed: { ...allowedMap, [chosen]: next } });
    setSaving(name);
    try {
      const r = await setAllowedShortcuts(chosen, next);
      state.setData({ ...before, allowed: r.allowed });
    } catch (e) {
      state.setData(before);
      toast.error("Couldn’t change that shortcut", cleanMessage(e));
    } finally {
      setSaving(null);
    }
  };
  return (
    <SettingsGroup
      label={
        <span className="inline-flex items-center gap-1.5">
          <AppMark app="shortcuts" className="size-4" />
          Shortcuts agents may run
        </span>
      }
      action={spaces.length ? <SpaceSelect value={chosen} onChange={setSpace} spaces={spaces} label="Space" className="h-7 w-36 sm:min-h-6" /> : null}>
      <Loader state={state} errorTitle="Couldn’t list your shortcuts" skeleton={<SkeletonRows count={3} className="px-3 py-2" />}>
        {(d) => {
          if (d.error && !d.names.length) return <EmptyRow>{d.error}</EmptyRow>;
          if (!d.names.length) return <EmptyRow>No shortcuts in the Shortcuts app.</EmptyRow>;
          if (!chosen) return <EmptyRow>Make a space first.</EmptyRow>;
          const q = query.trim().toLowerCase();
          // Ticked ones first, so what a space may run is visible without scrolling.
          const names = d.names.filter((n) => !q || n.toLowerCase().includes(q)).sort((a, b) => Number(allowed.includes(b)) - Number(allowed.includes(a)) || a.localeCompare(b));
          return (
            <>
              {d.names.length > 8 ? (
                <div className="relative px-3 py-2">
                  <Icon icon={icons.search} className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-5.5 z-10 size-3.5 text-muted-foreground" />
                  <Input size="sm" value={query} placeholder="Search shortcuts" aria-label="Search shortcuts" className="*:data-[slot=input]:ps-8" onChange={(e) => setQuery(e.target.value)} />
                </div>
              ) : null}
              <div className="max-h-80 divide-y overflow-y-auto">
                {names.map((n) => {
                  const id = `shortcut-${n}`;
                  return (
                    <label key={n} htmlFor={id} className="flex min-h-9 cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-accent">
                      <Checkbox id={id} checked={allowed.includes(n)} disabled={saving === n} onCheckedChange={(v) => void toggle(n, v === true)} />
                      <span className="min-w-0 flex-1 truncate text-sm">{n}</span>
                      {saving === n ? <Spinner size="sm" tone="muted" /> : null}
                    </label>
                  );
                })}
                {names.length === 0 ? <EmptyRow>No shortcut matches “{query.trim()}”.</EmptyRow> : null}
              </div>
            </>
          );
        }}
      </Loader>
    </SettingsGroup>
  );
}

export function MailSection() {
  const spaces = useSpaceList();
  const state = useLoad(mailSettings, [], "mail:settings");
  const { pending, save } = useMailSetting(state);
  return (
    <>
      <SettingsGroup label="Mail apps" action={<Button size="xs" variant="outline" onClick={() => void state.reload()}>Refresh providers</Button>}>
        <Loader state={state} errorTitle="Couldn’t read the mail settings" skeleton={<SkeletonRows count={2} className="px-3 py-2" />}>
          {(v) => (v.apps.length ? v.apps.map((a) => {
            if (a.app === "graph") return <GraphConnection key={a.app} app={a} onChanged={state.reload} />;
            if (a.app === "google-mail") return <GmailConnection key={a.app} app={a} onChanged={state.reload} />;
            return <ConnectorRow key={a.app} app={a} onChanged={state.reload} />;
          }) : <EmptyRow>No mail app can be used on this computer.</EmptyRow>)}
        </Loader>
      </SettingsGroup>

      {state.data ? (
        <>
          <AccountsGroup view={state.data} state={state} spaces={spaces} />

          <SettingsGroup label="Sending">
            <SwitchRow
              label="Allow sending after approval"
              description="Press Send on a draft to start the countdown."
              checked={state.data.settings.allowSend}
              pending={pending === "allowSend"}
              onCheckedChange={(v) => void save("allowSend", { allowSend: v })}
            />
            <Row label="Countdown before sending" className={cn(!state.data.settings.allowSend && "opacity-60")}>
              <SmallSelect
                value={String(state.data.settings.sendDelaySeconds)}
                label="Countdown before sending"
                className="w-28"
                disabled={!state.data.settings.allowSend || pending === "sendDelaySeconds"}
                options={(state.data.delays.includes(state.data.settings.sendDelaySeconds)
                  ? state.data.delays
                  : [...state.data.delays, state.data.settings.sendDelaySeconds].sort((a, b) => a - b)
                ).map((d) => ({
                  value: String(d),
                  label: delayLabel(d),
                }))}
                onChange={(v) => void save("sendDelaySeconds", { sendDelaySeconds: Number(v) })}
              />
            </Row>
          </SettingsGroup>

          <SettingsGroup label="People from mail">
            <SwitchRow
              label="Keep people’s email history"
              description="Reads senders, recipients and subjects, never message bodies."
              checked={state.data.settings.indexForPeople}
              pending={pending === "indexForPeople"}
              onCheckedChange={(v) => void save("indexForPeople", { indexForPeople: v })}
            />
            <SwitchRow
              label="Add people you write back and forth with"
              checked={state.data.settings.addPeopleFromMail}
              disabled={!state.data.settings.indexForPeople}
              pending={pending === "addPeopleFromMail"}
              onCheckedChange={(v) => void save("addPeopleFromMail", { addPeopleFromMail: v })}
            />
          </SettingsGroup>
        </>
      ) : null}

      <ShortcutsGroup spaces={spaces} />
    </>
  );
}
