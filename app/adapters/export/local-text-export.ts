type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }>;
};

export async function exportMermaidToUserSelectedPath(source: string): Promise<void> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (!picker) throw new Error('local-export-unsupported');
  const handle = await picker({
    suggestedName: 'techmap-discussion.mmd',
    types: [{ description: 'Mermaid diagram', accept: { 'text/plain': ['.mmd'] } }],
  });
  const writable = await handle.createWritable();
  try { await writable.write(source); await writable.close(); }
  catch (error) { await writable.abort().catch(() => undefined); throw error; }
}
