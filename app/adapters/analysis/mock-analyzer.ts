import { maximumAnalysisItems, maximumEvidenceIds, type AnalysisDelta, type AnalysisKind, type AnalysisOperation, type AnalysisState, type AnalysisStatus } from '../../domain/analysis/contract.ts';
import { analysisPromptHash } from '../../domain/analysis/prompt.ts';
import { analysisSchemaHash } from '../../domain/analysis/schema.ts';
import type { TranscriptUtterance } from '../../domain/transcription/utterance.ts';

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s。、,.!?！？「」『』]/g, '').slice(0, 120);
}

function classify(text: string): { kind: AnalysisKind; status: AnalysisStatus } {
  if (/\?|？|質問|未解決/.test(text)) return { kind: 'question', status: 'open' };
  if (/決定|決め|採用|で進め|にしましょう/.test(text)) return { kind: 'decision', status: 'proposed' };
  if (/リスク|懸念|危険|問題/.test(text)) return { kind: 'risk', status: 'open' };
  if (/調査|確認|対応|実装|担当|TODO|やります/.test(text)) return { kind: 'action', status: 'open' };
  if (/依存|前提|必要/.test(text)) return { kind: 'dependency', status: 'open' };
  if (/根拠|理由|ため/.test(text)) return { kind: 'claim', status: 'proposed' };
  return { kind: 'topic', status: 'proposed' };
}

function titleFor(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 80);
}

function tempIdFor(id: string): string {
  let hash = 2_166_136_261;
  for (const character of id) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16_777_619); }
  return `u_${(hash >>> 0).toString(16).padStart(8, '0')}_${id.slice(-41)}`;
}

export function analyzeWithDeterministicMock(utterances: TranscriptUtterance[], state: AnalysisState): AnalysisDelta {
  const finals = utterances.filter((item) => item.phase === 'final').slice(-8);
  const operations: AnalysisOperation[] = [];
  const seen = new Set<string>();
  for (const utterance of finals) {
    const text = utterance.text.trim();
    if (!text) continue;
    const classified = classify(text);
    const key = `${classified.kind}:${normalize(text.replace(/^(?:訂正|撤回)[:：]?\s*/, ''))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const matching = state.items.find((item) => item.provenance === 'ai-suggested' && item.kind === classified.kind && normalize(item.title) === normalize(titleFor(text)));
    if (matching) {
      if (!matching.evidenceUtteranceIds.includes(utterance.id) && matching.evidenceUtteranceIds.length < maximumEvidenceIds) operations.push({ op: 'update', itemId: matching.id, title: null, detail: null, status: null, confidence: Math.max(matching.confidence, 0.72), addEvidenceUtteranceIds: [utterance.id], removeEvidenceUtteranceIds: [] });
      continue;
    }
    const retractTarget = /撤回/.test(text) ? [...state.items].reverse().find((item) => item.provenance === 'ai-suggested' && ['decision', 'claim', 'action'].includes(item.kind) && item.status !== 'withdrawn') : undefined;
    if (retractTarget) {
      if (retractTarget.evidenceUtteranceIds.length >= maximumEvidenceIds && !retractTarget.evidenceUtteranceIds.includes(utterance.id)) continue;
      operations.push({ op: 'retract', itemId: retractTarget.id, reason: text.slice(0, 260), evidenceUtteranceIds: [utterance.id] });
      continue;
    }
    const correctionTarget = /訂正|変更/.test(text) ? [...state.items].reverse().find((item) => item.provenance === 'ai-suggested' && item.kind === classified.kind && item.status !== 'withdrawn') : undefined;
    if (correctionTarget) {
      if (correctionTarget.evidenceUtteranceIds.length >= maximumEvidenceIds && !correctionTarget.evidenceUtteranceIds.includes(utterance.id)) continue;
      operations.push({ op: 'update', itemId: correctionTarget.id, title: titleFor(text), detail: text.slice(0, 500), status: classified.status, confidence: 0.84, addEvidenceUtteranceIds: [utterance.id], removeEvidenceUtteranceIds: [] });
      continue;
    }
    if (state.items.length + operations.filter((operation) => operation.op === 'add').length >= maximumAnalysisItems) continue;
    operations.push({ op: 'add', tempId: tempIdFor(utterance.id), kind: classified.kind, title: titleFor(text), detail: text.slice(0, 500), status: classified.status, confidence: 0.72, evidenceUtteranceIds: [utterance.id] });
  }
  return {
    contractVersion: 1,
    baseRevision: state.revision,
    deltaId: `mock_${state.revision}_${finals.map((item) => item.id).join('_')}`.slice(0, 80),
    model: 'deterministic-mock-v1', promptHash: analysisPromptHash, schemaHash: analysisSchemaHash, operations,
  };
}
