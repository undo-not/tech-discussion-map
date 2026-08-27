export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

export function downmixAndResample48kStereoTo16kMono(input: Uint8Array): Uint8Array {
  if (input.byteLength === 0 || input.byteLength % 12 !== 0) {
    throw new Error('Remote PCM must contain complete 48 kHz stereo sample groups');
  }
  const source = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const output = new Uint8Array((input.byteLength / 12) * 2);
  const target = new DataView(output.buffer);
  for (let sourceOffset = 0, targetOffset = 0; sourceOffset < input.byteLength; sourceOffset += 12, targetOffset += 2) {
    let sum = 0;
    for (let frame = 0; frame < 3; frame += 1) {
      sum += source.getInt16(sourceOffset + frame * 4, true);
      sum += source.getInt16(sourceOffset + frame * 4 + 2, true);
    }
    target.setInt16(targetOffset, Math.max(-32768, Math.min(32767, Math.round(sum / 6))), true);
  }
  return output;
}
