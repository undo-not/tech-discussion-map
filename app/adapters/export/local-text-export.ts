import { saveTextToUserSelectedPath } from './local-file-picker.ts';

export async function exportMermaidToUserSelectedPath(source: string): Promise<void> {
  await saveTextToUserSelectedPath({
    suggestedName: 'techmap-discussion.mmd',
    description: 'Mermaid diagram',
    accept: { 'text/plain': ['.mmd'] },
    data: source,
  });
}
