"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Clipboard, Play, ShieldAlert, Sparkles, TriangleAlert } from "lucide-react";
import { apiPost, liveAiFallback } from "@/lib/api";
import { agentInputFingerprint, currentClaimAssessments, currentDcfResult, financialFingerprint, fingerprint, isAgentRunStale, researchFingerprint } from "@/lib/research";
import type { AgentRun, ClaimAssessment, EvidenceChunk } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace";
import { Button, Card, Field, Notice, PageHeader, Select, TextArea } from "@/components/ui";

const agents = ["Financial Analyst", "Valuation Analyst", "Risk Analyst", "Investment Committee Critic", "Evidence Verification Agent"] as const;
type AgentName = typeof agents[number];
type PromptPackage = {
  prompt: string;
  schema: Record<string, unknown>;
  prompt_version: string;
  prompt_hash: string;
  input_hash: string;
  source_ids: string[];
  assumptions: Record<string, unknown>;
  evidence?: EvidenceChunk[];
};
type ValidationResponse = { valid: boolean; schema_valid: boolean; parsed_output: Record<string, unknown> | null; errors: string[]; provenance: string };

const dependencies: Record<AgentName, AgentName[]> = {
  "Financial Analyst": [],
  "Valuation Analyst": ["Financial Analyst"],
  "Risk Analyst": ["Financial Analyst", "Valuation Analyst"],
  "Investment Committee Critic": ["Financial Analyst", "Valuation Analyst", "Risk Analyst"],
  "Evidence Verification Agent": ["Financial Analyst", "Valuation Analyst", "Risk Analyst", "Investment Committee Critic"]
};

function preparedChunks(workspace: ReturnType<typeof useWorkspace>["workspace"]): EvidenceChunk[] {
  return workspace.documents.flatMap((document) => document.chunks.map((chunk, index) => ({
    ...chunk,
    document_identifier: chunk.document_identifier ?? document.identifier,
    document_name: chunk.document_name || document.name,
    chunk_id: chunk.chunk_id ?? fingerprint({ document: document.identifier, page: chunk.page, index, text: chunk.text })
  }))).slice(0, 500);
}

