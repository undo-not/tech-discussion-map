import type { AnalysisState } from '../analysis/contract.ts';

const kindLabels = {
  topic: '論点', claim: '主張', question: '質問', decision: '決定',
  action: 'Action', dependency: '依存', risk: 'リスク',
} as const;

function mermaidText(value: string, maximumLength = 160): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, maximumLength)
    .replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function analysisStateToMermaid(state: AnalysisState): string {
  const lines = ['flowchart LR'];
  if (state.items.length === 0) return `${lines[0]}\n  empty["分析項目なし"]\n`;

  const nodeIdByItemId = new Map(state.items.map((item, index) => [item.id, `n${index}`]));
  for (const [index, item] of state.items.entries()) {
    const label = mermaidText(`${kindLabels[item.kind]}・${item.status}: ${item.title}`);
    lines.push(`  n${index}["${label}"]`);
  }
  for (const [index, item] of state.items.entries()) {
    for (const link of item.links) {
      const target = nodeIdByItemId.get(link.targetId);
      if (target) lines.push(`  n${index} -->|${mermaidText(link.relation, 40)}| ${target}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
