import { useState, useEffect, useRef, useCallback, useMemo, Component, type ReactNode } from 'react'
import {
  Mic, MicOff, Video, VideoOff, PhoneOff, Phone, Loader2, PawPrint,
  WifiOff, AlertTriangle, SwitchCamera, RotateCcw, Volume2,
} from 'lucide-react'
import {
  Room, RoomEvent, Track, RemoteParticipant,
  type RemoteTrackPublication, VideoPresets,
  type DataPublishOptions,
} from 'livekit-client'
import {
  bootstrapAuth,
  detectRole,
  localStorageTokenStore,
  recoverStationToken,
  type Role,
} from './authBootstrap'
import { getSharedMediaStream } from './media'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100dvh', background: '#0c0c14', color: '#e8e8ef', padding: '2rem', textAlign: 'center', fontFamily: 'system-ui' }}>
          <AlertTriangle style={{ width: 48, height: 48, color: '#ef4444', marginBottom: 16 }} />
          <h2 style={{ fontSize: '1.25rem', fontWeight: 500, marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ color: '#a0a0b0', fontSize: '0.875rem', marginBottom: 16, maxWidth: 300 }}>{this.state.error.message}</p>
          <button onClick={() => location.reload()} style={{ background: '#22c55e', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 24px', fontSize: '0.875rem', cursor: 'pointer' }}>Reload</button>
        </div>
      )
    }
    return this.props.children
  }
}

type CallState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected' }
  | { status: 'reconnecting' }
  | { status: 'offline' }
  | { status: 'error'; message: string }

type CamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'

type PermissionState = 'granted' | 'denied' | 'prompt'

interface MediaControls {
  micOn: boolean
  camOn: boolean
  facingMode: 'user' | 'environment'
}

interface RemoteParticipantInfo {
  identity: string
  hasVideo: boolean
  hasAudio: boolean
}

interface TileCaller {
  id: string
  isLocal: boolean
}

const LIVEKIT_ROOM = 'marshallcam'
const DEFAULT_APP_NAME = 'MarshallCam'
const DEFAULT_TAGLINE = 'Two-way video intercom'

function playSqueakyToy() {
  try {
    const ctx = new AudioContext()
    const now = ctx.currentTime
    const osc1 = ctx.createOscillator()
    const osc2 = ctx.createOscillator()
    const gain = ctx.createGain()
    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(2800, now)
    osc1.frequency.exponentialRampToValueAtTime(4500, now + 0.05)
    osc1.frequency.exponentialRampToValueAtTime(3000, now + 0.12)
    osc1.frequency.exponentialRampToValueAtTime(4200, now + 0.18)
    osc1.frequency.exponentialRampToValueAtTime(2200, now + 0.28)
    osc2.type = 'square'
    osc2.frequency.setValueAtTime(3200, now)
    osc2.frequency.exponentialRampToValueAtTime(5000, now + 0.06)
    osc2.frequency.exponentialRampToValueAtTime(2800, now + 0.2)
    gain.gain.setValueAtTime(0.35, now)
    gain.gain.exponentialRampToValueAtTime(0.5, now + 0.04)
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.15)
    gain.gain.exponentialRampToValueAtTime(0.4, now + 0.17)
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3)
    osc1.connect(gain).connect(ctx.destination)
    osc2.connect(gain)
    osc1.start(now)
    osc1.stop(now + 0.35)
    osc2.start(now)
    osc2.stop(now + 0.35)
    setTimeout(() => ctx.close(), 500)
  } catch (e) {
    console.warn('[MarshallCam] squeaky toy failed:', e)
  }
}

const SQUEAK_DATA = new TextEncoder().encode(JSON.stringify({ type: 'squeak' }))

async function publishCachedMedia(room: Room, video: MediaTrackConstraints | boolean = true): Promise<void> {
  const stream = await getSharedMediaStream({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video,
  })
  const pubVideo = room.localParticipant.getTrackPublication(Track.Source.Camera)
  const pubMic = room.localParticipant.getTrackPublication(Track.Source.Microphone)
  const videoTrack = stream.getVideoTracks()[0]
  const audioTrack = stream.getAudioTracks()[0]
  if (videoTrack && !pubVideo?.track) {
    await room.localParticipant.publishTrack(videoTrack, { source: Track.Source.Camera })
  }
  if (audioTrack && !pubMic?.track) {
    await room.localParticipant.publishTrack(audioTrack, { source: Track.Source.Microphone })
  }
}

