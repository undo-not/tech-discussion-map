type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }>;
};

export type UserSelectedTextFile = {
  suggestedName: string;
  description: string;
  accept: Record<string, string[]>;
  data: string;
};

export async function saveTextToUserSelectedPath(file: UserSelectedTextFile): Promise<void> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (!picker) throw new Error('local-export-unsupported');
  const handle = await picker({
    suggestedName: file.suggestedName,
    types: [{ description: file.description, accept: file.accept }],
  });
  const writable = await handle.createWritable();
  try { await writable.write(file.data); await writable.close(); }
  catch (error) { await writable.abort().catch(() => undefined); throw error; }
}
