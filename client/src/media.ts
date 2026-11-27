let cachedStream: MediaStream | null = null
let inFlight: Promise<MediaStream> | null = null

export async function getSharedMediaStream(
  constraints: MediaStreamConstraints = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
  },
): Promise<MediaStream> {
  if (cachedStream) {
    const live = cachedStream.getTracks().some((t) => t.readyState === 'live')
    if (live) return cachedStream
  }
  if (inFlight) return inFlight
  inFlight = navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
    cachedStream = stream
    inFlight = null
    return stream
  }).catch((err) => {
    inFlight = null
    throw err
  })
  return inFlight
}

export function getCachedMediaStream(): MediaStream | null {
  return cachedStream
}
