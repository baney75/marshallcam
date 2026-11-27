import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Send, Power, Volume2, VolumeX, Monitor, Tv,
  Terminal, Loader2, LogOut,
  Activity, Eye, EyeOff, Shield, Cpu, Clock,
  Server, Circle, ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import './index.css'

type Tab = 'terminal' | 'systems' | 'tv'

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

interface SystemStatus {
  intercom: { status: string; viewers: number; familyClients: number; kioskClients: number; ffmpeg: boolean }
  tv: { reachable: boolean; powerMode?: string; model?: string; softwareVersion?: string }
  uptime: number
  timestamp: string
}

function PasswordLogin({ onAuth }: { onAuth: (token: string) => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [shake, setShake] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pw || loading) return
    setLoading(true)
    setErr('')
    try {
      const r = await fetch('/max/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }), credentials: 'include' as RequestCredentials })
      const data = await r.json()
      if (data.ok && data.token) onAuth(data.token)
      else { setPw(''); setShake(true); setTimeout(() => setShake(false), 500); setErr('Access denied'); inputRef.current?.focus() }
    } catch { setPw(''); setErr('Cannot reach server') }
    setLoading(false)
  }, [pw, loading, onAuth])

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <Card className={cn("w-full max-w-[380px]", shake && "animate-[shake_0.5s_ease-in-out]")}>
        <CardHeader className="text-center">
          <Shield className="mx-auto mb-2 text-primary" size={28} />
          <CardTitle className="text-xl font-light tracking-tight">MarshallCam Admin</CardTitle>
          <CardDescription>System Control Surface</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="relative">
              <Input
                ref={inputRef}
                type={showPw ? 'text' : 'password'}
                value={pw}
                onChange={e => setPw(e.target.value)}
                placeholder="Password"
                disabled={loading}
                className="pr-10"
              />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {err && <p className="text-sm text-destructive">{err}</p>}
            <Button type="submit" disabled={loading || !pw} className="w-full" variant="outline">
              {loading ? <Loader2 className="animate-spin" size={16} /> : 'Authenticate'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function TerminalView() {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const createSession = useCallback(async () => {
    try {
      const r = await fetch('/max/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include' as RequestCredentials })
      const data = await r.json()
      if (data.id) {
        setSessionId(data.id)
        const es = new EventSource(`/max/api/event?session=${data.id}&token=${encodeURIComponent(document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('max_token='))?.split('=')[1]||'')}`)
        es.onmessage = (e) => {
          try {
            const evt = JSON.parse(e.data)
            if (evt.type === 'message') {
              setMessages(prev => {
                const last = prev[prev.length - 1]
                if (last?.role === 'assistant') return [...prev.slice(0, -1), { ...last, content: last.content + (evt.content ?? '') }]
                return [...prev, { role: 'assistant', content: evt.content ?? '', timestamp: Date.now() }]
              })
            }
            if (evt.type === 'message.done') setLoading(false)
          } catch {}
        }
        eventSourceRef.current = es
        return data.id
      }
    } catch {}
    return null
  }, [])

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return
    const msg = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: msg, timestamp: Date.now() }])
    setLoading(true)
    let sid = sessionId
    if (!sid) sid = await createSession()
    if (!sid) { setLoading(false); return }
    try {
      await fetch(`/max/api/session/${sid}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: msg }] }),
        credentials: 'include' as RequestCredentials,
      })
    } catch { setLoading(false) }
  }, [input, loading, sessionId, createSession])

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
        {messages.length === 0 && (
          <div className="text-center mt-[30%] text-muted-foreground text-sm">
            <Terminal size={32} className="mx-auto mb-2 text-primary/30" />
            <p className="font-medium">Admin Debug Terminal</p>
            <p className="text-xs mt-1">Diagnose services, inspect configs, run commands</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn("chat-msg", m.role === 'user' ? 'chat-msg-user' : 'chat-msg-assistant')}>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.content}</p>
          </div>
        ))}
        {loading && messages[messages.length - 1]?.role !== 'assistant' && <Loader2 className="animate-spin text-primary mx-auto my-2" size={18} />}
        <div ref={bottomRef} />
      </div>
      <div className="p-3 border-t border-border flex gap-2">
        <Input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendMessage()} placeholder="Run command..." className="flex-1 font-mono text-sm" />
        <Button onClick={sendMessage} disabled={!input.trim() || loading} size="icon" variant="outline"><Send size={16} /></Button>
      </div>
    </div>
  )
}

function ServiceBadge({ label, status }: { label: string; status: 'ok' | 'warn' | 'error' | 'off' }) {
  const variants = {
    ok: 'bg-chart-2/15 text-chart-2 border-chart-2/30',
    warn: 'bg-chart-3/15 text-chart-3 border-chart-3/30',
    error: 'bg-destructive/15 text-destructive border-destructive/30',
    off: 'bg-muted text-muted-foreground border-border',
  }
  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-xs font-medium", variants[status])}>
      <Circle size={6} fill="currentColor" />
      {label}
    </span>
  )
}

function SystemsView() {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [err, setErr] = useState('')

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/max/status', { credentials: 'include' as RequestCredentials })
      if (!r.ok) throw new Error('Unauthorized')
      setStatus(await r.json())
      setErr('')
    } catch { setErr('Cannot fetch status') }
  }, [])

  useEffect(() => { fetchStatus(); const i = setInterval(fetchStatus, 10000); return () => clearInterval(i) }, [fetchStatus])

  if (err) return <div className="p-4 text-destructive text-center">{err}</div>
  if (!status) return <div className="p-4 text-center"><Loader2 className="animate-spin text-primary mx-auto" size={24} /></div>

  const uptimeH = Math.floor(status.uptime / 3600)
  const uptimeM = Math.floor((status.uptime % 3600) / 60)
  const intercomOk = status.intercom.status === 'live'
  const tvStatus = status.tv.reachable ? (status.tv.powerMode === 'PowerOn' ? 'ok' : 'warn') : 'error'

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <Activity size={14} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Service Health</span>
        <span className="ml-auto text-[0.65rem] text-muted-foreground">10s refresh</span>
      </div>

      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardDescription className="flex items-center gap-1.5"><Server size={12} /> Intercom Service</CardDescription>
            <ServiceBadge label={status.intercom.status.toUpperCase()} status={intercomOk ? 'ok' : 'off'} />
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>Viewers: {status.intercom.viewers}</span>
            <span>Family: {status.intercom.familyClients}</span>
            <span>Kiosk: {status.intercom.kioskClients}</span>
          </div>
          {status.intercom.ffmpeg && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-chart-2">
              <Circle size={6} fill="currentColor" className="animate-pulse" />
              FFmpeg running
            </div>
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardDescription className="flex items-center gap-1.5"><Monitor size={12} /> ONN Roku TV</CardDescription>
            <ServiceBadge label={status.tv.reachable ? (status.tv.powerMode === 'PowerOn' ? 'ON' : 'STANDBY') : 'OFFLINE'} status={tvStatus as 'ok'} />
          </div>
        </CardHeader>
        {status.tv.reachable && (
          <CardContent>
            <p className="text-xs text-muted-foreground">{status.tv.model} · RokuOS {status.tv.softwareVersion}</p>
          </CardContent>
        )}
      </Card>

      <Separator />

      <div className="grid grid-cols-2 gap-3">
        <Card size="sm">
          <CardContent className="pt-3 flex items-center gap-3">
            <Clock size={18} className="text-muted-foreground" />
            <div>
              <CardDescription>Uptime</CardDescription>
              <p className="text-sm font-medium">{uptimeH}h {uptimeM}m</p>
            </div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="pt-3 flex items-center gap-3">
            <Cpu size={18} className="text-muted-foreground" />
            <div>
              <CardDescription>Server</CardDescription>
              <p className="text-sm font-medium">:3000</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function TvView() {
  const [lastCmd, setLastCmd] = useState('')
  const [err, setErr] = useState('')

  const tvCmd = useCallback(async (path: string) => {
    setErr('')
    setLastCmd(path)
    try {
      const r = await fetch(`/max/tv${path}`, { method: 'POST', credentials: 'include' as RequestCredentials })
      if (!r.ok) setErr('Command failed')
    } catch { setErr('TV unreachable') }
  }, [])

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <Monitor size={14} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Display Control</span>
      </div>

      <Card size="sm">
        <CardContent className="py-3 flex items-center gap-3">
          <Tv size={18} className="text-primary" />
          <div>
            <p className="text-sm font-medium">Roku TV</p>
            <p className="text-xs text-muted-foreground">ECP control</p>
          </div>
          <ChevronRight size={14} className="ml-auto text-muted-foreground" />
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardDescription>Power</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => tvCmd('/power')} variant="destructive" className="w-full" size="sm">
            <Power size={14} /> Power Off
          </Button>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardDescription>HDMI Input</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-2">
            {[1,2,3,4].map(n => (
              <Button key={n} onClick={() => tvCmd(`/input/${n}`)} variant="outline" size="sm" className="font-mono text-xs">HDMI{n}</Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardDescription>Volume</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2">
            <Button onClick={() => tvCmd('/volume/up')} variant="outline" size="sm"><Volume2 size={14} /> Up</Button>
            <Button onClick={() => tvCmd('/volume/mute')} variant="outline" size="sm"><VolumeX size={14} /> Mute</Button>
            <Button onClick={() => tvCmd('/volume/down')} variant="outline" size="sm"><Volume2 size={14} /> Down</Button>
          </div>
        </CardContent>
      </Card>

      {err && <p className="text-xs text-destructive text-center">{err}</p>}
      {lastCmd && !err && <p className="text-[0.65rem] text-muted-foreground text-center font-mono">→ {lastCmd}</p>}
    </div>
  )
}

export default function App() {
  const [, setToken] = useState('')
  const [authed, setAuthed] = useState(false)
  const [tab, setTab] = useState<Tab>('terminal')
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const urlParams = new URLSearchParams(location.search)
    const urlToken = urlParams.get('max_token')
    if (urlToken) {
      setToken(urlToken)
      setAuthed(true)
      setChecking(false)
      document.cookie = `max_token=${urlToken}; Path=/max; SameSite=Strict; Max-Age=86400`
      return
    }
    const cookie = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('max_token='))
    const saved = cookie ? cookie.split('=')[1] : ''
    if (saved) {
      fetch('/max/status', { credentials: 'include' as RequestCredentials }).then(r => {
        if (r.ok) { setToken(saved); setAuthed(true) }
        else { document.cookie = 'max_token=; Path=/max; Max-Age=0' }
      }).catch(() => {}).finally(() => setChecking(false))
    } else {
      setChecking(false)
    }
  }, [])

  const handleAuth = useCallback((t: string) => { setToken(t); setAuthed(true) }, [])

  const handleLogout = useCallback(async () => {
    await fetch('/max/logout', { method: 'POST', credentials: 'include' as RequestCredentials }).catch(() => {})
    document.cookie = 'max_token=; Path=/max; Max-Age=0'
    setToken(''); setAuthed(false)
  }, [])

  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="animate-spin text-primary" size={24} />
      </div>
    )
  }

  if (!authed) return <PasswordLogin onAuth={handleAuth} />

  return (
    <div className="flex flex-col h-[100dvh] bg-background">
      <Tabs value={tab} onValueChange={(v: string) => setTab(v as Tab)} className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-primary" />
            <span className="font-semibold text-sm tracking-tight">Admin</span>
          </div>
          <TabsList variant="line">
            <TabsTrigger value="terminal"><Terminal size={14} /> Terminal</TabsTrigger>
            <TabsTrigger value="systems"><Activity size={14} /> Systems</TabsTrigger>
            <TabsTrigger value="tv"><Monitor size={14} /> Display</TabsTrigger>
          </TabsList>
          <Button onClick={handleLogout} variant="ghost" size="icon-sm"><LogOut size={14} /></Button>
        </div>

        <TabsContent value="terminal" className="flex-1 overflow-hidden"><TerminalView /></TabsContent>
        <TabsContent value="systems" className="flex-1 overflow-y-auto"><SystemsView /></TabsContent>
        <TabsContent value="tv" className="flex-1 overflow-y-auto"><TvView /></TabsContent>
      </Tabs>
    </div>
  )
}