export function AgentsPage() {
  const { workspace, updateWorkspace } = useWorkspace();
  const [selected, setSelected] = useState<AgentName>("Financial Analyst");
  const [packet, setPacket] = useState<PromptPackage | null>(null);
  const [raw, setRaw] = useState("");
  const [modelId, setModelId] = useState("External model (manual import)");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [generatedProvenance, setGeneratedProvenance] = useState<string | null>(null);
  const chunks = useMemo(() => preparedChunks(workspace), [workspace]);
  const currentInputHash = researchFingerprint(workspace);
  const selectedInputHash = agentInputFingerprint(workspace, dependencies[selected]);
  const analyticsOnly = workspace.settings.mode === "Financial Analytics Only";

  function changeAgent(agent: AgentName) {
    if (loading) return;
    setSelected(agent);
    setPacket(null);
    setRaw("");
    setGeneratedProvenance(null);
    setError("");
    setMessage("");
  }

  async function preparePrompt() {
    if (analyticsOnly || loading) return;
    const requestedAgent = selected;
    const missingDependency = dependencies[requestedAgent].find((name) => !workspace.agentRuns[name]?.valid || isAgentRunStale(workspace.agentRuns[name], workspace));
    if (missingDependency) { setError(`Run the current ${missingDependency} before preparing ${requestedAgent}.`); return; }
    const requestedHash = agentInputFingerprint(workspace, dependencies[requestedAgent]);
    setLoading(true); setError(""); setMessage("");
    try {
      let evidence: EvidenceChunk[] = [];
      if (chunks.length) {
        const query = requestedAgent === "Evidence Verification Agent" ? "verify factual claims revenue margin cash flow valuation risk recommendation" : `${requestedAgent} revenue margins cash flow valuation risks`;
        const retrieval = await apiPost<{ results: EvidenceChunk[] }>("/v1/retrieval/search", { query, chunks, limit: 20 });
        evidence = retrieval.results;
      }
      const prior = Object.fromEntries(dependencies[requestedAgent]
        .map((name) => [name, workspace.agentRuns[name]] as const)
        .filter(([, run]) => run?.valid && !isAgentRunStale(run, workspace) && run.parsed_output)
        .map(([name, run]) => [name, run!.parsed_output]));
      const parentRunIds = Object.fromEntries(dependencies[requestedAgent].map((name) => [name, workspace.agentRuns[name]?.id ?? null]));
      const response = await apiPost<PromptPackage>("/v1/prompts/agent", {
        agent_name: requestedAgent,
        evidence,
        verified_financials: { figures: workspace.figures, analysis: workspace.financialAnalysis?.input_hash === financialFingerprint(workspace.figures) ? workspace.financialAnalysis : null },
        valuation_results: currentDcfResult(workspace) ?? {},
        prior_outputs: prior,
        assumptions: { dcf_inputs: workspace.dcfInputs, workspace_fingerprint: currentInputHash, parent_run_ids: parentRunIds },
        client_input_hash: requestedHash
      });
      if (selected === requestedAgent && selectedInputHash === requestedHash) {
        setPacket({ ...response, evidence });
        setMessage(chunks.length ? `${evidence.length} source passages retrieved with immutable source IDs.` : "Prompt prepared without document evidence; it explicitly marks this limitation.");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Prompt preparation failed."); }
    finally { setLoading(false); }
  }

  async function validate() {
    if (!packet || packet.input_hash !== selectedInputHash || loading) return;
    const requestedAgent = selected;
    setLoading(true); setError(""); setMessage("");
    try {
      const response = await apiPost<ValidationResponse>("/v1/ai/validate", {
        agent_name: requestedAgent,
        raw_output: raw,
        prompt_hash: packet.prompt_hash,
        input_hash: packet.input_hash,
        prompt_version: packet.prompt_version,
        model_id: modelId
      });
      if (!response.valid || !response.parsed_output) { setError(response.errors.join(" ")); return; }
      let claimAssessments: ClaimAssessment[] | null = null;
      if (requestedAgent === "Evidence Verification Agent") {
        const proposed = response.parsed_output.assessments;
        if (!Array.isArray(proposed)) { setError("Evidence verifier output did not contain assessments."); return; }
        const verified = await apiPost<{ assessments: ClaimAssessment[] }>("/v1/evidence/verify", { assessments: proposed, evidence: packet.evidence ?? [], calculation_context: currentDcfResult(workspace) ?? {} });
        claimAssessments = verified.assessments;
      }
      const provenance = generatedProvenance ?? response.provenance;
      const run: AgentRun = {
        id: crypto.randomUUID(),
        agent_name: requestedAgent,
        prompt: packet.prompt,
        raw_output: raw,
        parsed_output: response.parsed_output,
        valid: true,
        schema_valid: response.schema_valid,
        errors: [],
        provenance,
        model_id: modelId,
        prompt_version: packet.prompt_version,
        prompt_hash: packet.prompt_hash,
        input_hash: packet.input_hash,
        source_ids: packet.source_ids,
        assumptions: packet.assumptions,
        created_at: new Date().toISOString()
      };
      updateWorkspace((current) => ({
        ...current,
        agentRuns: { ...current.agentRuns, [requestedAgent]: run },
        claimAssessments: claimAssessments ?? current.claimAssessments
      }));
      setMessage(`${requestedAgent} response is schema-valid and saved with provenance. ${claimAssessments ? "Citation and calculation checks were applied to every proposed claim." : "Run Evidence Verification next for claim-level support status."}`);
      setRaw(""); setGeneratedProvenance(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Validation failed."); }
    finally { setLoading(false); }
  }

  async function runConfiguredInference() {
    if (!packet || loading) return;
    setLoading(true); setError(""); setMessage("");
    try {
      const generated = await apiPost<{ output: string; model: string; provenance: string }>("/v1/inference/generate", { prompt: packet.prompt, json_mode: true });
      setRaw(generated.output); setModelId(generated.model); setGeneratedProvenance(`${generated.provenance}: ${generated.model}`); setMessage(`Response received from ${generated.model}. Validate it before saving.`);
    } catch (reason) { setError(liveAiFallback(reason) ?? (reason instanceof Error ? reason.message : "Live AI request failed.")); }
    finally { setLoading(false); }
  }

  async function copyPrompt() {
    if (!packet) return;
    try { await navigator.clipboard.writeText(packet.prompt); setMessage("Prompt copied."); }
    catch { setError("Clipboard access failed. Select the prompt text manually."); }
  }

  const packetStale = Boolean(packet && packet.input_hash !== selectedInputHash);
  const visibleClaims = currentClaimAssessments(workspace);

  return (
    <>
      <PageHeader kicker="AI research agents" title="Five mandates. One evidence standard." description="Four research agents form the analysis. The Evidence Verification Agent audits their factual claims, while Python checks source locators and deterministic calculations." />
      <Notice kind="info">Schema-valid means the JSON shape is accepted. It does not mean the claims are verified. Only claim cards below show evidence status.</Notice>
      {workspace.settings.mode === "Manual AI Mode" && <div className="mt-3"><Notice kind="info">Preparing a prompt has not contacted ChatGPT or any external model. You choose where to run it and paste the response back for validation.</Notice></div>}
      {analyticsOnly && <div className="mt-3"><Notice kind="warning">Financial Analytics Only mode disables narrative prompt generation and model-response import.</Notice></div>}
      <div className="mt-5 grid gap-5 xl:grid-cols-[0.7fr_1.3fr]">
        <Card>
          <Select label="Research agent" value={selected} disabled={loading} onChange={(event) => changeAgent(event.target.value as AgentName)}>{agents.map((agent) => <option key={agent}>{agent}</option>)}</Select>
          <div className="mt-5 space-y-3">
            {agents.map((agent, index) => {
              const run = workspace.agentRuns[agent];
              const stale = isAgentRunStale(run, workspace);
              return <button disabled={loading} key={agent} onClick={() => changeAgent(agent)} className={`flex w-full items-center gap-3 border p-3 text-left disabled:opacity-60 ${selected === agent ? "border-gold bg-gold/5" : "border-line"}`}><span className="flex h-7 w-7 items-center justify-center border border-line text-xs text-gold">0{index + 1}</span><span className="flex-1 text-sm font-semibold">{agent}</span>{run?.valid && !stale ? <CheckCircle2 size={16} className="text-teal"/> : stale ? <TriangleAlert size={16} className="text-gold"/> : <span className="text-[10px] uppercase text-mist">Pending</span>}</button>;
            })}
          </div>
          <Button loading={loading} disabled={analyticsOnly} className="mt-5 w-full" onClick={preparePrompt}><Play size={15}/> Prepare grounded prompt</Button>
          <p className="mt-3 text-xs leading-5 text-mist">Dependency order is enforced. Each packet records its source IDs, assumption snapshot, input fingerprint and prompt version.</p>
        </Card>
        <div className="space-y-5">
          <Card>
            <div className="flex items-center justify-between"><div><p className="eyebrow">Step 1</p><h2 className="mt-1 text-xl font-semibold">Copy specialized prompt</h2></div><Button variant="secondary" disabled={!packet} onClick={copyPrompt}><Clipboard size={15}/> Copy</Button></div>
            <TextArea label="Prompt" value={packet?.prompt ?? ""} readOnly className="mt-4 min-h-80 font-mono text-xs" />
            {packet && <p className="mt-2 break-all text-[10px] text-mist">{packet.prompt_version} · prompt {packet.prompt_hash.slice(0, 16)} · input {packet.input_hash}</p>}
            {!analyticsOnly && <div className="mt-3 flex flex-wrap items-center gap-3"><Button loading={loading} disabled={!packet || packetStale} onClick={runConfiguredInference}><Sparkles size={15}/> Run with live AI</Button><span className="text-xs text-mist">Or copy the prompt into any chat model and paste the JSON below.</span></div>}
          </Card>
          <Card>
            <p className="eyebrow">Step 2</p><h2 className="mt-1 text-xl font-semibold">Identify model, import and validate JSON</h2>
            <div className="mt-4"><Field label="Model identifier" value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="e.g. ChatGPT model shown by provider" /></div>
            <div className="mt-4"><TextArea label="External model response" value={raw} onChange={(event) => { setRaw(event.target.value); setGeneratedProvenance(null); }} placeholder="Paste the complete JSON object here" className="min-h-56 font-mono text-xs" /></div>
            <Button loading={loading} disabled={!raw.trim() || !packet || !modelId.trim() || packetStale || analyticsOnly} className="mt-3" onClick={validate}><ShieldAlert size={15}/> Validate and save</Button>
            {packetStale && <div className="mt-3"><Notice kind="warning">Underlying data changed after this prompt was prepared. Prepare a new packet before validation.</Notice></div>}
          </Card>
          {error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}
        </div>
      </div>

      <Card className="mt-5"><p className="eyebrow">Research record</p><h2 className="mt-1 text-xl font-semibold">Agent outputs and provenance</h2><div className="mt-4 grid gap-4 lg:grid-cols-2">{agents.map((agent) => {
        const run = workspace.agentRuns[agent];
        const stale = isAgentRunStale(run, workspace);
        return <div key={agent} className="border border-line p-4"><div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{agent}</h3><span className={`text-right text-[10px] font-bold uppercase ${run?.valid && !stale ? "text-teal" : stale ? "text-gold" : "text-mist"}`}>{stale ? "Stale" : run?.valid ? "Current" : "No result"}</span></div>{run?.parsed_output ? <><p className="mt-2 text-[10px] text-mist">{run.model_id} · {run.prompt_version} · {run.created_at.slice(0, 10)}</p><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-300">{JSON.stringify(run.parsed_output, null, 2)}</pre></> : <p className="mt-3 text-sm text-mist">Prepare a prompt and import a valid response.</p>}</div>;
      })}</div></Card>

      <Card className="mt-5"><p className="eyebrow">Claim ledger</p><h2 className="mt-1 text-xl font-semibold">Evidence verification results</h2>{visibleClaims.length === 0 ? <p className="mt-4 text-sm text-mist">Run the Evidence Verification Agent after the four core agents. No stale claims are treated as verified.</p> : <div className="mt-4 space-y-3">{visibleClaims.map((assessment) => <div key={assessment.claim_id} className="border border-line p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{assessment.claim}</p><span className={`text-xs font-bold uppercase ${assessment.status === "verified" ? "text-teal" : assessment.status === "contradicted" ? "text-red-300" : "text-gold"}`}>{assessment.status.replaceAll("_", " ")}</span></div><p className="mt-2 text-sm text-mist">{assessment.rationale}</p>{assessment.citations.map((citation) => <blockquote key={`${assessment.claim_id}-${citation.source_id}`} className="mt-3 border-l-2 border-teal pl-3 text-xs"><span className="font-semibold text-teal">{citation.document_name}, p. {citation.page ?? "n/a"}</span><span className="mt-1 block text-slate-300">“{citation.excerpt}”</span></blockquote>)}{assessment.checks.map((check) => <p key={check} className="mt-2 text-[11px] text-mist">{check}</p>)}{assessment.human_review_required && <p className="mt-2 text-[11px] font-semibold text-gold">Semantic human review required.</p>}</div>)}</div>}</Card>
    </>
  );
}
