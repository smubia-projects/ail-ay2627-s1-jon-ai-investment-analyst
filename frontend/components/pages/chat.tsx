"use client";

import { useMemo, useState } from "react";
import { Clipboard, Send, Sparkles, Trash2 } from "lucide-react";
import { apiPost, liveAiFallback } from "@/lib/api";
import { currentDcfResult, fingerprint, researchFingerprint } from "@/lib/research";
import type { ChatMessage, EvidenceChunk } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace";
import { Button, Card, Notice, PageHeader, TextArea } from "@/components/ui";

type PendingChat = { question: string; prompt: string; evidence: EvidenceChunk[]; inputHash: string };

export function ChatPage() {
  const { workspace, updateWorkspace } = useWorkspace();
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<PendingChat | null>(null);
  const [raw, setRaw] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const analyticsOnly = workspace.settings.mode === "Financial Analytics Only";
  const inputHash = researchFingerprint(workspace);
  const chunks = useMemo(() => workspace.documents.flatMap((document) => document.chunks.map((chunk, index) => ({
    ...chunk,
    document_identifier: chunk.document_identifier ?? document.identifier,
    document_name: chunk.document_name || document.name,
    chunk_id: chunk.chunk_id ?? fingerprint({ document: document.identifier, page: chunk.page, index, text: chunk.text })
  }))).slice(0, 500), [workspace.documents]);

  async function ask() {
    const requestedQuestion = question.trim();
    if (!requestedQuestion || loading || analyticsOnly || pending) return;
    setLoading(true); setError(""); setMessage("");
    try {
      const retrieved = chunks.length ? await apiPost<{ results: EvidenceChunk[] }>("/v1/retrieval/search", { query: requestedQuestion, chunks, limit: 6 }) : { results: [] };
      const response = await apiPost<{ prompt: string }>("/v1/chat/prompt", { question: requestedQuestion, evidence: retrieved.results, calculation_context: currentDcfResult(workspace) ?? {} });
      const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: requestedQuestion, citations: [], input_hash: inputHash, source_ids: retrieved.results.map((item) => item.chunk_id ?? "") };
      updateWorkspace((current) => ({ ...current, chats: [...current.chats, userMessage] }));
      setPending({ question: requestedQuestion, evidence: retrieved.results, prompt: response.prompt, inputHash });
      setQuestion("");
      setMessage("Prompt prepared. The imported answer will be validated only against this question and retrieved source set.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Prompt preparation failed."); }
    finally { setLoading(false); }
  }

  async function validate(rawOutput: string = raw, provenanceOverride?: string) {
    if (!pending || pending.inputHash !== inputHash || loading) return;
    setLoading(true); setError(""); setMessage("");
    try {
      const response = await apiPost<{ valid: boolean; parsed_output: { answer: string; citations: string[] } | null; errors: string[]; provenance: string }>("/v1/chat/validate", { raw_output: rawOutput, question: pending.question, evidence: pending.evidence });
      if (!response.valid || !response.parsed_output) { setError(response.errors.join(" ")); return; }
      const provenance = provenanceOverride ? `${provenanceOverride}; ${response.provenance.replace(/^Manual import with /, "")}` : response.provenance;
      const assistant: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: response.parsed_output.answer, citations: response.parsed_output.citations, provenance, input_hash: pending.inputHash, source_ids: pending.evidence.map((item) => item.chunk_id ?? "") };
      updateWorkspace((current) => ({ ...current, chats: [...current.chats, assistant] }));
      setPending(null); setRaw(""); setMessage("Answer saved after schema and citation-allowlist validation. Citation entailment still requires human review.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Response validation failed."); }
    finally { setLoading(false); }
  }

  // Live AI: send the same grounded prompt to the backend's OpenRouter route, then
  // run the reply through the existing schema + citation-allowlist validation.
  async function askAi() {
    if (!pending || pending.inputHash !== inputHash || loading || analyticsOnly) return;
    setLoading(true); setError(""); setMessage("");
    let generated: { output: string; model: string; provenance: string };
    try {
      generated = await apiPost<{ output: string; model: string; provenance: string }>("/v1/inference/generate", { prompt: pending.prompt, json_mode: true });
    } catch (reason) {
      setError(liveAiFallback(reason) ?? (reason instanceof Error ? reason.message : "Live AI request failed."));
      setLoading(false);
      return;
    }
    setRaw(generated.output);
    await validate(generated.output, `${generated.provenance}: ${generated.model}`);
  }

  async function copyPrompt() {
    if (!pending) return;
    try { await navigator.clipboard.writeText(pending.prompt); setMessage("Prompt copied."); }
    catch { setError("Clipboard access failed. Select the prompt manually."); }
  }

  const pendingStale = Boolean(pending && pending.inputHash !== inputHash);
  return <>
    <PageHeader kicker="Research chat" title="Ask the documents, not the void." description="Relevant passages are retrieved first. Manual responses must cite the exact retrieved document and page or explicitly identify missing evidence."/>
    {analyticsOnly && <Notice kind="warning">Research chat is disabled in Financial Analytics Only mode.</Notice>}
    <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
      <Card>
        <div className="flex items-center justify-between"><p className="eyebrow">Conversation</p>{workspace.chats.length > 0 && <Button variant="secondary" onClick={() => { updateWorkspace((current) => ({ ...current, chats: [] })); setPending(null); setRaw(""); }}><Trash2 size={14}/> Clear</Button>}</div>
        <div role="log" aria-live="polite" className="min-h-[420px] space-y-4">{workspace.chats.length === 0 && <div className="flex min-h-72 items-center justify-center text-center text-sm text-mist">No research questions yet.<br/>Process a document, then ask a source-grounded question.</div>}{workspace.chats.map((chat) => { const stale = Boolean(chat.input_hash && chat.input_hash !== inputHash); return <div key={chat.id} className={`max-w-[86%] border p-4 ${chat.role === "user" ? "ml-auto border-gold/40 bg-gold/5" : "border-line bg-ink"}`}><p className="text-[10px] font-bold uppercase tracking-wider text-mist">{chat.role}{chat.provenance ? ` · ${chat.provenance}` : ""}{stale ? " · stale snapshot" : ""}</p><p className="mt-2 text-sm leading-6">{chat.content}</p>{chat.citations.length > 0 && <p className="mt-3 text-xs text-teal">Sources: {chat.citations.join("; ")}</p>}</div>; })}</div>
        <div className="mt-4 flex gap-2"><input aria-label="Research question" maxLength={2000} disabled={loading || analyticsOnly || Boolean(pending)} className="field" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.repeat) { event.preventDefault(); void ask(); } }} placeholder={pending ? "Validate or cancel the pending answer first" : "What evidence explains the margin change?"}/><Button aria-label="Prepare research question" loading={loading} disabled={analyticsOnly || Boolean(pending)} onClick={ask}><Send size={15}/></Button></div>
      </Card>
      <div className="space-y-5">
        <Card><div className="flex items-center justify-between"><div><p className="eyebrow">Manual AI packet</p><h2 className="mt-1 text-xl font-semibold">Grounded prompt</h2></div><Button variant="secondary" disabled={!pending} onClick={copyPrompt}><Clipboard size={15}/> Copy</Button></div><TextArea label="Prompt" value={pending?.prompt ?? ""} readOnly className="mt-4 min-h-56 font-mono text-xs"/><TextArea label="Paste JSON response" value={raw} disabled={!pending} onChange={(event) => setRaw(event.target.value)} className="mt-3 min-h-40 font-mono text-xs"/><div className="mt-3 flex flex-wrap gap-2"><Button loading={loading} disabled={!pending || pendingStale || analyticsOnly} onClick={askAi}><Sparkles size={15}/> Ask AI</Button><Button variant="secondary" loading={loading} disabled={!raw.trim() || !pending || pendingStale || analyticsOnly} onClick={() => validate()}>Validate answer</Button></div>{pending && <Button variant="secondary" disabled={loading} className="mt-2" onClick={() => { setPending(null); setRaw(""); }}>Cancel packet</Button>}</Card>
        {pendingStale && <Notice kind="warning">Workspace data changed after this prompt was prepared. Cancel it and ask again.</Notice>}
        {pending && <Card><p className="eyebrow">Retrieved evidence</p><div className="mt-3 space-y-3">{pending.evidence.length === 0 ? <Notice kind="warning">No document passages were available. A valid response must set unsupported=true.</Notice> : pending.evidence.map((chunk) => <div key={chunk.chunk_id} className="border-l-2 border-teal pl-3"><p className="text-xs font-semibold">{chunk.document_name}, p. {chunk.page}</p><p className="mt-1 line-clamp-4 text-xs leading-5 text-mist">{chunk.text}</p></div>)}</div></Card>}
        {error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}
      </div>
    </div>
  </>;
}
