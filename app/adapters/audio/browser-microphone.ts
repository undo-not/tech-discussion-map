export type MicrophoneDevice = { deviceId: string; label: string };

export type MicrophoneCapture = {
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
};

export function isLoopbackRuntime(location: Pick<Location, 'protocol' | 'hostname'>): boolean {
  return location.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);
}

export async function listMicrophones(): Promise<MicrophoneDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `マイク ${index + 1}` }));
}

export async function startMicrophoneCapture(
  deviceId: string | undefined,
  onPcm: (samples: Int16Array) => void,
): Promise<MicrophoneCapture> {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    throw new Error('microphone-unsupported');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  const context = new AudioContext({ latencyHint: 'interactive' });
  try {
    await context.audioWorklet.addModule('/pcm-capture-worklet.js');
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'techmap-pcm-capture', {
      processorOptions: { targetSampleRate: 16_000, batchSamples: 3_200 },
    });
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onPcm(new Int16Array(event.data));
    source.connect(node);
    node.connect(context.destination);

    return {
      pause() { node.port.postMessage({ type: 'pause' }); },
      resume() { node.port.postMessage({ type: 'resume' }); },
      async stop() {
        node.port.postMessage({ type: 'stop' });
        node.disconnect();
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        await context.close();
      },
    };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    throw error;
  }
}
