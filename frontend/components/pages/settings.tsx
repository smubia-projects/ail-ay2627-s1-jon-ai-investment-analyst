"use client";

import { useEffect, useRef, useState } from "react";
import { DatabaseZap, Download, RotateCcw, Upload } from "lucide-react";
import { apiGet, saveBlob } from "@/lib/api";
import { setRetentionPreference, useWorkspace } from "@/lib/workspace";
import { Button, Card, Notice, PageHeader, Select } from "@/components/ui";

export function SettingsPage() {
  const { workspace, updateWorkspace, setDocumentRetention, exportWorkspace, importWorkspace, resetWorkspace, persistenceStatus, persistenceMessage } = useWorkspace();
  const [health, setHealth] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number }>({});
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (navigator.storage?.estimate) void navigator.storage.estimate().then(setStorage).catch(() => undefined); }, [workspace.revision]);

  function exportData() {
    saveBlob(new Blob([exportWorkspace()], { type: "application/json" }), "equitylens-project.json");
    setMessage("Active project export created using the current document-retention policy.");
  }
  async function importData(file: File | undefined) {
    if (!file) return;
    setError(""); setMessage("");
    try { importWorkspace(await file.text()); setMessage("Project imported separately. Document-text persistence was disabled and must be reconfirmed locally."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Import failed."); }
    finally { if (fileRef.current) fileRef.current.value = ""; }
  }
  async function testBackend() {
    setLoading(true); setError(""); setHealth("");
    try { const result = await apiGet<{ status: string; inference_configured: boolean }>("/api/health"); setHealth(`Backend ${result.status}. External inference ${result.inference_configured ? "is configured" : "is not configured"}.`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Connection failed."); }
    finally { setLoading(false); }
  }
  async function setRetention(enabled: boolean) {
    if (enabled && !window.confirm("Persist extracted source text, evidence-bearing prompts, and related excerpts in IndexedDB on this browser? Do not enable this on a shared device.")) return;
    try { setRetentionPreference(enabled); } catch { setError("The browser could not persist the retention preference. Document retention was not changed."); return; }
    try {
      await setDocumentRetention(enabled);
      setMessage(enabled ? "Full local text retention enabled for browser projects." : "Text retention disabled. Source-derived text was removed from all in-memory projects and browser persistence.");
    } catch { setError("Sensitive browser data could not be rewritten safely. The opt-out remains active and stored workspace data was deleted where possible."); }
  }
  function reset() {
    if (!window.confirm("Reset this browser workspace to synthetic demo data? Export first if you need a backup.")) return;
    resetWorkspace(); setMessage("Workspace reset to synthetic demonstration data."); setError("");
  }
  const usage = storage.usage && storage.quota ? `${(storage.usage / 1_048_576).toFixed(1)} MB of ${(storage.quota / 1_048_576).toFixed(0)} MB browser quota in use` : "Browser quota estimate unavailable";

  return <>
    <PageHeader kicker="Settings" title="Control data retention and execution." description="The application is server-stateless. IndexedDB supports larger local workspaces, but browser storage is not a durable or regulated system of record."/>
    {(persistenceStatus === "error" || persistenceStatus === "local-only") && <Notice kind={persistenceStatus === "error" ? "error" : "warning"}>{persistenceMessage} Export a backup now.</Notice>}
    {error && <div className="mt-3"><Notice kind="error">{error}</Notice></div>}{message && <div className="mt-3"><Notice kind="success">{message}</Notice></div>}
    <div className="mt-5 grid gap-5 xl:grid-cols-2">
      <Card><p className="eyebrow">Analysis mode</p><h2 className="mt-1 text-xl font-semibold">AI execution policy</h2><div className="mt-5"><Select label="Operating mode" value={workspace.settings.mode} onChange={(event) => updateWorkspace((current) => ({ ...current, settings: { ...current.settings, mode: event.target.value as typeof current.settings.mode } }))}><option>Manual AI Mode</option><option>Financial Analytics Only</option><option>Configured External Inference</option></Select></div><div className="mt-4"><Notice kind="info">Financial Analytics Only disables agents and research chat. Configured inference works only when the operator sets an endpoint and model; no paid provider is assumed.</Notice></div><Button loading={loading} variant="secondary" className="mt-4" onClick={testBackend}><DatabaseZap size={15}/> Test Python backend</Button>{health && <div className="mt-3"><Notice kind="success">{health}</Notice></div>}</Card>
      <Card><p className="eyebrow">Privacy</p><h2 className="mt-1 text-xl font-semibold">Document text retention</h2><label className="mt-5 flex cursor-pointer items-start gap-3 border border-line bg-ink p-4"><input type="checkbox" className="mt-1 accent-[#45b6ad]" checked={workspace.settings.persistDocumentText} onChange={(event) => setRetention(event.target.checked)}/><span><span className="block font-semibold">Persist source-derived text in this browser</span><span className="mt-1 block text-xs leading-5 text-mist">Off by default. When off, chunks, excerpts, source-bearing agent packets, and research chat are excluded from persistent storage and exports. Uploaded files have no application-level server retention.</span></span></label><div className="mt-4"><Notice kind="warning">IndexedDB is local to this browser profile and can still be denied, evicted, or read by someone with access to the profile. Export is the recovery mechanism.</Notice></div><p className="mt-3 text-xs text-mist">{usage}</p></Card>
      <Card><p className="eyebrow">Portability</p><h2 className="mt-1 text-xl font-semibold">Export or import project</h2><p className="mt-3 text-sm text-mist">Export includes only the active project. Import creates a separate project, validates it, migrates legacy data, and cannot silently enable sensitive text retention.</p><div className="mt-5 flex flex-wrap gap-2"><Button onClick={exportData}><Download size={15}/> Export project JSON</Button><Button variant="secondary" onClick={() => fileRef.current?.click()}><Upload size={15}/> Import project JSON</Button></div><input ref={fileRef} aria-label="Import EquityLens project JSON" className="hidden" type="file" accept="application/json,.json" onChange={(event) => importData(event.target.files?.[0])}/></Card>
      <Card><p className="eyebrow">Recovery</p><h2 className="mt-1 text-xl font-semibold">Reset synthetic workspace</h2><p className="mt-3 text-sm text-mist">Reset replaces current browser state with the documented synthetic company. It does not affect Vercel or another browser.</p><Button variant="danger" className="mt-5" onClick={reset}><RotateCcw size={15}/> Reset workspace</Button></Card>
    </div>
  </>;
}