async function fetchLiveKitToken(
  authToken: string,
  identity: string,
  opts?: { role?: Role; onToken?: (token: string) => void },
): Promise<{ token: string; url: string; iceServers: RTCIceServer[] }> {
  let current = authToken
  const request = async (token: string) => {
    const r = await fetch(`/livekit-token?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ room: LIVEKIT_ROOM, identity }),
    })
    return r
  }
  let r = await request(current)
  if (r.status === 401 && opts?.role === 'station') {
    const next = await recoverStationToken(fetch, localStorageTokenStore)
    if (next) {
      current = next
      opts.onToken?.(next)
      r = await request(current)
    }
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`Auth failed (${r.status}): ${text}`)
  }
  return r.json()
}

function attachAudioTrack(track: Track, label: string) {
  try {
    const audioEl = track.attach() as HTMLAudioElement
    audioEl.autoplay = true
    audioEl.style.display = 'none'
    document.body.appendChild(audioEl)
    audioEl.play().catch(() => {
      console.warn(`[MarshallCam] ${label}: audio autoplay blocked, will play on user interaction`)
      const resume = () => {
        audioEl.play().catch(() => {})
        document.removeEventListener('click', resume)
        document.removeEventListener('touchstart', resume)
      }
      document.addEventListener('click', resume, { once: true })
      document.addEventListener('touchstart', resume, { once: true })
    })
    console.log(`[MarshallCam] ${label}: audio element created and playing`)
  } catch (e) {
    console.warn(`[MarshallCam] ${label}: audio attach failed:`, e)
  }
}

function useLiveKitRoom(authToken: string, identity: string, publishMedia: boolean, autoConnect: boolean = false) {
  const roomRef = useRef<Room | null>(null)
  const intentionalDisconnectRef = useRef(false)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [camStatus, setCamStatus] = useState<CamStatus>(autoConnect ? 'connecting' : 'offline')
  const [callState, setCallState] = useState<CallState>(autoConnect ? { status: 'connecting' } : { status: 'idle' })
  const [controls, setControls] = useState<MediaControls>({ micOn: false, camOn: false, facingMode: 'user' })
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const [micPerm, setMicPerm] = useState<PermissionState>('prompt')
  const [camPerm, setCamPerm] = useState<PermissionState>('prompt')
  const [remoteParticipants, setRemoteParticipants] = useState<RemoteParticipantInfo[]>([])
  const [tileCallers, setTileCallers] = useState<TileCaller[]>([])

  const cleanup = useCallback(() => {
    intentionalDisconnectRef.current = true
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    const room = roomRef.current
    if (room) {
      document.querySelectorAll('audio').forEach(el => {
        if (el.closest('body') && el.style.display === 'none') {
          try { el.remove() } catch {}
        }
      })
      room.disconnect()
      roomRef.current = null
    }
    if (remoteVideoRef.current) {
      try { remoteVideoRef.current.srcObject = null } catch {}
    }
    setCallState({ status: 'idle' })
    setCamStatus('offline')
    setRemoteParticipants([])
    setTileCallers([])
    setControls({ micOn: false, camOn: false, facingMode: 'user' })
    setMicPerm('prompt')
    setCamPerm('prompt')
    document.querySelectorAll('[id^="caller-vid-"]').forEach(el => {
      try { (el as HTMLVideoElement).srcObject = null } catch {}
    })
  }, [])

  const connect = useCallback(async () => {
    if (roomRef.current) {
      console.log('[MarshallCam] connect: already connected, skipping')
      return
    }
    console.log('[MarshallCam] connect: starting...')
    intentionalDisconnectRef.current = false
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    setCallState({ status: 'connecting' })
    setCamStatus('connecting')

    try {
      const { token, url, iceServers } = await fetchLiveKitToken(authToken, identity, { role: 'remote' })
      console.log('[MarshallCam] connect: got token, connecting to', url, 'with', iceServers?.length, 'ICE servers')
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: VideoPresets.h720.resolution,
        },
        publishDefaults: {
          videoCodec: 'vp8',
          simulcast: true,
          videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
        },
      })
      roomRef.current = room
      console.log('[MarshallCam] connect: Room created')

      room.on(RoomEvent.Connected, () => {
        console.log('[MarshallCam] RoomEvent.CONNECTED')
        setCallState({ status: 'connected' })
      })

      room.on(RoomEvent.Reconnecting, () => {
        console.log('[MarshallCam] RoomEvent.RECONNECTING')
        setCallState({ status: 'reconnecting' })
        setCamStatus('reconnecting')
      })

      room.on(RoomEvent.Reconnected, () => {
        setCallState({ status: 'connected' })
        setCamStatus(room.remoteParticipants.size > 0 ? 'live' : 'offline')
      })

      room.on(RoomEvent.Disconnected, () => {
        console.log('[MarshallCam] RoomEvent.DISCONNECTED')
        if (intentionalDisconnectRef.current) {
          console.log('[MarshallCam] Intentional disconnect, skipping auto-reconnect')
          return
        }
        setCallState({ status: 'offline' })
        setCamStatus('offline')
        setRemoteParticipants([])
        setTileCallers(prev => prev.filter(t => t.isLocal))
        document.querySelectorAll('audio').forEach(el => {
          if (el.style.display === 'none') try { el.remove() } catch {}
        })
        document.querySelectorAll('[id^="caller-vid-"]').forEach(el => {
          try { (el as HTMLVideoElement).srcObject = null } catch {}
        })
        if (remoteVideoRef.current) {
          try { remoteVideoRef.current.srcObject = null } catch {}
        }
        roomRef.current = null
        console.log('[MarshallCam] Auto-reconnecting in 3s...')
        reconnectTimeoutRef.current = setTimeout(() => {
          if (!roomRef.current) connect()
        }, 3000)
      })

      room.on(RoomEvent.TrackSubscribed, (_track: Track, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        console.log('[MarshallCam] Remote: track subscribed, kind=', pub.kind, 'source=', pub.source, 'from', participant.identity, 'trackSid=', pub.trackSid)
        const isStation = participant.identity.startsWith('station-')
        if (pub.kind === Track.Kind.Video) {
          if (isStation) {
            setCamStatus('live')
            const vTrack = pub.videoTrack
            if (vTrack && remoteVideoRef.current) {
              console.log('[MarshallCam] Remote: attaching station video to main canvas')
              try { vTrack.attach(remoteVideoRef.current) } catch (e) { console.warn('[MarshallCam] Remote: video attach failed:', e) }
            }
          } else {
            console.log('[MarshallCam] Remote: attaching caller video to tile:', participant.identity)
            setTileCallers(prev => {
              if (prev.some(t => t.id === participant.identity)) return prev
              return [...prev, { id: participant.identity, isLocal: false }]
            })
            const vTrack = pub.videoTrack
            if (vTrack) {
              const elId = `caller-vid-${participant.identity}`
              const tryAttach = () => {
                const el = document.getElementById(elId) as HTMLVideoElement | null
                if (el) {
                  try { vTrack.attach(el) } catch (e) { console.warn('[MarshallCam] caller video attach failed:', e) }
                } else {
                  setTimeout(tryAttach, 200)
                }
              }
              tryAttach()
            }
          }
        }
        if (pub.kind === Track.Kind.Audio) {
          console.log('[MarshallCam] Remote: audio track subscribed from', participant.identity, 'muted=', pub.isMuted, 'trackSid=', pub.trackSid)
          if (pub.track) attachAudioTrack(pub.track, `Remote/${participant.identity}`)
        }
        const rp = roomRef.current
        if (rp) {
          setRemoteParticipants(Array.from(rp.remoteParticipants.values()).map(p => ({
            identity: p.identity,
            hasVideo: p.getTrackPublications().some(t => t.kind === Track.Kind.Video && t.isSubscribed),
            hasAudio: p.getTrackPublications().some(t => t.kind === Track.Kind.Audio && t.isSubscribed),
          })))
        }
      })

      room.on(RoomEvent.TrackUnsubscribed, (_track: Track, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        console.log('[MarshallCam] Remote: track unsubscribed, kind=', pub.kind, 'from', participant?.identity ?? 'unknown', 'trackSid=', pub.trackSid)
        const isStation = participant?.identity?.startsWith('station-')
        if (pub.kind === Track.Kind.Video && pub.videoTrack) {
          if (isStation && remoteVideoRef.current) {
            try { pub.videoTrack.detach(remoteVideoRef.current) } catch {}
          } else if (participant?.identity) {
            const elId = `caller-vid-${participant.identity}`
            const el = document.getElementById(elId) as HTMLVideoElement | null
            if (el) {
              try { pub.videoTrack.detach(el) } catch {}
              try { el.srcObject = null } catch {}
            }
          }
        }
        if (pub.kind === Track.Kind.Audio && _track) {
          try { _track.detach().forEach(el => el.remove()) } catch {}
        }
        const r = roomRef.current
        const hasVideo = r && Array.from(r.remoteParticipants.values())
          .some(p => p.getTrackPublications().some(tp => tp.kind === Track.Kind.Video && tp.isSubscribed))
        if (!hasVideo) setCamStatus('offline')
        if (r) {
          setRemoteParticipants(Array.from(r.remoteParticipants.values()).map(p => ({
            identity: p.identity,
            hasVideo: p.getTrackPublications().some(t => t.kind === Track.Kind.Video && t.isSubscribed),
            hasAudio: p.getTrackPublications().some(t => t.kind === Track.Kind.Audio && t.isSubscribed),
          })))
        }
      })

      room.on(RoomEvent.TrackMuted, (pub, participant) => {
        console.log('[MarshallCam] Remote: track muted, kind=', pub.kind, 'from', participant.identity)
      })

      room.on(RoomEvent.TrackUnmuted, (pub, participant) => {
        console.log('[MarshallCam] Remote: track unmuted, kind=', pub.kind, 'from', participant.identity)
      })

      room.on(RoomEvent.ConnectionQualityChanged, (quality) => {
        console.log('[MarshallCam] Remote: connection quality:', quality)
      })

      room.on(RoomEvent.DataReceived, (payload) => {
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload))
          if (msg.type === 'squeak') {
            console.log('[MarshallCam] Remote: received squeak from station')
            playSqueakyToy()
          }
        } catch {}
      })

      room.on(RoomEvent.ParticipantConnected, (p) => {
        console.log('[MarshallCam] Remote: participant connected:', p.identity)
        if (p.identity.startsWith('station-')) {
          setCamStatus('live')
        } else {
          setTileCallers(prev => {
            if (prev.some(t => t.id === p.identity)) return prev
            return [...prev, { id: p.identity, isLocal: false }]
          })
        }
        const rp = roomRef.current
        if (rp) {
          setRemoteParticipants(Array.from(rp.remoteParticipants.values()).map(pp => ({
            identity: pp.identity,
            hasVideo: pp.getTrackPublications().some(t => t.kind === Track.Kind.Video && t.isSubscribed),
            hasAudio: pp.getTrackPublications().some(t => t.kind === Track.Kind.Audio && t.isSubscribed),
          })))
        }
      })

      room.on(RoomEvent.ParticipantDisconnected, (p) => {
        console.log('[MarshallCam] Remote: participant disconnected:', p.identity)
        if (p.identity.startsWith('station-')) {
          if (remoteVideoRef.current) {
            try { remoteVideoRef.current.srcObject = null } catch {}
          }
          p.getTrackPublications().forEach(pub => {
            if (pub.videoTrack && remoteVideoRef.current) {
              try { pub.videoTrack.detach(remoteVideoRef.current) } catch {}
            }
          })
          const r = roomRef.current
          if (!r || r.remoteParticipants.size === 0) {
            setCamStatus('offline')
          }
        } else {
          setTileCallers(prev => prev.filter(t => t.id !== p.identity))
          const elId = `caller-vid-${p.identity}`
          const el = document.getElementById(elId) as HTMLVideoElement | null
          if (el) {
            p.getTrackPublications().forEach(pub => {
              if (pub.videoTrack) { try { pub.videoTrack.detach(el) } catch {} }
            })
            try { el.srcObject = null } catch {}
          }
        }
        const r = roomRef.current
        if (r) {
          setRemoteParticipants(Array.from(r.remoteParticipants.values()).map(pp => ({
            identity: pp.identity,
            hasVideo: pp.getTrackPublications().some(t => t.kind === Track.Kind.Video && t.isSubscribed),
            hasAudio: pp.getTrackPublications().some(t => t.kind === Track.Kind.Audio && t.isSubscribed),
          })))
        }
      })

      await room.connect(url, token, { rtcConfig: { iceServers: iceServers || [] } })
      console.log('[MarshallCam] Room connected, identity:', room.localParticipant.identity)

      if (publishMedia) {
        try {
          console.log('[MarshallCam] Remote: enabling camera and microphone...')
          await publishCachedMedia(room)
          const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera)
          const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone)
          console.log('[MarshallCam] Remote: camera published=', !!camPub?.track, 'mic published=', !!micPub?.track)
          if (camPub?.track) {
            setCamPerm('granted')
            setControls(prev => ({ ...prev, camOn: true }))
            setTileCallers(prev => {
              if (prev.some(t => t.id === 'self')) return prev
              return [...prev, { id: 'self', isLocal: true }]
            })
            const tryAttachSelf = () => {
              const el = document.getElementById('caller-vid-self') as HTMLVideoElement | null
              if (el) {
                try { (camPub.track as any).attach(el) } catch (e) { console.warn('[MarshallCam] cam tile attach failed:', e) }
              } else {
                setTimeout(tryAttachSelf, 200)
              }
            }
            tryAttachSelf()
          }
          if (micPub?.track) {
            setMicPerm('granted')
            setControls(prev => ({ ...prev, micOn: true }))
          }
        } catch (e: any) {
          console.error('[MarshallCam] enableCameraAndMicrophone error:', e.name, e.message)
          if (e.name === 'NotAllowedError') {
            setMicPerm('denied')
            setCamPerm('denied')
            setCallState({ status: 'error', message: 'Permission denied. Go to Settings \u2192 Safari \u2192 Microphone & Camera.' })
          }
        }
      }
    } catch (e: any) {
      console.error('[MarshallCam] connect FAILED:', e.message, e.stack)
      const msg = e.message?.includes('could not establish') ? 'Could not connect to camera. Check your network and try again.' : (e.message || 'Cannot connect')
      setCallState({ status: 'error', message: msg })
      setCamStatus('offline')
      roomRef.current = null
    }
  }, [authToken, identity, publishMedia])

  const toggleMic = useCallback(async () => {
    const room = roomRef.current
    if (!room) return
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)
    if (mic?.track) {
      if (controls.micOn) {
        await room.localParticipant.setMicrophoneEnabled(false)
        setControls(prev => ({ ...prev, micOn: false }))
      } else {
        await room.localParticipant.setMicrophoneEnabled(true)
        setMicPerm('granted')
        setControls(prev => ({ ...prev, micOn: true }))
      }
    } else {
      try {
        await room.localParticipant.setMicrophoneEnabled(true)
        setMicPerm('granted')
        setControls(prev => ({ ...prev, micOn: true }))
      } catch { setMicPerm('denied') }
    }
  }, [controls.micOn])

  const toggleCam = useCallback(async () => {
    const room = roomRef.current
    if (!room) return
    if (controls.camOn) {
      await room.localParticipant.setCameraEnabled(false)
      setControls(prev => ({ ...prev, camOn: false }))
      setTileCallers(prev => prev.filter(t => t.id !== 'self'))
      const el = document.getElementById('caller-vid-self') as HTMLVideoElement | null
      if (el) { try { el.srcObject = null } catch {} }
    } else {
      try {
        await room.localParticipant.setCameraEnabled(true)
        const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera)
        if (camPub?.track) {
          const tryAttachSelf = () => {
            const el = document.getElementById('caller-vid-self') as HTMLVideoElement | null
            if (el) {
              try { (camPub.track as any).attach(el) } catch {}
            } else {
              setTimeout(tryAttachSelf, 200)
            }
          }
          tryAttachSelf()
        }
        setCamPerm('granted')
        setControls(prev => ({ ...prev, camOn: true }))
        setTileCallers(prev => {
          if (prev.some(t => t.id === 'self')) return prev
          return [...prev, { id: 'self', isLocal: true }]
        })
      } catch { setCamPerm('denied') }
    }
  }, [controls.camOn])

  const flipCamera = useCallback(async () => {
    const room = roomRef.current
    if (!room) return
    const next: 'user' | 'environment' = controls.facingMode === 'user' ? 'environment' : 'user'
    try {
      await room.localParticipant.setCameraEnabled(true, { facingMode: next })
      setControls(prev => ({ ...prev, facingMode: next }))
    } catch {}
  }, [controls.facingMode])

  const sendSqueak = useCallback(() => {
    const room = roomRef.current
    if (room) {
      playSqueakyToy()
      room.localParticipant.publishData(SQUEAK_DATA, { reliable: true } as DataPublishOptions).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (autoConnect) {
      connect()
      return () => {
        intentionalDisconnectRef.current = true
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current)
        cleanup()
      }
    }
  }, [autoConnect, connect, cleanup])

  return {
    camStatus, callState, controls, micPerm, camPerm,
    remoteVideoRef,
    toggleMic, toggleCam, flipCamera, connect, cleanup, sendSqueak,
    remoteParticipants, tileCallers,
  }
}

function PinLogin({ onAuth, tagline }: { onAuth: (token: string) => void; tagline: string }) {
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [shake, setShake] = useState(false)

  const submitPin = useCallback(async (code: string) => {
    if (code.length < 4 || loading) return
    setLoading(true)
    setErr('')
    console.log('[MarshallCam] Login: submitting PIN...')
    try {
      const r = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: code }),
      })
      const data = await r.json()
      console.log('[MarshallCam] Login: response ok=', data.ok, 'token_len=', (data.token || '').length)
      if (data.ok && data.token) {
        onAuth(data.token)
      } else {
        setPin('')
        setShake(true)
        setTimeout(() => setShake(false), 500)
        setErr('Wrong code')
      }
    } catch (e: any) {
      console.error('[MarshallCam] Login error:', e)
      setPin('')
      setErr('Cannot reach server')
    }
    setLoading(false)
  }, [loading, onAuth])

  useEffect(() => {
    if (pin.length === 4 && !loading) submitPin(pin)
  }, [pin.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const addDigit = (d: string) => {
    if (pin.length >= 4 || loading) return
    setPin(pin + d)
    setErr('')
  }

  const deleteDigit = () => { setPin(pin.slice(0, -1)); setErr('') }

  const dots = useMemo(() =>
    Array.from({ length: 4 }, (_, i) => (
      <div key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
    )), [pin.length])

  const keys = [['1','2','3'],['4','5','6'],['7','8','9'],['','0','\u232b']]

  return (
    <div className="pin-screen">
      <div className="pin-glow" />
      <div className={`pin-card ${shake ? 'shake' : ''}`}>
        <div className="pin-header">
          <div className="pin-icon">
            <PawPrint className="w-7 h-7 text-[var(--accent)]" />
          </div>
          <h1 className="pin-title">
            Marshall<span className="text-[var(--accent)]">Cam</span>
          </h1>
          <p className="pin-subtitle">Enter code to connect</p>
        </div>

        <div className="pin-dots">{dots}</div>

        {err && <p className="pin-error">{err}</p>}

        <div className="pin-keypad">
          {keys.flat().map((k, i) => {
            if (k === '\u232b') return (
              <button key={i} onClick={deleteDigit} className="key backspace" aria-label="Delete">
                <RotateCcw className="w-5 h-5" />
              </button>
            )
            if (k === '') return <div key={i} className="key-spacer" />
            return (
              <button key={i} onClick={() => addDigit(k)} disabled={loading} className="key digit">
                {k}
              </button>
            )
          })}
        </div>

        <p className="pin-footer">{tagline.toUpperCase()}</p>
      </div>
    </div>
  )
}

function CallStatusOverlay({ state }: { state: CallState }) {
  if (state.status === 'connected') return null

  return (
    <div className="call-overlay">
      <div className="call-overlay-content">
        {state.status === 'connecting' && <Loader2 className="w-10 h-10 text-[var(--accent)] animate-spin" />}
        {state.status === 'reconnecting' && <Loader2 className="w-10 h-10 text-[var(--warning)] animate-spin" />}
        {state.status === 'offline' && <WifiOff className="w-10 h-10 text-[var(--danger)]" />}
        {state.status === 'error' && <AlertTriangle className="w-10 h-10 text-[var(--danger)]" />}
        {state.status === 'idle' && <Phone className="w-10 h-10 text-[var(--text-dim)]" />}
        <p className="call-overlay-text">
          {state.status === 'connecting' && 'Connecting...'}
          {state.status === 'reconnecting' && 'Reconnecting...'}
          {state.status === 'offline' && 'Camera Offline'}
          {state.status === 'idle' && 'Ready'}
          {state.status === 'error' && (state as { status: 'error'; message: string }).message}
        </p>
        {state.status === 'offline' && (
          <p className="call-overlay-sub">Stream will resume when camera reconnects</p>
        )}
      </div>
    </div>
  )
}

function RemoteCallView({ token }: { token: string }) {
  const identity = useMemo(() => `family-${Math.random().toString(36).slice(2,10)}`, [])
  const {
    camStatus, callState, controls, micPerm, camPerm,
    remoteVideoRef,
    toggleMic, toggleCam, flipCamera, connect, cleanup, sendSqueak,
    remoteParticipants, tileCallers,
  } = useLiveKitRoom(token, identity, true, false)

  const inCall = callState.status === 'connected' || callState.status === 'connecting' || callState.status === 'reconnecting' || callState.status === 'offline'

  const handleLeave = useCallback(() => {
    cleanup()
  }, [cleanup])

  useEffect(() => {
    const ms = (navigator as any).mediaSession
    if (!ms) return
    try {
      if (typeof MediaMetadata !== 'undefined') {
        ms.metadata = new MediaMetadata({ title: 'MarshallCam Call', artist: 'MarshallCam' })
      }
    } catch {}
    const handlers: Record<string, () => void> = {
      togglemicrophone: toggleMic,
      togglecamera: toggleCam,
      stop: handleLeave,
    }
    for (const [action, handler] of Object.entries(handlers)) {
      try { ms.setActionHandler(action, handler) } catch {}
    }
    return () => {
      for (const action of Object.keys(handlers)) {
        try { ms.setActionHandler(action, null) } catch {}
      }
    }
  }, [toggleMic, toggleCam, handleLeave])

  const liveIndicator = (
    <div className="live-indicator">
      <span className="live-dot-sm" />
      <span className="live-text">LIVE</span>
    </div>
  )

  const remoteCount = remoteParticipants.length
  const callLabel = remoteCount > 1 ? `${remoteCount} CALLERS` : remoteCount === 1 ? 'LIVE' : null

  if (!inCall) {
    return (
      <div className="call-view" style={{ background: 'linear-gradient(180deg, #0f0f1e 0%, #0a0a14 100%)', justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <div className="pin-icon" style={{ margin: '0 auto 1.5rem' }}>
            <PawPrint className="w-8 h-8 text-[var(--accent)]" />
          </div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 300, color: '#e8e8ef', letterSpacing: '0.02em' }}>
            Marshall<span style={{ color: 'var(--accent)' }}>Cam</span>
          </h1>
          <p style={{ fontSize: '0.875rem', color: '#a0a0b0', marginTop: '0.5rem', marginBottom: '2rem' }}>
            Call the dogs
          </p>
          {callState.status === 'error' && (
            <p style={{ color: '#ef4444', fontSize: '0.875rem', marginBottom: '1rem' }}>
              {(callState as { status: 'error'; message: string }).message}
            </p>
          )}
          <button
            onClick={connect}
            style={{
              width: '72px',
              height: '72px',
              borderRadius: '50%',
              border: 'none',
              background: '#22c55e',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto',
              boxShadow: '0 0 30px rgba(0, 230, 118, 0.3)',
              transition: 'transform 0.15s ease',
            }}
            aria-label="Call dogs"
          >
            <Phone className="w-8 h-8" />
          </button>
          <p style={{ fontSize: '0.75rem', color: '#707080', marginTop: '1rem', letterSpacing: '0.08em' }}>
            TAP TO CALL
          </p>
        </div>
      </div>
    )
  }

  const camOverlay = camStatus !== 'live' ? (
    <CallStatusOverlay state={
      camStatus === 'connecting' ? { status: 'connecting' } :
      camStatus === 'reconnecting' ? { status: 'reconnecting' } :
      { status: 'offline' }
    } />
  ) : null

  return (
    <div className="call-view">
      <div className="main-video-area">
        <video ref={remoteVideoRef} autoPlay playsInline className="main-canvas" />
        {camOverlay}
        {camStatus === 'live' && liveIndicator}
        {camStatus === 'reconnecting' && (
          <div className="reconnect-badge">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Reconnecting</span>
          </div>
        )}
        {inCall && callLabel && (
          <div className="call-participants-badge">
            {callLabel}
          </div>
        )}
      </div>

      {tileCallers.length > 0 && (
        <div className="corner-tiles-container">
          {tileCallers.map(caller => (
            <div key={caller.id} className="corner-tile">
              <video id={`caller-vid-${caller.id}`} autoPlay muted={caller.isLocal} playsInline className="corner-tile-video" />
              <div className="corner-tile-label">{caller.isLocal ? 'YOU' : caller.id.replace('family-', '')}</div>
            </div>
          ))}
        </div>
      )}

      {(micPerm === 'denied' || camPerm === 'denied') && (
        <div className="perm-overlay">
          <div className="perm-card glass">
            <AlertTriangle className="w-8 h-8 text-[var(--danger)] mx-auto mb-3" />
            <p style={{ color: 'var(--danger)', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
              {micPerm === 'denied' && camPerm === 'denied' ? 'Microphone & Camera' :
               micPerm === 'denied' ? 'Microphone' : 'Camera'} access denied
            </p>
            <p style={{ color: 'var(--text-dim)', fontSize: '0.75rem', marginBottom: '0.75rem' }}>
              Go to Settings → Safari → Microphone & Camera to allow access.
            </p>
            <button onClick={() => location.reload()} className="perm-retry-btn">
              Retry
            </button>
          </div>
        </div>
      )}

      <div className="control-bar safe-area-pb">
        <div className="control-bar-inner">
          <button onClick={toggleMic}
            className={`ctrl-btn ${controls.micOn ? 'ctrl-active' : ''}`}
            aria-label={controls.micOn ? 'Mute microphone' : 'Unmute microphone'}
          >
            {controls.micOn ? <Mic className="ctrl-icon" /> : <MicOff className="ctrl-icon" />}
            <span className="ctrl-label">{controls.micOn ? 'Mic On' : 'Mic Off'}</span>
          </button>

          <button onClick={toggleCam}
            className={`ctrl-btn ${controls.camOn ? 'ctrl-active' : ''}`}
            aria-label={controls.camOn ? 'Turn camera off' : 'Turn camera on'}
          >
            {controls.camOn ? <Video className="ctrl-icon" /> : <VideoOff className="ctrl-icon" />}
            <span className="ctrl-label">{controls.camOn ? 'Cam On' : 'Cam Off'}</span>
          </button>

          <button onClick={flipCamera} className="ctrl-btn" aria-label="Flip camera">
            <SwitchCamera className="ctrl-icon" />
            <span className="ctrl-label">Flip</span>
          </button>

          <button onClick={sendSqueak} className="ctrl-btn" aria-label="Squeaky toy">
            <Volume2 className="ctrl-icon" />
            <span className="ctrl-label">Squeak</span>
          </button>

          <button onClick={handleLeave} className="ctrl-btn ctrl-end" aria-label="End call">
            <PhoneOff className="ctrl-icon" />
            <span className="ctrl-label">End</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function StationView({ token, onToken, appName }: { token: string; onToken: (token: string) => void; appName: string }) {
  const [familyIdentities, setFamilyIdentities] = useState<string[]>([])
  const [lkStatus, setLkStatus] = useState<'waiting' | 'connecting' | 'connected' | 'error'>('waiting')
  const [time, setTime] = useState(new Date())
  const roomRef = useRef<Room | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const identity = useMemo(() => `station-${Math.random().toString(36).slice(2,10)}`, [])

  const tryFullscreen = useCallback(() => {
    const el = document.documentElement as any
    const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen
    if (rfs) { try { rfs.call(el) } catch {} }
  }, [])

  useEffect(() => { const i = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(i) }, [])

  useEffect(() => {
    let mounted = true
    const connect = async () => {
      try {
        console.log('[MarshallCam] Station: fetching LiveKit token...')
        setLkStatus('connecting')
        const { token: lkToken, url, iceServers } = await fetchLiveKitToken(token, identity, { role: 'station', onToken })
        console.log('[MarshallCam] Station: connecting to', url, 'with', iceServers?.length, 'ICE servers')
        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          videoCaptureDefaults: {
            resolution: VideoPresets.h1080.resolution,
          },
          publishDefaults: {
            videoCodec: 'vp8',
            simulcast: true,
            videoSimulcastLayers: [VideoPresets.h360, VideoPresets.h720, VideoPresets.h1080],
          },
        })
        if (!mounted) return
        roomRef.current = room

        room.on(RoomEvent.Connected, () => {
          console.log('[MarshallCam] Station: CONNECTED to LiveKit room')
          setLkStatus('connected')
        })

        room.on(RoomEvent.Reconnecting, () => {
          console.log('[MarshallCam] Station: RECONNECTING...')
          setLkStatus('error')
        })

        room.on(RoomEvent.Reconnected, () => {
          console.log('[MarshallCam] Station: RECONNECTED')
          setLkStatus('connected')
        })

        room.on(RoomEvent.Disconnected, () => {
          console.log('[MarshallCam] Station: DISCONNECTED — will auto-reconnect')
          setLkStatus('error')
          setFamilyIdentities([])
          document.querySelectorAll('audio').forEach(el => {
            if (el.style.display === 'none') try { el.remove() } catch {}
          })
          document.querySelectorAll('[id^="station-vid-"]').forEach(el => {
            try { (el as HTMLVideoElement).srcObject = null } catch {}
          })
          roomRef.current = null
          if (mounted) reconnectRef.current = setTimeout(connect, 3000)
        })

        room.on(RoomEvent.ConnectionQualityChanged, (quality) => {
          console.log('[MarshallCam] Station: connection quality:', quality)
        })

        room.on(RoomEvent.DataReceived, (payload) => {
          try {
            const msg = JSON.parse(new TextDecoder().decode(payload))
            if (msg.type === 'squeak') {
              console.log('[MarshallCam] Station: received squeak from family')
              playSqueakyToy()
            }
          } catch {}
        })

        room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
          console.log('[MarshallCam] Station: participant connected:', participant.identity)
          setFamilyIdentities(prev => [...prev.filter(id => id !== participant.identity), participant.identity])
          tryFullscreen()
        })

        room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
          console.log('[MarshallCam] Station: participant disconnected:', participant.identity)
          const elId = `station-vid-${participant.identity}`
          const vidEl = document.getElementById(elId) as HTMLVideoElement | null
          if (vidEl) {
            try { vidEl.srcObject = null } catch {}
            participant.getTrackPublications().forEach(pub => {
              if (pub.videoTrack) try { pub.videoTrack.detach(vidEl) } catch {}
            })
          }
          const r = roomRef.current
          if (!r || r.remoteParticipants.size === 0) {
            setFamilyIdentities([])
          } else {
            setFamilyIdentities(prev => prev.filter(id => id !== participant.identity))
          }
        })

        room.on(RoomEvent.TrackSubscribed, (_track: Track, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
          console.log('[MarshallCam] Station: track subscribed, kind=', pub.kind, 'from', participant.identity, 'trackSid=', pub.trackSid)
          if (pub.kind === Track.Kind.Video && pub.videoTrack) {
            const vt = pub.videoTrack
            setFamilyIdentities(prev => [...prev.filter(id => id !== participant.identity), participant.identity])
            const elId = `station-vid-${participant.identity}`
            const tryAttach = () => {
              const el = document.getElementById(elId) as HTMLVideoElement | null
              if (el) {
                console.log('[MarshallCam] Station: attaching video for', participant.identity, 'to element', elId)
                try { vt.attach(el) } catch (e) { console.warn('[MarshallCam] Station: video attach error:', e) }
              } else {
                console.warn('[MarshallCam] Station: video element', elId, 'not in DOM yet, retrying in 200ms')
                setTimeout(tryAttach, 200)
              }
            }
            tryAttach()
          }
          if (pub.kind === Track.Kind.Audio) {
            console.log('[MarshallCam] Station: audio track subscribed from', participant.identity, 'muted=', pub.isMuted, 'trackSid=', pub.trackSid)
            if (pub.track) attachAudioTrack(pub.track, `Station/${participant.identity}`)
          }
        })

        room.on(RoomEvent.TrackUnsubscribed, (track: Track, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
          console.log('[MarshallCam] Station: track unsubscribed, kind=', pub.kind, 'from', participant.identity, 'trackSid=', pub.trackSid)
          if (pub.kind === Track.Kind.Video && pub.videoTrack) {
            const elId = `station-vid-${participant.identity}`
            const el = document.getElementById(elId) as HTMLVideoElement | null
            if (el) {
              try { pub.videoTrack.detach(el) } catch {}
              try { el.srcObject = null } catch {}
            }
          }
          if (pub.kind === Track.Kind.Audio && track) {
            try { track.detach().forEach(el => el.remove()) } catch {}
          }
        })

        room.on(RoomEvent.TrackMuted, (pub, participant) => {
          console.log('[MarshallCam] Station: track muted, kind=', pub.kind, 'from', participant.identity)
        })

        room.on(RoomEvent.TrackUnmuted, (pub, participant) => {
          console.log('[MarshallCam] Station: track unmuted, kind=', pub.kind, 'from', participant.identity)
        })

        await room.connect(url, lkToken, { rtcConfig: { iceServers: iceServers || [] } })
        console.log('[MarshallCam] Station: room.connect() resolved, identity=', room.localParticipant.identity)

        try {
          console.log('[MarshallCam] Station: enabling camera and microphone...')
          await publishCachedMedia(room, { width: { ideal: 1920 }, height: { ideal: 1080 } })
          const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera)
          const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone)
          console.log('[MarshallCam] Station: camera published=', !!camPub?.track, 'mic published=', !!micPub?.track)
        } catch (e: any) {
          console.error('[MarshallCam] Station: camera/mic failed:', e.name, e.message)
        }
      } catch (e: any) {
        console.error('[MarshallCam] Station: connection error:', e.message, e.stack)
        setLkStatus('error')
        setFamilyIdentities([])
        document.querySelectorAll('audio').forEach(el => {
          if (el.style.display === 'none') try { el.remove() } catch {}
        })
        if (mounted) reconnectRef.current = setTimeout(connect, 5000)
      }
    }
    connect()
    return () => {
      mounted = false
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      roomRef.current?.disconnect()
      roomRef.current = null
    }
  }, [token, identity, tryFullscreen, onToken])

  useEffect(() => {
    if (lkStatus !== 'connected') return
    const beat = () => {
      void fetch('/station/heartbeat', { method: 'POST', credentials: 'include' }).catch(() => {})
    }
    beat()
    const id = setInterval(beat, 15_000)
    return () => clearInterval(id)
  }, [lkStatus])

  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null
    const requestWake = async () => {
      try { if (navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen') } } catch {}
    }
    requestWake()
    const onVis = () => { if (!document.hidden) { requestWake(); tryFullscreen() } }
    document.addEventListener('visibilitychange', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis); wakeLock?.release() }
  }, [tryFullscreen])

  useEffect(() => {
    const resumeAndFullscreen = () => {
      try {
        document.querySelectorAll('audio').forEach(el => {
          if (el.paused) { el.play().catch(() => {}) }
        })
      } catch {}
      tryFullscreen()
    }
    document.addEventListener('click', resumeAndFullscreen)
    document.addEventListener('touchstart', resumeAndFullscreen)
    resumeAndFullscreen()
    const interval = setInterval(() => tryFullscreen(), 30000)
    return () => { document.removeEventListener('click', resumeAndFullscreen); document.removeEventListener('touchstart', resumeAndFullscreen); clearInterval(interval) }
  }, [tryFullscreen])

  const h = time.getHours() % 12 || 12
  const m = String(time.getMinutes()).padStart(2, '0')
  const s = String(time.getSeconds()).padStart(2, '0')
  const ap = time.getHours() >= 12 ? 'PM' : 'AM'
  const dateStr = time.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  const familyCount = familyIdentities.length
  const isGrid = familyCount > 1

  return (
    <div className="station-view" style={{ cursor: 'none' }}>
      <div className="station-standby" onClick={tryFullscreen}>
        <div className="station-clock">{h}:{m}<span style={{ fontSize: '0.45em', opacity: 0.4 }}>:{s}</span></div>
        <div className="station-clock-secs">{ap}</div>
        <div className="station-date">{dateStr}</div>
        <div className={`station-status-badge${lkStatus === 'connected' ? ' connected' : ''}`}>
          <span className="live-dot-sm" />
          {lkStatus === 'waiting' && 'WAITING'}
          {lkStatus === 'connecting' && 'CONNECTING...'}
          {lkStatus === 'connected' && 'AWAITING CALL'}
          {lkStatus === 'error' && 'RECONNECTING...'}
        </div>
        <div className="station-paw">{appName.toUpperCase()}</div>
        <div className="station-clock-glow" />
      </div>

      {familyCount > 0 && (
        <div
          ref={videoContainerRef}
          className={`station-video-grid${isGrid ? ' grid-' + Math.min(familyCount, 4) : ' single'}`}
        >
          {familyIdentities.map((id) => (
            <div key={id} className="station-video-tile">
              <video
                id={`station-vid-${id}`}
                autoPlay
                playsInline
                className="station-vid-el"
              />
            </div>
          ))}
        </div>
      )}

      {familyCount > 0 && (
        <div className="station-badge">
          <span className="live-dot-sm" />
          <span>{familyCount === 1 ? 'FAMILY CALL' : `${familyCount} CALLERS`}</span>
        </div>
      )}
    </div>
  )
}

export default function AppWrapper() {
  return <ErrorBoundary><App /></ErrorBoundary>
}

function App() {
  const [authed, setAuthed] = useState(false)
  const [token, setToken] = useState('')
  const [checking, setChecking] = useState(true)
  const [tagline, setTagline] = useState(DEFAULT_TAGLINE)
  const [appName, setAppName] = useState(DEFAULT_APP_NAME)
  const role = useMemo(() => detectRole(), [])

  useEffect(() => {
    void fetch('/app').then(async (r) => {
      if (!r.ok) return
      const data = await r.json() as { name?: string; tagline?: string }
      if (data.name) setAppName(data.name)
      if (data.tagline) setTagline(data.tagline)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    const urlParams = new URLSearchParams(location.search)
    const urlToken = urlParams.get('token')
    if (urlToken) {
      localStorageTokenStore.set(urlToken)
      setToken(urlToken)
      setAuthed(true)
      setChecking(false)
      return
    }

    void bootstrapAuth({
      role,
      storedToken: localStorageTokenStore.get(),
      fetch,
      store: localStorageTokenStore,
      onStatus: (status) => {
        if (cancelled) return
        if (status === 'connecting') setChecking(true)
      },
    }).then((result) => {
      if (cancelled) return
      if (result.status === 'authed') {
        setToken(result.token)
        setAuthed(true)
      } else {
        setAuthed(false)
      }
      setChecking(false)
    }).catch(() => {
      if (cancelled) return
      setAuthed(false)
      setChecking(false)
    })

    return () => { cancelled = true }
  }, [role])

  const handleAuth = useCallback((t: string) => {
    setToken(t)
    localStorageTokenStore.set(t)
    setAuthed(true)
  }, [])

  if (checking) {
    return (
      <div className="pin-screen">
        <Loader2 className="w-8 h-8 text-[var(--accent)] animate-spin" />
        <p className="pin-footer" style={{ marginTop: '1.5rem' }}>Connecting to server…</p>
      </div>
    )
  }

  if (authed) {
    return role === 'station'
      ? <StationView token={token} onToken={handleAuth} appName={appName} />
      : <RemoteCallView token={token} />
  }

  return <PinLogin onAuth={handleAuth} tagline={tagline} />
}